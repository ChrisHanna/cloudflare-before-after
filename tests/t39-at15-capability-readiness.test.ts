import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AcceptanceSchema } from '../packages/contracts/src/schemas.js';
import { runAt15Acceptance, type At15Options } from '../packages/demo-core/src/t39-at15-capability-harness.js';
import { DeploymentReadbackSchema, deploymentFingerprint, evaluateDeployment } from '../packages/demo-core/src/deployment-verification-core.js';
import { buildReadinessReport, ReadinessRecordStore, type ReadinessOptions } from '../packages/demo-core/src/readiness-report-core.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { INTERVIEW_STAGES, type InterviewStageView } from '../packages/demo-core/src/interview-timeline.js';
import { WaitingRoomStateMachine } from '../packages/demo-core/src/waiting-room.js';
import { createExecutionAudit, assessExecutionAudit } from '../packages/demo-core/src/execution-audit.js';
import { deploymentFixture, time, end, digest } from './workshop-core-fixtures.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { labConfig } from './fixtures/lab.js';
import { TestClock } from './fixtures/clock.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
function root() { const path = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 't39-at15-')); roots.push(path); return path; }
function fixture() {
  const projectRoot = root(); const f = deploymentFixture(); f.config = labConfig(projectRoot); f.config.liveOptIn = true;
  const calls: { url: string; method: string }[] = [];
  const scope = new Map<string, { runId: string; requestId: string }>();
  const clock = new TestClock(); let reads = 0;
  const controls = { finalDrift: false, denied: false, unhealthy: false, missingService: false };
  const options: At15Options = {
    clock,
    deployment: { projectRoot, config: f.config, expected: f.state, mode: 'fixture', credentials: { runner: FIXTURE_CREDENTIALS.runner, collector: FIXTURE_CREDENTIALS.collector },
      observedOwnedResources: new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), plannedRequests: 8,
      now: () => Date.parse(time) + clock.now(),
      inspect: async (client, signal) => (await client.requestJson({ kind: 'cloudflare', url: `${f.config.apiOrigin}/client/v4/accounts/${f.config.accountId}` }, DeploymentReadbackSchema, signal)).data,
      operations: async ({ role, runId, requestId }) => f.probes.find(p => p.role === role)!.operations.filter(o => !controls.missingService || o.service !== 'images').map(o => ({ ...o, runId, requestId, evidence: { ...o.evidence, runId, requestId } })),
      dispatch: async (url, init) => {
        calls.push({ url, method: init.method ?? 'GET' }); const u = new URL(url);
        if (u.origin === f.config.apiOrigin) {
          reads++; if (controls.denied) return Response.json({ error: 'Denied' }, { status: 403 });
          const state = structuredClone(f.state); if (reads > 1 && controls.finalDrift) state.containerDigest = 'f'.repeat(64);
          return Response.json({ state, observedAt: time });
        }
        const env = f.config.environments.find(e => e.origin === u.origin);
        if (env && u.pathname === '/catalog') {
          const h = new Headers(init.headers); scope.set(env.role, { runId: h.get('x-demo-run-id')!, requestId: h.get('x-demo-request-id')! });
          return new Response('Synthetic catalog', { headers: { 'x-lab-role': env.role, 'x-lab-release': env.releaseDigest } });
        }
        if (env && u.pathname === '/internal/checkpoint') return Response.json({ healthy: true });
        if (u.origin === f.config.telemetryOrigin) {
          const role = u.searchParams.get('role')!; const ids = scope.get(role)!;
          return Response.json({ schemaVersion: 1, targetRole: role, runId: ids.runId, scenarioId: 'waf-custom', originCount: controls.unhealthy ? null : 1,
            receipts: [{ ...f.probes.find(p => p.role === role)!.receipts[0], ...ids }],
            coverage: { healthy: !controls.unhealthy, complete: !controls.unhealthy, windowStart: time, watermark: time, producerSequence: 1, gaps: controls.unhealthy ? ['Producer gap'] : [] } });
        }
        throw new Error('Unplanned offline request');
      } },
    readiness: { mode: 'fixture', scope: 'core', observedAt: end, releaseDigest: digest, configurationDigest: deploymentFingerprint(f.state),
      hostnames: f.config.environments.map(e => new URL(e.origin).hostname) as [string, string], includedModules: [], excludedModules: [],
      core: { appliedInventoryDigest: digest, observedInventoryDigest: digest, reachableRoles: ['before', 'after'] },
      captures: [], currentScenarioDigests: {}, setupMutations: 0 },
  };
  return { f, options, controls, calls, projectRoot, clock };
}
function syntheticLiveInput(): ReadinessOptions {
  // Synthetic inputs test the live branch only. No live acceptance is issued.
  const f = deploymentFixture(); for (const p of f.probes) for (const o of p.operations) o.evidence.mode = 'live';
  const deployment = evaluateDeployment({ mode: 'live', config: f.config, expected: f.state, before: f.state, after: f.state, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: end });
  return { mode: 'live', scope: 'core', observedAt: end, releaseDigest: digest, configurationDigest: deploymentFingerprint(f.state), hostnames: f.config.environments.map(e => new URL(e.origin).hostname) as [string, string],
    core: { appliedInventoryDigest: digest, observedInventoryDigest: digest, reachableRoles: ['before', 'after'] }, includedModules: [], excludedModules: [],
    deployment, captures: [], currentScenarioDigests: {}, setupMutations: 0, measured: { requestsUsed: 8, durationMs: 1000 } };
}

