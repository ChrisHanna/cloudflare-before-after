import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDeploymentPlan, digestValue, PLAN_LIFETIME_MS } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities, ApiCapabilityProvider, type Finding } from '../packages/demo-core/src/capabilities.js';
import { applyReviewedPlan, type ApplyEnvironment } from '../packages/demo-core/src/deployment-apply.js';
import { DeploymentStore } from '../packages/demo-core/src/deployment-store.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { CloudflareReader } from '../packages/demo-core/src/cloudflare.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { labConfig } from './fixtures/lab.js';
import { TestClock } from './fixtures/clock.js';

const now = Date.parse('2026-11-04T08:55:00.000Z');
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
async function fixture(profile: 'core' | 'core-waf' | 'workshop' = 'core', gaps: Record<string, Finding['state']> = {}) {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 't39-cap-')); roots.push(root);
  const intent = deploymentIntent(root, now); intent.profile = profile; intent.priorModules = ['core', 'waiting-room', 'bot'];
  const inspect = vi.fn(async (key: string): Promise<Finding> => ({ state: gaps[key] ?? 'available', source: 'offline-provider', reasons: gaps[key] ? [`${key}: ${gaps[key]}`] : [] }));
  const capability = await discoverCapabilities(intent.discovery, profile, { mode: 'fixture', inspect }, undefined, new Date(now).toISOString());
  const plan = createDeploymentPlan(intent, capability, intent.releaseDigest, root, now);
  const store = new DeploymentStore(root, intent.discovery.evidenceDirectory); const saved = store.save(plan);
  const writes: string[] = [];
  // The recorder is a fixture provider, not a second planner or apply engine.
  const createExecutor = vi.fn<ApplyEnvironment['createExecutor']>(async () => ({ mode: 'fixture', async execute(step, context) {
    await context.perform('fixture-owned-write', step.resources[0]!, async () => { writes.push(step.id); });
  }, async close() {} }));
  const clock = new TestClock();
  const environment: ApplyEnvironment = { intent, capability, sourceDigest: intent.releaseDigest, credentials: FIXTURE_CREDENTIALS, createExecutor, clock, now: () => now + clock.now() };
  return { root, intent, capability, plan, store, saved, writes, createExecutor, environment, inspect };
}
function approve(f: Awaited<ReturnType<typeof fixture>>) { f.store.approve(f.saved.planPath, `APPROVE ${f.saved.digest}`, true, now); }

describe('T39 AT-CAP: production discovery -> reviewed plan -> guarded apply', () => {
  it('AT-CAP-1 keeps both real core deployment steps when Enterprise products are missing', async () => {
    const f = await fixture('core', { 'bot-management': 'not-entitled', 'waiting-room': 'not-entitled', 'api-shield': 'unknown', access: 'permission-denied' });
    expect(f.capability.deployable).toBe(true); expect(f.capability.fullCatalogAvailable).toBe(false);
    expect(f.plan.includedModules).toEqual(['core']); expect(f.plan.status).toBe('review-required');
    for (const kind of ['terraform-core', 'images-owned-upload', 'd1-migrations', 'wrangler-before', 'wrangler-after', 'seed-before', 'seed-after']) expect(f.plan.steps.some(s => s.kind === kind)).toBe(true);
    expect(f.plan.steps.every(s => s.module === 'core' && !s.deletes)).toBe(true);
    expect(f.plan.excludedModules.find(m => m.id === 'waiting-room')!.reasons.join()).toContain('not-entitled');
    expect(f.plan.steps.some(s => s.kind === 'product-policy')).toBe(false);
    expect(f.writes).toEqual([]); approve(f);
    expect((await applyReviewedPlan(f.store, f.saved.planPath, f.environment)).status).toBe('succeeded');
    expect(f.writes).toEqual(f.plan.steps.map(s => s.id));
    expect(f.writes.some(id => /waiting-room|bot|delete|destroy/.test(id))).toBe(false);
  });
  it.each(['d1', 'r2', 'images', 'containers', 'deployment-permissions'])('AT-CAP-2 blocks missing mandatory %s before executor construction', async key => {
    const f = await fixture('workshop', { [key]: 'unknown' });
    expect(f.plan.status).toBe('blocked'); expect(f.plan.blockers).toContain(key); expect(f.plan.steps).toEqual([]);
    expect(() => approve(f)).toThrow('Blocked');
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow('prerequisites');
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it.each(['unknown', 'permission-denied', 'not-entitled'] as const)('AT-CAP-2 selected WAF prerequisite %s blocks its apply but permits a new core plan', async state => {
    const f = await fixture('core-waf', { 'custom-waf': state });
    expect(f.plan.blockers).toContain('custom-waf');
    expect(f.capability.findings.find(v => v.product === 'custom-waf')!.state).toBe(state);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).not.toHaveBeenCalled();
    const core = await fixture('core', { 'custom-waf': state });
    expect(core.plan.status).toBe('review-required'); approve(core);
    expect((await applyReviewedPlan(core.store, core.saved.planPath, core.environment)).status).toBe('succeeded');
  });
  it('AT-CAP-2 does not turn an actual denied API response into not-entitled', async () => {
    const config = labConfig(); config.liveOptIn = true;
    const ledger = new BudgetLedger({ limits: { cleanupRequests: 0 } });
    const dispatch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method ?? 'GET').toBe('GET');
      return Response.json({ success: false, result: null, errors: [{ code: 10000, message: 'Denied' }] }, { status: 403 });
    });
    try {
      const client = new GuardedClient(config, ledger, { dispatch, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)) });
      const provider = new ApiCapabilityProvider(config, client, new CloudflareReader(client, FIXTURE_CREDENTIALS.reader), { tooling: { state: 'available', source: 'offline', reasons: [] }, collectorConfigured: true });
      const finding = await provider.inspect('d1');
      expect(finding.state).toBe('permission-denied'); expect(finding.reasons.join()).toContain('entitlement not inferred');
      expect(dispatch).toHaveBeenCalledOnce(); expect(ledger.snapshot.requestsUsed).toBe(1);
    } finally { ledger.stop(); }
  });
  it.each(['age', 'capability', 'scope', 'desired', 'source', 'snapshot-age', 'approval'] as const)('AT-CAP-3 refuses %s changes with zero writes', async fault => {
    const f = await fixture(); if (fault !== 'approval') approve(f);
    if (fault === 'age') f.environment.now = () => now + PLAN_LIFETIME_MS;
    if (fault === 'capability') f.capability.findings.find(v => v.product === 'waiting-room')!.state = 'not-entitled';
    if (fault === 'scope') f.intent.profile = 'workshop';
    if (fault === 'desired') f.intent.discovery.environments[1].origin = 'https://changed.example.test';
    if (fault === 'source') f.environment.sourceDigest = digestValue('changed-source');
    if (fault === 'snapshot-age') f.capability.observedAt = new Date(now - PLAN_LIFETIME_MS - 1).toISOString();
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it('AT-CAP-3 exclusion of formerly owned products cannot cause implicit removal', async () => {
    const f = await fixture(); approve(f);
    expect(f.intent.priorModules).toContain('waiting-room');
    expect(f.plan.excludedModules.map(m => m.id)).toContain('waiting-room');
    expect(f.plan.steps.every(s => s.deletes === false && s.changes === 'create-or-update-owned')).toBe(true);
    await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(f.writes).toEqual(f.plan.steps.map(s => s.id));
    expect(f.writes.some(id => /waiting-room|delete|destroy/.test(id))).toBe(false);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).toHaveBeenCalledOnce();
  });
});
