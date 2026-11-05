import { describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { createExecutionAudit, assessExecutionAudit, type ExecutionAuditScope, type ExecutionAuditEvidence } from '../packages/demo-core/src/execution-audit.js';
import { applyReviewedPlan, type SetupContext, type SetupExecutor } from '../packages/demo-core/src/deployment-apply.js';
import type { DeploymentTools } from '../packages/demo-core/src/deployment-tools.js';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import { DeploymentStore } from '../packages/demo-core/src/deployment-store.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { desiredCustomWaf, inspectCustomWaf, provisionCustomWaf } from '../packages/demo-core/src/custom-waf.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { securityEventsBody } from '../packages/demo-core/src/graphql.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { labConfig } from './fixtures/lab.js';

// No live provider or tool is constructed. Temporary files stay in this worker's HOME.
async function fixture() {
  const scratch = process.env['KIROCREW_SCRATCH']; if (!scratch) throw new Error('Short worker scratch required');
  const root = mkdtempSync(join(scratch, 'case-')); const now = Date.now();
  const intent = deploymentIntent(root, now); intent.profile = 'core-waf';
  const capability = await discoverCapabilities(intent.discovery, 'core-waf', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'injected-offline', reasons: [] }) }, undefined, new Date(now).toISOString());
  const plan = createDeploymentPlan(intent, capability, 'b'.repeat(64), root, now);
  const scope: ExecutionAuditScope = { runId: plan.id, releaseDigest: intent.releaseDigest, configurationDigest: plan.intentDigest, sourceDigest: plan.sourceDigest, mode: 'fixture', accountId: intent.discovery.accountId, zoneId: intent.discovery.zoneId };
  const targets = { before: intent.discovery.environments[0].origin, after: intent.discovery.environments[1].origin, telemetry: intent.discovery.telemetryOrigin };
  const audit = createExecutionAudit(scope, targets);
  const rawTools: DeploymentTools = {
    verifyVersions: vi.fn(async () => {}), terraform: vi.fn(async () => '{}'), applyTerraform: vi.fn(async () => {}),
    wrangler: vi.fn(async () => 'offline'), close: vi.fn(async () => {}),
  };
  const rawExecutor: SetupExecutor = { mode: 'fixture', execute: vi.fn(async (step, context) => { await context.perform('fixture-write', step.resources[0]!, async () => {}); }), close: vi.fn(async () => {}) };
  const rawContext: SetupContext = { signal: new AbortController().signal, plan,
    perform: async <T>(_kind: string, _ownedId: string, action: () => Promise<T>) => action(), observeResource: vi.fn() };
  const context = audit.hookSetupContext(rawContext);
  const executor = audit.hookSetupExecutor(rawExecutor); const tools = audit.hookDeploymentTools(rawTools);
  const rawProvider = vi.fn(async () => new Response(JSON.stringify({ success: true, result: null, errors: [] }), { status: 200 }));
  const rawRuntime = vi.fn(async () => new Response('Synthetic fixture', { status: 200 }));
  const provider = audit.hookProviderDispatch(rawProvider); const runtime = audit.hookRuntimeDispatch(rawRuntime);
  return { root, intent, capability, plan, scope, targets, audit, context, executor, tools, provider, runtime, rawContext, rawTools, rawExecutor, rawProvider, rawRuntime };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function checkChain(evidence: ExecutionAuditEvidence) {
  let previous = hash({ auditId: evidence.auditId, scopeDigest: evidence.scopeDigest, targetsDigest: evidence.targetsDigest });
  for (const [index, event] of evidence.events.entries()) {
    expect(event.sequence).toBe(index + 1); expect(event.previousDigest).toBe(previous);
    expect(event.scopeDigest).toBe(evidence.scopeDigest);
    const { digest: current, ...value } = event; expect(hash(value)).toBe(current); previous = current;
  }
  const { digest: current, ...value } = evidence; expect(hash(value)).toBe(current);
}