describe('T39 AT-15A: real collection -> readiness -> versioned acceptance', () => {
  it('meters both host probes and persists non-passing fixture AT records', async () => {
    const f = fixture(); const r = await runAt15Acceptance(f.options);
    expect(f.calls).toHaveLength(8); expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(r.report!.deploymentChecks.every(c => c.passed)).toBe(true);
    expect(r.report!.requestsUsed).toBe(8); expect(r.report!.claims.deploymentVerified.verified).toBe(false);
    expect(r.records.map(v => v.id)).toEqual(['AT-15A', 'AT-15B', 'AT-15C']);
    expect(r.records.map(v => v.outcome)).toEqual(['failed', 'unavailable', 'unavailable']);
    expect(r.records[2]!.requirements).toEqual(['15.8', '15.9']);
    for (const record of r.records) expect(AcceptanceSchema.parse(record).mode).toBe('fixture');
    const store = new ReadinessRecordStore(f.projectRoot, f.f.config.evidenceDirectory);
    const path = store.save(r.report!, r.records); expect(path.startsWith(f.f.config.evidenceDirectory)).toBe(true);
    expect(store.load(r.report!.id)).toEqual({ report: r.report, acceptance: r.records });
    const serialized = JSON.stringify(r); for (const credential of Object.values(FIXTURE_CREDENTIALS)) expect(serialized).not.toContain(credential);
  });
  it.each(['finalDrift', 'denied', 'unhealthy', 'missingService'] as const)('retains the exact %s blocker without setup repair', async fault => {
    const f = fixture(); f.controls[fault] = true; const r = await runAt15Acceptance(f.options);
    const id = { finalDrift: 'matching-functional-state', denied: 'current-observed-state', unhealthy: 'after-telemetry', missingService: 'after-images-decode' }[fault];
    expect(r.report!.deploymentChecks.find(c => c.id === id)?.passed).toBe(false);
    expect(r.blockers).toContain(id); expect(r.records[0]!.outcome).toBe('failed');
    expect(f.calls.every(c => c.method === 'GET')).toBe(true); expect(f.calls.length).toBeLessThanOrEqual(8);
    if (fault === 'finalDrift' || fault === 'denied') expect(r.report!.historical).toBe(true);
  });
  it.each(['hostname', 'priority', 'action', 'enabled', 'permission', 'binding', 'release'] as const)('rejects %s drift even with working routes', fault => {
    const f = deploymentFixture();
    f.state.policies.push({ scenarioId: 'waf-custom', id: 'owned-rule', hostname: 'after.example.test', path: '/catalog', action: 'block', enabled: true, priority: 1, baselineExcluded: true, functionalDigest: digest });
    f.state.evidencePermissions = ['waf-custom']; const observed = structuredClone(f.state);
    if (fault === 'hostname') observed.policies[0]!.hostname = 'before.example.test';
    if (fault === 'priority') observed.policies[0]!.priority++;
    if (fault === 'action') observed.policies[0]!.action = 'allow';
    if (fault === 'enabled') observed.policies[0]!.enabled = false;
    if (fault === 'permission') observed.evidencePermissions = [];
    if (fault === 'binding') observed.bindings.after.d1 = null;
    if (fault === 'release') observed.releaseDigest = 'f'.repeat(64);
    const result = evaluateDeployment({ mode: 'fixture', config: f.config, expected: f.state, before: f.state, after: observed, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: end });
    expect(result.historical).toBe(true); expect(result.blockers).toContain('matching-functional-state'); expect(result.deploymentVerified).toBe(false);
  });
});

