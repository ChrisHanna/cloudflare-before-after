import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assessCost, createDeploymentPlan, digestValue, IntentSchema, type DeploymentIntent } from '../packages/demo-core/src/deployment-plan.js';
import { DeploymentStore } from '../packages/demo-core/src/deployment-store.js';
import { applyReviewedPlan, type ApplyEnvironment, type SetupContext, type SetupExecutor } from '../packages/demo-core/src/deployment-apply.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { validateDiscoveryConfig } from '../packages/demo-core/src/config.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { labConfig } from './fixtures/lab.js';
import { TestClock } from './fixtures/clock.js';
import { DeploymentToolError, terraformFailure } from '../packages/demo-core/src/deployment-diagnostics.js';
import { runBoundedTool } from '../packages/demo-core/src/deployment-tools.js';
const NOW = Date.parse('2026-11-04T00:00:00.000Z'); const SOURCE = 'a'.repeat(64);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(options: { approve?: boolean; mutateIntent?: (intent: DeploymentIntent) => void; execute?: (context: SetupContext) => Promise<void> } = {}) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'deployment-')); roots.push(root);
  const runtime = labConfig(root);
  const { inventory: _inventory, environments, ...discovery } = runtime;
  const intent = IntentSchema.parse({ schemaVersion: 1, discovery: { ...discovery, liveOptIn: true, credentials: { ...discovery.credentials, deployer: 'env:LAB_DEPLOYER' }, environments: environments.map(({ role, origin }) => ({ role, origin })) }, profile: 'core', releaseDigest: SOURCE, viewRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', costs: { currency: 'USD', month: '2026-11', observedAt: new Date(NOW).toISOString(), pricingAsOf: '2026-11-03', materialUnknowns: [], lines: ['existing-spend', 'remaining-commitments', 'renewals', 'new-subscriptions', 'usage', 'tax', 'reserve'].map(category => ({ category, label: category, thisMonthCents: 500, source: 'fixture-pricing', assumption: 'Complete monthly lab scope, including full renewals due this month' })) }, priorModules: ['core', 'waiting-room'], setup: { maxRuntimeMs: 10000, maxOperations: 100 } });
  options.mutateIntent?.(intent);
  const capability = await discoverCapabilities(intent.discovery, 'core', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, undefined, new Date(NOW).toISOString());
  const plan = createDeploymentPlan(intent, capability, SOURCE, root, NOW);
  const store = new DeploymentStore(root, intent.discovery.evidenceDirectory); const saved = store.save(plan);
  if (options.approve) store.approve(saved.planPath, `APPROVE ${saved.digest}`, true, NOW);
  const operations: string[] = []; const close = vi.fn(async () => {});
  const executor: SetupExecutor = { mode: 'fixture', execute: async (step, ctx) => { if (options.execute) await options.execute(ctx); else await ctx.perform('fixture-write', step.resources[0]!, async () => { operations.push(step.id); }); }, close };
  const createExecutor = vi.fn(async () => executor);
  const clock = new TestClock();
  const environment: ApplyEnvironment = { intent, capability, sourceDigest: SOURCE, credentials: { reader: 'fixture-reader-credential-separate', collector: 'fixture-collector-credential-separate', deployer: 'fixture-deployment-credential-separate' }, createExecutor, now: () => NOW + clock.now(), clock };
  return { root, intent, capability, plan, store, saved, environment, clock, operations, createExecutor, close };
}
describe('deployment-approval', () => {
  it('accepts fresh-checkout discovery without fabricated database IDs but forbids runtime traffic', async () => {
    const f = await fixture(); const config = validateDiscoveryConfig(f.intent.discovery, f.root);
    expect(config).not.toHaveProperty('inventory'); expect(config.environments[0]).not.toHaveProperty('d1Id');
    const ledger = new BudgetLedger({ clock: f.clock });
    expect(() => new GuardedClient(config, ledger, { observedOwnedResources: new Set() })).toThrow('inventory'); ledger.stop();
  });
  it('requires exact interactive approval; a $100 authorization alone creates no executor', async () => {
    const f = await fixture();
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.operations).toEqual([]);
    expect(() => f.store.approve(f.saved.planPath, `APPROVE ${f.saved.digest}`, false, NOW)).toThrow('interactive');
    expect(() => f.store.approve(f.saved.planPath, 'yes', true, NOW)).toThrow('interactive');
    f.store.approve(f.saved.planPath, `APPROVE ${f.saved.digest}`, true, NOW);
    expect((await applyReviewedPlan(f.store, f.saved.planPath, f.environment)).status).toBe('succeeded');
    expect(f.operations).toHaveLength(f.plan.steps.length);
  });
  it('AT-CAP-3 refuses expired plans and fresh-source/capability/desired-scope drift before writes', async () => {
    for (const mutate of [
      (f: Awaited<ReturnType<typeof fixture>>) => { f.environment.now = () => NOW + 900000; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.environment.sourceDigest = 'b'.repeat(64); },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.environment.capability.findings[0]!.state = 'unknown'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.environment.intent.profile = 'workshop'; },
      (f: Awaited<ReturnType<typeof fixture>>) => { f.environment.intent.discovery.environments[1].origin = 'https://changed.example.test'; },
    ]) {
      const f = await fixture({ approve: true }); mutate(f);
      await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
      expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.operations).toEqual([]);
    }
  });
  it('blocks total monthly costs, unknown values, stale pricing and renewal charges, not just incremental usage', async () => {
    for (const change of [
      (i: DeploymentIntent) => { i.costs.lines[0]!.thisMonthCents = 9900; },
      (i: DeploymentIntent) => { i.costs.lines[0]!.thisMonthCents = null; },
      (i: DeploymentIntent) => { i.costs.materialUnknowns = ['Tax unresolved']; },
      (i: DeploymentIntent) => { i.costs.pricingAsOf = '2020-01-01'; },
      (i: DeploymentIntent) => { i.costs.lines.find(l => l.category === 'renewals')!.thisMonthCents = 12000; },
      (i: DeploymentIntent) => { i.costs.lines = i.costs.lines.filter(l => l.category !== 'tax').concat([{ category: 'reserve', label: 'extra', thisMonthCents: 0, source: 'fixture', assumption: 'No tax fact supplied' }]); },
    ]) {
      const f = await fixture({ mutateIntent: change }); expect(f.plan.status).toBe('blocked');
      expect(() => f.store.approve(f.saved.planPath, `APPROVE ${f.saved.digest}`, true, NOW)).toThrow('Blocked');
      await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow(); expect(f.operations).toEqual([]);
    }
    const f = await fixture(); f.intent.costs.lines[0]!.thisMonthCents = null;
    expect(assessCost(f.intent.costs, NOW)).toMatchObject({ totalCents: null, remainingCents: null, providerEnforcedCap: false });
  });
  it('does not silently remove excluded formerly-deployed modules', async () => {
    const f = await fixture({ approve: true });
    expect(f.plan.includedModules).toEqual(['core']); expect(f.plan.excludedModules.some(m => m.id === 'waiting-room')).toBe(true);
    expect(f.plan.steps.every(s => s.module === 'core' && s.deletes === false)).toBe(true);
    await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(f.operations.some(s => s.includes('waiting-room') || s.includes('delete'))).toBe(false);
  });
  it('records partial changes and never rolls back, retries or releases an uncertain lease', async () => {
    const f = await fixture({ approve: true, execute: async ctx => { await ctx.perform('fixture-create', 'owned-core-resource', async () => {}); await ctx.perform('fixture-create', 'possibly-created-resource', async () => { throw new Error('private-error-secret'); }); } });
    const record = await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(record.status).toBe('failed'); expect(record.resources.map(r => [r.id, r.certainty])).toEqual([['owned-core-resource', 'confirmed'], ['possibly-created-resource', 'possible']]);
    expect(JSON.stringify(record)).not.toContain('private-error-secret');
    const attempts = readdirSync(f.store.directory).filter(n => n.endsWith('.attempt.json')); expect(attempts).toHaveLength(1);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).toHaveBeenCalledOnce();
  });
  it('persists safe tool diagnostics on partial failure without raw provider text', async () => {
    const secret = 'raw-provider-error-private-canary';
    const event = JSON.stringify({ type: 'diagnostic', diagnostic: { severity: 'error', summary: 'failed to make http request', address: 'cloudflare_image_variant.catalog', detail: `HTTP 400 {"code":5400,"message":"${secret}"}` } });
    const f = await fixture({ approve: true, execute: async () => { throw new DeploymentToolError(terraformFailure(event, 1, false)); } });
    const record = await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(record.status).toBe('failed'); expect(record.toolFailure?.diagnostics[0]).toMatchObject({ resource: 'cloudflare_image_variant.catalog', httpStatus: 400, providerCodes: [5400] });
    const saved = readFileSync(join(f.store.directory, `${f.plan.id}.attempt.json`), 'utf8');
    expect(saved).not.toContain(secret); expect(JSON.parse(saved).toolFailure).toEqual(record.toolFailure);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).toHaveBeenCalledOnce();
  });
  it('consumes successful approval once and rejects tampered plan files', async () => {
    const f = await fixture({ approve: true }); await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow(); expect(f.createExecutor).toHaveBeenCalledOnce();
    const g = await fixture({ approve: true }); const raw = JSON.parse(readFileSync(g.saved.planPath, 'utf8')); raw.plan.steps[0].resources = ['foreign-resource']; writeFileSync(g.saved.planPath, JSON.stringify(raw));
    await expect(applyReviewedPlan(g.store, g.saved.planPath, g.environment)).rejects.toThrow('integrity'); expect(g.createExecutor).not.toHaveBeenCalled();
  });
  it('rejects shared privilege-bearing credential values before constructing a writer', async () => {
    const f = await fixture({ approve: true }); f.environment.credentials.deployer = f.environment.credentials.reader;
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow('Separate'); expect(f.createExecutor).not.toHaveBeenCalled();
  });
  it('shared API mode still requires exact approval and separate application secrets', async () => {
    const shared = (intent: DeploymentIntent) => {
      intent.discovery.credentials.apiTokenMode = 'shared';
      intent.discovery.credentials.reader = intent.discovery.credentials.deployer = 'env:LAB_API_TOKEN';
    };
    const f = await fixture({ mutateIntent: shared });
    f.environment.credentials.deployer = f.environment.credentials.reader;
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).not.toHaveBeenCalled();
    f.store.approve(f.saved.planPath, `APPROVE ${f.saved.digest}`, true, NOW);
    expect((await applyReviewedPlan(f.store, f.saved.planPath, f.environment)).status).toBe('succeeded');
    const g = await fixture({ approve: true, mutateIntent: shared });
    g.environment.credentials.deployer = g.environment.credentials.reader;
    g.environment.credentials.collector = g.environment.credentials.reader;
    await expect(applyReviewedPlan(g.store, g.saved.planPath, g.environment)).rejects.toThrow('Separate');
    expect(g.createExecutor).not.toHaveBeenCalled();
  });
  it('changing API token mode invalidates a prior approval', async () => {
    const f = await fixture({ approve: true });
    f.environment.intent.discovery.credentials.apiTokenMode = 'shared';
    f.environment.intent.discovery.credentials.deployer = f.environment.intent.discovery.credentials.reader;
    f.environment.credentials.deployer = f.environment.credentials.reader;
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow('drift');
    expect(f.createExecutor).not.toHaveBeenCalled();
  });
  it('broad-token consent changes require a fresh exact approval', async () => {
    const f = await fixture({ approve: true });
    f.environment.intent.discovery.credentials.allowBroadApiToken = true;
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow('drift');
    expect(f.createExecutor).not.toHaveBeenCalled();
  });
  it.each(['external-abort', 'setup-deadline'] as const)('retains explicit stop uncertainty when %s wins the apply race', async kind => {
    const controller = new AbortController(); let program = '';
    const f = await fixture({ approve: true, ...(kind === 'setup-deadline' ? { mutateIntent: intent => { intent.setup.maxRuntimeMs = 1000; } } : {}), execute: async ctx => {
      await ctx.perform('fixture-tool', 'owned-fixture', () => runBoundedTool(process.execPath, ['-e', program], { cwd: f.root, env: { PATH: process.env.PATH ?? '' }, signal: ctx.signal, timeoutMs: 4000, diagnosticMode: 'terraform-json' }));
    } });
    const marker = join(f.root, 'owned-synthetic-started');
    program = kind === 'external-abort'
      ? `const{spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{detached:true,stdio:['ignore',1,2],env:{PATH:process.env.PATH}});require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');p.unref();process.exit(0)`
      : `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},2500)`;
    f.environment.signal = controller.signal;
    if (kind === 'setup-deadline') delete f.environment.clock;
    const started = performance.now(); const pending = applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    if (kind === 'external-abort') controller.abort(new Error('private-apply-abort-canary'));
    const record = await pending;
    expect(record.status).toBe('failed'); expect(record.toolFailure).toMatchObject({ stopped: true, processQuiescence: 'unproven', diagnostics: [] });
    expect(record.resources.some(resource => resource.certainty === 'possible')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1800); expect(f.createExecutor).toHaveBeenCalledOnce();
    const saved = readFileSync(join(f.store.directory, `${f.plan.id}.attempt.json`), 'utf8');
    expect(saved).not.toContain('private-apply-abort-canary'); expect(JSON.parse(saved).toolFailure).toEqual(record.toolFailure);
    expect(existsSync(join(f.intent.discovery.evidenceDirectory, 'leases', `${f.intent.discovery.labId}.json`))).toBe(true);
    await expect(applyReviewedPlan(f.store, f.saved.planPath, f.environment)).rejects.toThrow();
    expect(f.createExecutor).toHaveBeenCalledOnce();
    if (kind === 'external-abort') await new Promise(resolve => setTimeout(resolve, 1100));
  });
  it('sanitizes pre-start aborts without creating an attempt, lease or executor', async () => {
    const f = await fixture({ approve: true }); const controller = new AbortController();
    const privateReason = new Error('private-pre-start-abort-canary'); controller.abort(privateReason); f.environment.signal = controller.signal;
    try { await applyReviewedPlan(f.store, f.saved.planPath, f.environment); throw new Error('Expected pre-start refusal'); }
    catch (error) {
      expect(error).toBeInstanceOf(DeploymentToolError); expect(error).not.toBe(privateReason);
      expect((error as DeploymentToolError).failure).toMatchObject({ stopped: true, processQuiescence: 'unproven', diagnostics: [] });
      expect(String(error)).not.toContain('private-pre-start-abort-canary'); expect(JSON.stringify(error)).not.toContain('private-pre-start-abort-canary');
    }
    expect(f.createExecutor).not.toHaveBeenCalled(); expect(f.operations).toEqual([]);
    expect(existsSync(join(f.store.directory, `${f.plan.id}.attempt.json`))).toBe(false);
    expect(existsSync(join(f.intent.discovery.evidenceDirectory, 'leases', `${f.intent.discovery.labId}.json`))).toBe(false);
  });
  it('handles an eager rejected executor on an immediate abort without storing raw reasons', async () => {
    const f = await fixture({ approve: true }); const controller = new AbortController(); f.environment.signal = controller.signal;
    f.environment.createExecutor = vi.fn(async () => { controller.abort(new Error('private-eager-abort')); throw new Error('private-eager-rejection'); });
    const record = await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(record.status).toBe('failed'); expect(record.toolFailure).toMatchObject({ stopped: true, processQuiescence: 'unproven' });
    expect(JSON.stringify(record)).not.toMatch(/private-eager/); expect(record.resources).toEqual([]);
  });
  it('does not begin a queued action after cancellation', async () => {
    const controller = new AbortController(); const action = vi.fn(async () => {});
    const f = await fixture({ approve: true, execute: async ctx => { const task = ctx.perform('fixture-write', 'owned-fixture', action); controller.abort(); await task; } });
    f.environment.signal = controller.signal;
    const record = await applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    expect(record.status).toBe('failed'); expect(record.toolFailure?.stopped).toBe(true); expect(action).not.toHaveBeenCalled();
  });
  it('bounds uncooperative execution by the setup deadline and prevents mode laundering', async () => {
    const f = await fixture({ approve: true, execute: ctx => ctx.perform('fixture-write', 'owned', () => new Promise(() => {})) });
    const pending = applyReviewedPlan(f.store, f.saved.planPath, f.environment);
    await vi.waitFor(() => {
      expect(f.createExecutor).toHaveBeenCalledOnce();
      const attempt = JSON.parse(readFileSync(join(f.store.directory, `${f.plan.id}.attempt.json`), 'utf8'));
      expect(attempt.resources).toHaveLength(1);
    });
    f.clock.advance(10000); const result = await pending; expect(result.status).toBe('failed'); expect(result.resources.some(r => r.certainty === 'possible')).toBe(true);
    const g = await fixture({ approve: true }); g.environment.createExecutor = vi.fn(async () => ({ mode: 'live' as const, execute: vi.fn(async () => {}), close: async () => {} }));
    expect((await applyReviewedPlan(g.store, g.saved.planPath, g.environment)).status).toBe('failed');
  });
});