describe('execution-boundary audit, injected offline I/O only', () => {
  it('joins real reviewed apply to executor/context hooks; later repairs stay visible', async () => {
    const f = await fixture(); const store = new DeploymentStore(f.root, f.intent.discovery.evidenceDirectory);
    const saved = store.save(f.plan); store.approve(saved.planPath, `APPROVE ${saved.digest}`, true);
    const record = await applyReviewedPlan(store, saved.planPath, { intent: f.intent, capability: f.capability,
      sourceDigest: f.plan.sourceDigest, credentials: FIXTURE_CREDENTIALS,
      createExecutor: async () => ({ mode: 'fixture', execute: (step, context) => f.executor.execute(step, f.audit.hookSetupContext(context)), close: () => f.executor.close() }) });
    expect(record.status).toBe('succeeded'); expect(f.rawExecutor.execute).toHaveBeenCalledTimes(f.plan.steps.length);
    f.audit.beginVerification();
    await expect(f.executor.execute(f.plan.steps[0]!, f.context)).rejects.toThrow('blocked');
    const evidence = f.audit.finish(); checkChain(evidence);
    expect(evidence.events.some(e => e.boundary === 'setup-context' && e.state === 'completed' && e.phase === 'deployment')).toBe(true);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'repair-detected', noRepairObserved: false, blockedAttempts: 1, readinessClaimValid: false });
    expect(f.rawExecutor.execute).toHaveBeenCalledTimes(f.plan.steps.length);
  });

  it('automatically wraps central apply and catches later repairs without caller hook wiring', async () => {
    const f = await fixture(); const store = new DeploymentStore(f.root, f.intent.discovery.evidenceDirectory);
    const saved = store.save(f.plan); store.approve(saved.planPath, `APPROVE ${saved.digest}`, true);
    let audit: ReturnType<typeof createExecutionAudit> | undefined; let captured: SetupContext | undefined;
    const record = await applyReviewedPlan(store, saved.planPath, { intent: f.intent, capability: f.capability, sourceDigest: f.plan.sourceDigest, credentials: FIXTURE_CREDENTIALS,
      createExecutor: async (_plan, installedAudit) => { audit = installedAudit; return { mode: 'fixture', execute: async (_step, context) => { captured = context; await context.perform('fixture-write', 'owned-fixture', async () => {}); }, close: async () => {} }; },
    });
    expect(record.status).toBe('succeeded'); expect(audit).toBeDefined(); expect(captured).toBeDefined();
    audit!.beginVerification(); const hiddenRepair = vi.fn(async () => {});
    await expect(captured!.perform('fixture-write', 'owned-fixture', hiddenRepair)).rejects.toThrow('blocked');
    expect(hiddenRepair).not.toHaveBeenCalled(); const evidence = audit!.finish();
    expect(evidence.scope.runId).toBe(f.plan.id); expect(evidence.coverage).toContain('setup-executor'); expect(evidence.coverage).toContain('setup-context');
    expect(assessExecutionAudit(evidence, evidence.scope)).toMatchObject({ outcome: 'repair-detected', noRepairObserved: false, blockedAttempts: 1 });
  });
  it('catches a real DeploymentApi WAF write despite a caller claiming zero repairs', async () => {
    const f = await fixture(); f.audit.beginVerification();
    const caller = { setupMutations: 0, events: [] };
    const api = new DeploymentApi(f.root, f.intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, f.provider);
    try {
      await expect(api.customWaf(f.rawContext).create(desiredCustomWaf(f.intent.discovery.labId, f.targets.after), f.context.signal)).rejects.toThrow('blocked');
    } finally { api.close(); }
    caller.events.length = 0;
    expect(caller.setupMutations).toBe(0); expect(f.rawProvider).not.toHaveBeenCalled();
    const evidence = f.audit.finish();
    expect(evidence.events.map(e => [e.operation, e.state])).toEqual([['provider.write', 'attempt'], ['provider.write', 'blocked']]);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'repair-detected', noRepairObserved: false, observedMutations: 0 });
  });

  it('blocks the actual WAF module at SetupContext before its write callback', async () => {
    const f = await fixture();
    const desired = desiredCustomWaf(f.intent.discovery.labId, f.targets.after);
    const api = { entrypoint: vi.fn(async () => null), create: vi.fn(async () => {}), append: vi.fn(async () => {}), enable: vi.fn(async () => {}) };
    const initial = await inspectCustomWaf(api, desired);
    f.audit.beginVerification(); f.audit.beginInterview();
    await expect(provisionCustomWaf(api, desired, initial.state, f.context)).rejects.toThrow('blocked');
    expect(api.create).not.toHaveBeenCalled();
    const evidence = f.audit.finish();
    expect(evidence.events[0]).toMatchObject({ boundary: 'setup-context', phase: 'interview', effect: 'setup' });
    expect(assessExecutionAudit(evidence, f.scope).outcome).toBe('repair-detected');
  });

  it('blocks Terraform, redeploy, secret changes and seed repair, even in interview', async () => {
    const f = await fixture(); f.audit.beginVerification(); f.audit.beginInterview();
    await expect(f.tools.applyTerraform('/owned/core.tfplan', '/owned', f.context.signal)).rejects.toThrow('blocked');
    await expect(f.tools.wrangler(['deploy'], '/owned', f.context.signal)).rejects.toThrow('blocked');
    await expect(f.tools.wrangler(['secret', 'bulk'], '/owned', f.context.signal, 'SECRET-CANARY')).rejects.toThrow('blocked');
    await expect(f.tools.terraform(['plan'], '/owned')).rejects.toThrow('blocked');
    await expect(f.runtime(`${f.targets.before}/internal/seed`, { method: 'POST' })).rejects.toThrow('blocked');
    expect(f.rawTools.applyTerraform).not.toHaveBeenCalled(); expect(f.rawTools.wrangler).not.toHaveBeenCalled();
    expect(f.rawTools.terraform).not.toHaveBeenCalled(); expect(f.rawRuntime).not.toHaveBeenCalled();
    const evidence = f.audit.finish(); checkChain(evidence);
    expect(JSON.stringify(evidence)).not.toContain('SECRET-CANARY');
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ attempts: 5, blockedAttempts: 5, observedMutations: 0, outcome: 'repair-detected' });
  });

  it('records actual GuardedClient reads and synthetic writes without calling them repairs', async () => {
    const f = await fixture(); const config = labConfig(f.root); config.liveOptIn = true;
    const ledger = new BudgetLedger({ limits: { cleanupRequests: 0, cleanupMs: 0 } });
    const client = new GuardedClient(config, ledger, { observedOwnedResources: new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)), dispatch: f.runtime });
    f.audit.beginVerification();
    try {
      await client.request({ kind: 'before', url: `${f.targets.before}/catalog` });
      await client.request({ kind: 'after', url: `${f.targets.after}/register`, method: 'POST', headers: { 'x-demo-run-id': f.scope.runId, 'x-demo-scenario': 'turnstile' }, body: JSON.stringify({ record_id: randomUUID(), display_name: 'synthetic-test', note: '' }) });
    } finally { ledger.stop(); }
    const evidence = f.audit.finish(); checkChain(evidence);
    expect(f.rawRuntime).toHaveBeenCalledTimes(2);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'clean-boundaries', noRepairObserved: true, observedMutations: 1, readinessClaimValid: false });
    expect(assessExecutionAudit(evidence, f.scope).blockers.join(' ')).toContain('composition roots');
  });

  it('records actual allowed deployment mutations and uncertain failures, without raw errors', async () => {
    const f = await fixture();
    await f.provider(`https://api.cloudflare.com/client/v4/zones/${f.scope.zoneId}/rulesets`, { method: 'POST', headers: { authorization: 'SECRET-CANARY' }, body: 'SECRET-CANARY' });
    const failing = f.audit.hookRuntimeDispatch(async () => { throw new Error('SECRET-CANARY'); });
    f.audit.beginVerification();
    await expect(failing(`${f.targets.after}/register`, { method: 'POST', headers: { 'x-demo-run-id': f.scope.runId, 'x-demo-scenario': 'turnstile' }, body: '{}' })).rejects.toThrow('Audited boundary failed');
    const evidence = f.audit.finish();
    expect(evidence.events.some(e => e.phase === 'deployment' && e.mutation === 'observed')).toBe(true);
    expect(evidence.events.some(e => e.phase === 'verification' && e.mutation === 'possible')).toBe(true);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ possibleMutations: 1, outcome: 'unknown', noRepairObserved: false });
    expect(JSON.stringify(evidence)).not.toContain('SECRET-CANARY');
  });

  it('allows only the actual fixed, correctly scoped GraphQL read contract', async () => {
    const f = await fixture(); f.audit.beginVerification();
    const body = securityEventsBody({ zoneId: f.scope.zoneId, start: '2026-11-04T00:00:00.000Z', end: '2026-11-04T00:01:00.000Z', rayId: 'a'.repeat(16), hostname: new URL(f.targets.after).hostname, limit: 1 });
    await f.provider('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', body });
    await expect(f.provider('https://api.cloudflare.com/client/v4/graphql', { method: 'POST', body: JSON.stringify({ query: 'mutation { repair }' }) })).rejects.toThrow('blocked');
    expect(f.rawProvider).toHaveBeenCalledOnce();
    expect(assessExecutionAudit(f.audit.finish(), f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
  });

  it.each(['foreign-host', 'foreign-account', 'encoded-seed', 'foreign-run', 'unknown-tool'])('fails closed on %s', async fault => {
    const f = await fixture(); f.audit.beginVerification();
    const operation = fault === 'unknown-tool' ? f.tools.terraform(['destroy'], '/owned')
      : fault === 'foreign-account' ? f.provider(`https://api.cloudflare.com/client/v4/accounts/${'f'.repeat(32)}/images/v1`, { method: 'POST' })
      : fault === 'foreign-run' ? f.runtime(`${f.targets.after}/internal/registrations/cleanup`, { method: 'POST', body: JSON.stringify({ runId: randomUUID() }) })
      : f.runtime(fault === 'encoded-seed' ? `${f.targets.after}/internal/%73eed` : 'https://foreign.example.test/catalog', { method: 'GET' });
    await expect(operation).rejects.toThrow('blocked');
    const evidence = f.audit.finish();
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false, blockedAttempts: 1 });
    expect(f.rawRuntime).not.toHaveBeenCalled(); expect(f.rawProvider).not.toHaveBeenCalled();
  });

  it('rejects missing evidence, caller coverage, clones, edits and foreign scope', async () => {
    const f = await fixture(); f.audit.beginVerification(); await f.runtime(`${f.targets.before}/catalog`, {});
    const evidence = f.audit.finish();
    expect(Object.isFrozen(evidence)).toBe(true); expect(Object.isFrozen(evidence.events[0])).toBe(true);
    expect(() => (evidence.events as unknown[]).pop()).toThrow();
    expect(() => Object.assign(evidence.scope, { runId: randomUUID() })).toThrow();
    for (const forged of [undefined, null, {}, { setupMutations: 0, coverage: evidence.coverage }, structuredClone(evidence), JSON.parse(JSON.stringify(evidence)), { ...evidence, events: [] }]) {
      expect(assessExecutionAudit(forged, f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false, readinessClaimValid: false });
    }
    for (const foreign of [{ runId: randomUUID() }, { releaseDigest: 'f'.repeat(64) }, { configurationDigest: 'f'.repeat(64) }, { mode: 'live' as const }, { zoneId: 'f'.repeat(32) }]) {
      expect(assessExecutionAudit(evidence, { ...f.scope, ...foreign }).outcome).toBe('unknown');
    }
  });

  it('does not trust caller-mutated setup objects or scope arrays', async () => {
    const f = await fixture(); const input = { ...f.scope }; const audit = createExecutionAudit(input, f.targets);
    input.runId = randomUUID();
    const raw = { ...f.rawTools }; const tools = audit.hookDeploymentTools(raw);
    const original = raw.applyTerraform; raw.applyTerraform = vi.fn(async () => { throw new Error('replaced'); });
    await tools.applyTerraform('/owned/core.tfplan', '/owned', f.context.signal);
    expect(original).toHaveBeenCalledOnce(); expect(raw.applyTerraform).not.toHaveBeenCalled();
    audit.beginVerification();
    const evidence = audit.finish(); expect(evidence.scope.runId).toBe(f.scope.runId);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
    expect(assessExecutionAudit(evidence, f.scope).blockers).toContain('Missing boundary: provider-dispatch');
    expect(() => audit.hookRuntimeDispatch(f.rawRuntime)).toThrow('sealed');
  });

  it('refuses late hook installation, phase resets, open operations and use after seal', async () => {
    const f = await fixture(); let release!: (response: Response) => void;
    const waiting = f.audit.hookRuntimeDispatch(async () => new Promise<Response>(resolve => { release = resolve; }));
    f.audit.beginVerification();
    expect(() => f.audit.beginVerification()).toThrow('phase');
    expect(() => f.audit.hookRuntimeDispatch(f.rawRuntime)).toThrow('before verification');
    const operation = waiting(`${f.targets.before}/catalog`, {});
    expect(() => f.audit.finish()).toThrow('unfinished'); expect(() => f.audit.beginInterview()).toThrow('busy');
    release(new Response('fixture')); await operation;
    const evidence = f.audit.finish(); expect(f.audit.finish()).toBe(evidence);
    await expect(f.runtime(`${f.targets.after}/internal/seed`, { method: 'POST' })).rejects.toThrow('sealed');
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'unknown', readinessClaimValid: false });
  });

  it('rejects foreign executor contexts before invoking an actual dependency', async () => {
    const f = await fixture(); const foreign = { ...f.rawContext, plan: structuredClone(f.plan) };
    foreign.plan.intent.releaseDigest = 'f'.repeat(64);
    expect(() => f.audit.hookSetupContext(foreign)).toThrow('Foreign');
    f.audit.beginVerification();
    await expect(f.executor.execute(f.plan.steps[0]!, foreign)).rejects.toThrow('blocked');
    expect(f.rawExecutor.execute).not.toHaveBeenCalled();
    expect(assessExecutionAudit(f.audit.finish(), f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
  });

  it('keeps prior repair attempts visible when a sealed hook is used again', async () => {
    const f = await fixture(); f.audit.beginVerification();
    await expect(f.runtime(`${f.targets.before}/internal/seed`, { method: 'POST' })).rejects.toThrow('blocked');
    const evidence = f.audit.finish();
    await expect(f.runtime(`${f.targets.before}/catalog`, {})).rejects.toThrow('sealed');
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'repair-detected', attempts: 2, blockedAttempts: 2, noRepairObserved: false });
    expect(evidence.events).toHaveLength(2);
  });

  it('rejects empty verification/interview windows and failed read observations', async () => {
    const empty = await fixture(); empty.audit.beginVerification();
    expect(assessExecutionAudit(empty.audit.finish(), empty.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
    const interview = await fixture(); interview.audit.beginVerification();
    await interview.runtime(`${interview.targets.before}/catalog`, {}); interview.audit.beginInterview();
    expect(assessExecutionAudit(interview.audit.finish(), interview.scope).blockers).toContain('No completed transport observation in interview');
    const failed = await fixture(); const dispatch = failed.audit.hookRuntimeDispatch(async () => new Response('fixture unavailable', { status: 503 }));
    failed.audit.beginVerification(); await dispatch(`${failed.targets.before}/catalog`, {});
    expect(assessExecutionAudit(failed.audit.finish(), failed.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
  });

  it('bounds evidence, poisons overflow and never dispatches beyond the cap', async () => {
    const f = await fixture(); f.audit.beginVerification();
    for (let i = 0; i < 2048; i++) await f.runtime(`${f.targets.before}/catalog`, {});
    await expect(f.runtime(`${f.targets.before}/catalog`, {})).rejects.toThrow('cap');
    const evidence = f.audit.finish(); expect(evidence.events).toHaveLength(4096);
    expect(f.rawRuntime).toHaveBeenCalledTimes(2048);
    expect(assessExecutionAudit(evidence, f.scope)).toMatchObject({ outcome: 'unknown', noRepairObserved: false });
  });
});