describe('T39 AT-15B/C: timed claims and safeguards', () => {
  it.each(['default', 'config-opt-in', 'prerequisite'] as const)('live gate %s dispatches nothing and records unavailable, never passed', async fault => {
    const f = fixture(); f.options.deployment.mode = 'live'; f.options.readiness.mode = 'live';
    if (fault === 'config-opt-in') { f.options.liveOptIn = true; f.options.deployment.config.liveOptIn = false; }
    if (fault === 'prerequisite') { f.options.liveOptIn = true; f.options.prerequisites = ['Waiting Room entitlement unknown', 'Event read permission denied']; }
    const r = await runAt15Acceptance(f.options);
    expect(f.calls).toEqual([]); expect(r.report).toBeNull();
    expect(r.records.every(v => v.outcome === 'unavailable' && v.requestsUsed === 0)).toBe(true);
    expect(r.blockers.length).toBeGreaterThan(0);
  });
  it('explicit opt-in without exact-plan approval still sends zero requests', async () => {
    const f = fixture(); f.options.deployment.mode = 'live'; f.options.readiness.mode = 'live'; f.options.liveOptIn = true;
    f.options.sourceDigest = digest;
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const result = await runAt15Acceptance(f.options);
    expect(result.blockers).toContain('Current exact live-plan approval and source/scope binding required');
    expect(result.records.map(record => record.outcome)).toEqual(['unavailable', 'unavailable', 'unavailable']);
    expect(result.records.every(record => record.requestsUsed === 0)).toBe(true);
    expect(f.calls).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it('runs default-reader contracts with only injected offline I/O, retaining unknown service facts', async () => {
    const f = fixture(); delete f.options.deployment.inspect; delete f.options.deployment.operations;
    f.options.deployment.credentials.reader = FIXTURE_CREDENTIALS.reader;
    f.options.deployment.plannedRequests = 22;
    const calls: string[] = [];
    f.options.deployment.dispatch = async (url, init) => {
      expect(init.method ?? 'GET').toBe('GET'); calls.push(url);
      if (new URL(url).pathname.endsWith('/settings')) return Response.json({ success: true, result: { bindings: [] } });
      if (new URL(url).pathname.endsWith('/content/v2')) return new Response('export default {}', { headers: { 'content-type': 'application/javascript' } });
      if (new URL(url).pathname === '/internal/service-read') return new Response('No independent service receipt', { status: 503 });
      throw new Error('Unplanned offline boundary');
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const result = await runAt15Acceptance(f.options);
    expect(calls.filter(url => new URL(url).pathname.endsWith('/settings'))).toHaveLength(4);
    expect(calls.filter(url => new URL(url).pathname.endsWith('/content/v2'))).toHaveLength(4);
    expect(calls.filter(url => new URL(url).pathname === '/internal/service-read')).toHaveLength(2);
    expect(result.report!.requestsUsed).toBe(calls.length);
    expect(result.report!.claims.deploymentVerified.verified).toBe(false);
    expect(result.report!.historical).toBe(true);
    expect(result.blockers).toContain('current-observed-state');
    expect(result.blockers).toContain('after-images-decode');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['copy', 'forged-zero', 'run', 'source', 'scope', 'release', 'fingerprint'] as const)('AT-15B rejects %s audit evidence without trusting setupMutations=0', async fault => {
    const f = fixture(); const scope = { runId: randomUUID(), mode: 'fixture' as const, releaseDigest: digest,
      configurationDigest: f.options.readiness.configurationDigest!, sourceDigest: digest, accountId: f.f.config.accountId, zoneId: f.f.config.zoneId };
    const audit = createExecutionAudit(scope, { before: f.f.config.environments[0].origin, after: f.f.config.environments[1].origin, telemetry: f.f.config.telemetryOrigin });
    const runtime = audit.hookRuntimeDispatch(async () => new Response('Offline observation'));
    audit.beginVerification(); await runtime(`${f.f.config.environments[0].origin}/catalog`, {});
    audit.beginInterview(); await runtime(`${f.f.config.environments[1].origin}/catalog`, {});
    const evidence = audit.finish(); const expected = { ...scope };
    if (fault === 'run') expected.runId = randomUUID();
    if (fault === 'source') expected.sourceDigest = 'b'.repeat(64);
    if (fault === 'scope') expected.zoneId = 'f'.repeat(32);
    if (fault === 'release') expected.releaseDigest = 'b'.repeat(64);
    if (fault === 'fingerprint') expected.configurationDigest = 'b'.repeat(64);
    const untrusted = fault === 'copy' ? JSON.parse(JSON.stringify(evidence)) : fault === 'forged-zero' ? { ...evidence, events: [], setupMutations: 0 } : evidence;
    expect(assessExecutionAudit(untrusted, expected).noRepairObserved).toBe(false);
    f.options.sourceDigest = digest; f.options.readiness.executionAudit = { evidence: untrusted, scope: expected };
    const result = await runAt15Acceptance(f.options);
    expect(result.records[1]!.assertions.find(a => a.name === 'No setup or manual repair')!.passed).toBe(false);
    expect(result.records[2]!.assertions.find(a => a.name === 'Independent bound no-repair audit')!.passed).toBe(false);
    expect(result.report!.claims.interviewVerified.verified).toBe(false);
  });
  it('rejects an impossible request plan before any collection', async () => {
    const f = fixture(); f.options.deployment.plannedRequests = 100;
    await expect(runAt15Acceptance(f.options)).rejects.toThrow(); expect(f.calls).toEqual([]);
  });
  it('a scoped synthetic deployment pass cannot claim interview or workshop', () => {
    const input = syntheticLiveInput(); const r = buildReadinessReport(input);
    expect(r.claims.deploymentVerified.verified).toBe(false);
    expect(r.claims.deploymentVerified.blockers).toContain('Complete independently scoped execution audit is missing or unqualified');
    expect(r.claims.interviewVerified.verified).toBe(false); expect(r.claims.workshopVerified.verified).toBe(false);
    expect(r.claims.workshopVerified.blockers).toContain('Genuine available DDoS event evidence is missing');
    expect(r.scenarios).toHaveLength(11); expect(r.scenarios.every(s => !s.currentLiveProof)).toBe(true);
  });
  it('AT-15C rejects an obsolete release even when configuration fingerprints match', () => {
    const input = syntheticLiveInput(); input.releaseDigest = 'b'.repeat(64);
    const r = buildReadinessReport(input);
    expect(r.claims.deploymentVerified.verified).toBe(false);
    expect(r.claims.deploymentVerified.blockers.join()).toMatch(/release/i);
    expect(r.historical).toBe(true);
  });
  it.each(['revision', 'denied', 'optional-enterprise', 'manual-repair', 'queue'] as const)('AT-15C blocks %s with explicit reasons', fault => {
    const input = syntheticLiveInput();
    if (fault === 'revision') input.configurationDigest = 'f'.repeat(64);
    if (fault === 'denied') { input.includedModules = ['waf-custom']; input.currentScenarioDigests = {}; }
    if (fault === 'optional-enterprise') input.excludedModules = [{ scenarioId: 'waiting-room', reason: 'not-entitled' }];
    if (fault === 'manual-repair') input.setupMutations = 1;
    if (fault === 'queue') {
      const machine = new WaitingRoomStateMachine(randomUUID(), 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: digest });
      machine.register('session-1', 'after'); machine.observe({ sessionId: 'session-1', requestId: randomUUID(), observedAt: time, queue: true, storefront: false, queueCookiePresent: true, cookieContinuity: true, receipts: [] }); input.waitingRoom = machine.result();
    }
    const r = buildReadinessReport(input);
    expect(r.claims.interviewVerified.verified).toBe(false); expect(r.claims.workshopVerified.verified).toBe(false);
    const blocked = [...r.claims.deploymentVerified.blockers, ...r.claims.interviewVerified.blockers, ...r.claims.workshopVerified.blockers];
    const reason = { revision: 'fingerprint', denied: 'waf-custom', 'optional-enterprise': 'Excluded products', 'manual-repair': 'Manual repair', queue: 'same-session admission' }[fault];
    expect(blocked.join()).toContain(reason);
    if (fault === 'optional-enterprise') expect(r.claims.coreDeployed.verified).toBe(true);
  });
  it('actual shared CLI aggregate preserves every outcome and cannot earn workshop readiness', async () => {
    const projectRoot = root(); const lab = demoLabFixture(projectRoot);
    const run = await runDemoCli(['all', '--json'], { projectRoot, mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: lab.dispatch });
    const data = JSON.parse(run.output);
    expect(run.exitCode).toBe(1); expect(data.result.items).toHaveLength(11);
    expect(data.result.requestsUsed).toBe(lab.calls.length); expect(data.result.requestsUsed).toBeLessThanOrEqual(300);
    expect(data.result.items.find((i: { scenarioId: string }) => i.scenarioId === 'ddos-evidence').outcome).not.toBe('verified');
    expect(lab.calls.every(c => ['GET', 'POST'].includes(c.method))).toBe(true);
    expect(lab.calls.filter(c => c.method === 'POST').every(c => new URL(c.url).pathname.endsWith('/graphql'))).toBe(true);
    // Feed the real fixture WAF report into immutable fallback and readiness paths.
    const waf = data.result.items.find((i: { scenarioId: string }) => i.scenarioId === 'waf-custom').capture;
    expect(waf.report.result.outcome).toBe('verified');
    const store = new ReportStore(projectRoot, lab.config.evidenceDirectory);
    const f = fixture(); f.options.readiness.fallback = { store, savedRunIds: [waf.report.result.runId] };
    f.options.readiness.currentScenarioDigests = { 'waf-custom': waf.report.result.observedConfigDigest };
    const r = await runAt15Acceptance(f.options);
    expect(r.report!.claims.fallbackAvailable.verified).toBe(false);
    expect(r.report!.claims.interviewVerified.verified).toBe(false); expect(r.report!.claims.workshopVerified.verified).toBe(false);
  });
  it('the actual fixed timeline retains missing stages and saved labels without resetting time', async () => {
    const f = fixture(); const { clock } = f; const views: InterviewStageView[] = [];
    f.options.interview = { mode: 'fixture', storefronts: { run: async () => ({ mode: 'fixture', deploymentVerified: false }) }, drivers: {}, analyticsInput: () => [], fallbackAvailable: () => true, onStage: v => views.push(v) };
    const pending = runAt15Acceptance(f.options);
    for (let i = 0; i < INTERVIEW_STAGES.length; i++) {
      await vi.waitFor(() => expect(views).toHaveLength(i + 1));
      await new Promise(resolve => setImmediate(resolve));
      clock.advance(INTERVIEW_STAGES[i]!.endMs - clock.now());
    }
    const result = await pending; const run = result.interview!;
    expect(result.records[1]!.outcome).toBe('failed');
    expect(result.records[1]!.requestsUsed).toBe(f.calls.length);
    expect(result.report!.claims.interviewVerified.verified).toBe(false);
    expect(run.durationMs).toBe(300000); expect(run.requestsUsed).toBe(0); expect(run.interviewVerified).toBe(false);
    expect(views.map(v => v.startMs)).toEqual([0, 45000, 105000, 165000, 240000]);
    expect(run.stages.every(s => s.outcome !== 'verified' && s.fallbackLabel === 'SAVED EVIDENCE')).toBe(true);
    expect(run.stages[3]!.finishedMs - run.stages[3]!.startedMs).toBe(75000);
    const record = AcceptanceSchema.parse({ schemaVersion: 1, id: 'AT-15C', mode: 'fixture', requirements: ['15.8', '15.9'], runId: randomUUID(), releaseDigest: digest, observedConfigDigest: null,
      assertions: [{ name: 'Missing live stages cannot claim readiness', passed: !run.interviewVerified && run.stages.every(s => s.outcome !== 'verified'), evidenceIds: [] }, { name: 'Fixed cumulative time and request caps', passed: run.durationMs <= 300000 && run.requestsUsed <= 100, evidenceIds: [] }], requestsUsed: run.requestsUsed, durationMs: run.durationMs, outcome: 'passed' });
    expect(record.mode).toBe('fixture');
  });
});
