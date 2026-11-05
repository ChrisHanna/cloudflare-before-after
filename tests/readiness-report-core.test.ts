import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CATALOG } from '../scenarios/catalog.js';
import { Redactor } from '../packages/contracts/src/redaction.js';
import { buildReadinessReport, ReadinessRecordStore, ReadinessReportSchema, renderReadinessHtml, type ReadinessOptions } from '../packages/demo-core/src/readiness-report-core.js';
import { deploymentFingerprint, evaluateDeployment } from '../packages/demo-core/src/deployment-verification-core.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { reviewDdosEvidence } from '../packages/demo-core/src/ddos-evidence.js';
import { WaitingRoomStateMachine } from '../packages/demo-core/src/waiting-room.js';
import { captureFor, deploymentFixture, digest, time, end } from './workshop-core-fixtures.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root() { const path = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'readiness-core-')); roots.push(path); return path; }
// Pure live-branch inputs are synthetic records, not deployed acceptance evidence.
function inputs(): ReadinessOptions {
  const f = deploymentFixture(); for (const p of f.probes) for (const op of p.operations) op.evidence.mode = 'live';
  const configurationDigest = deploymentFingerprint(f.state);
  const deployment = evaluateDeployment({ mode: 'live', expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, observedAt: end, startedAt: time, beforeObservedAt: time, afterObservedAt: end });
  const runId = randomUUID(); const machine = new WaitingRoomStateMachine(runId, 'live', { mode: 'live', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: digest });
  for (const [id, role] of [['session-1', 'before'], ['session-2', 'after'], ['session-3', 'after']] as const) machine.register(id, role);
  function observe(id: string, role: 'before' | 'after', queued: boolean, ms: number) {
    const requestId = randomUUID(); const observedAt = new Date(Date.parse(time) + ms).toISOString();
    machine.observe({ sessionId: id, requestId, observedAt, queue: queued, storefront: !queued, queueCookiePresent: true, cookieContinuity: true, receipts: queued ? [] : [{ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waiting-room', targetRole: role, producerId: `${role}-container`, sequence: ms + 1, observedAt, rayId: null, releaseDigest: digest, stage: 'entry' }] });
  }
  observe('session-1', 'before', false, 0); observe('session-2', 'after', false, 0); observe('session-3', 'after', true, 1); observe('session-2', 'after', false, 2); observe('session-3', 'after', false, 3);
  const selection = { source: 'firewallEventsAdaptive' as const, zoneId: 'a'.repeat(32), hostname: 'after.example.test', start: time, end, mode: 'live' as const, limit: 100 };
  const { limit: _limit, ...captureScope } = selection;
  const ddos = reviewDdosEvidence(selection, { ...captureScope, observedAt: end, sampling: 'complete', complete: true, ingestionDelayMs: 0, events: [{ datetime: time, rayName: '0123456789abcdef', source: 'l7ddos', action: 'block', ruleId: 'genuine-source-contract', clientRequestHTTPHost: 'after.example.test' }] });
  return { mode: 'live', scope: 'workshop', observedAt: end, releaseDigest: digest, configurationDigest, hostnames: ['before.example.test', 'after.example.test'], includedModules: CATALOG.map(m => m.id), excludedModules: [],
    core: { appliedInventoryDigest: digest, observedInventoryDigest: digest, reachableRoles: ['before', 'after'] }, deployment,
    captures: CATALOG.map(m => captureFor(m.id, 'live')), currentScenarioDigests: Object.fromEntries(CATALOG.map(m => [m.id, digest])), waitingRoom: machine.result(), ddos, setupMutations: 0, measured: { requestsUsed: 11, durationMs: 60000 } };
}
describe('readiness-claims and report core', () => {
  it('keeps deployed core separate but rejects readiness without independent audit', () => {
    const o = inputs(); const r = buildReadinessReport(o);
    expect(r.claims.coreDeployed.verified).toBe(true); expect(r.claims.deploymentVerified.verified).toBe(false);
    expect(r.claims.deploymentVerified.blockers).toContain('Complete independently scoped execution audit is missing or unqualified');
    expect(r.claims.workshopVerified.verified).toBe(false); expect(r.claims.interviewVerified.verified).toBe(false); expect(r.claims.fallbackAvailable.verified).toBe(false);
    expect(r.scenarios).toHaveLength(11);
  });
  it('cannot promote fixture, saved or core-WAF scope to broader live readiness', () => {
    const o = inputs(); o.mode = 'fixture'; o.captures = CATALOG.map(m => captureFor(m.id));
    const r = buildReadinessReport(o); expect(Object.entries(r.claims).filter(([id]) => id !== 'fallbackAvailable').every(([, c]) => !c.verified)).toBe(true);
    const scoped = inputs(); scoped.scope = 'core-waf'; scoped.includedModules = ['waf-custom']; scoped.captures = [captureFor('waf-custom', 'live')];
    scoped.excludedModules = CATALOG.filter(m => m.id !== 'waf-custom').map(m => ({ scenarioId: m.id, reason: 'Missing optional capability' }));
    const report = buildReadinessReport(scoped); expect(report.claims.deploymentVerified.verified).toBe(false); expect(report.claims.deploymentVerified.blockers).toContain('Complete independently scoped execution audit is missing or unqualified'); expect(report.claims.workshopVerified.verified).toBe(false); expect(report.claims.interviewVerified.verified).toBe(false);
  });
  it.each(['missing', 'duplicate', 'mismatch'] as const)('requires paired release proof even without selected scenarios: %s', fault => {
    const o = inputs(); o.includedModules = []; o.captures = [];
    if (fault === 'missing') o.deployment.probes = o.deployment.probes.filter(probe => probe.role !== 'after');
    if (fault === 'duplicate') o.deployment.probes.push(structuredClone(o.deployment.probes[0]!));
    if (fault === 'mismatch') o.deployment.probes[0]!.releaseDigest = 'f'.repeat(64);
    const report = buildReadinessReport(o);
    expect(report.claims.coreDeployed.verified).toBe(true);
    expect(report.claims.deploymentVerified.verified).toBe(false);
    expect(report.claims.deploymentVerified.blockers.join()).toMatch(/release/i);
  });
  it.each(['unknown-read', 'drift', 'old-scenario', 'missing-service', 'wrong-host', 'repair', 'release', 'queue', 'cleanup', 'missing-ddos'] as const)('blocks %s without changing deployed-core status', fault => {
    const o = inputs();
    if (fault === 'unknown-read') o.deployment.afterFingerprint = null;
    if (fault === 'drift') o.configurationDigest = 'f'.repeat(64);
    if (fault === 'old-scenario') o.currentScenarioDigests['waf-custom'] = 'f'.repeat(64);
    if (fault === 'missing-service') o.deployment.checks[0]!.passed = false;
    if (fault === 'wrong-host') o.hostnames[1] = 'wrong.example.test';
    if (fault === 'repair') o.setupMutations = 1;
    if (fault === 'release') o.releaseDigest = 'f'.repeat(64);
    if (fault === 'queue') { o.waitingRoom!.liveReadiness = false; o.waitingRoom!.outcome = 'inconclusive'; }
    if (fault === 'cleanup') o.captures[0]!.report.result.cleanup = 'incomplete';
    if (fault === 'missing-ddos') delete o.ddos;
    const r = buildReadinessReport(o); expect(r.claims.workshopVerified.verified).toBe(false); expect(r.claims.coreDeployed.verified).toBe(true); expect(r.claims.interviewVerified.verified).toBe(false);
  });
  it('requires genuine DDoS source evidence, not saved or generic blocks', () => {
    for (const fault of ['fixture', 'saved', 'empty', 'digest', 'outcome'] as const) {
      const o = inputs();
      if (fault === 'fixture' || fault === 'saved') o.ddos!.selection.mode = fault;
      if (fault === 'empty') o.ddos!.events = [];
      if (fault === 'digest') o.ddos!.artifactDigest = null;
      if (fault === 'outcome') o.ddos!.outcome = 'unavailable';
      expect(buildReadinessReport(o).claims.workshopVerified.verified).toBe(false);
    }
  });
  it('does not trust an interview flag without every timed live stage and browser proof', () => {
    const o = inputs(); o.interview = { mode: 'live', stages: [], requestsUsed: 0, durationMs: 0, sequenceCompleted: true, interviewVerified: true, exitCode: 0 };
    const r = buildReadinessReport(o); expect(r.claims.interviewVerified.verified).toBe(false); expect(r.claims.interviewVerified.blockers).toContain('waiting-room: required live stage proof or timing is incomplete');
  });
  it('keeps valid historical fallback independent from failed live readiness', () => {
    const path = root(); const store = new ReportStore(path, join(path, '.evidence')); const c = captureFor('waf-custom', 'live'); store.save(c.report, c.artifacts);
    const o = inputs(); o.deployment.deploymentVerified = false; o.captures = []; o.fallback = { store, savedRunIds: [c.report.result.runId], now: Date.parse(end) };
    const r = buildReadinessReport(o); expect(r.claims.deploymentVerified.verified).toBe(false); expect(r.claims.fallbackAvailable.verified).toBe(true); expect(r.fallbacks[0]).toMatchObject({ label: 'SAVED EVIDENCE', historicalOnly: false });
    o.currentScenarioDigests['waf-custom'] = 'f'.repeat(64); expect(buildReadinessReport(o).claims.fallbackAvailable.verified).toBe(false);
  });
  it('refuses persistence of caller-promoted readiness without an issued current audit', () => {
    const path = root(); const store = new ReadinessRecordStore(path, join(path, '.evidence'));
    const report = buildReadinessReport(inputs());
    report.claims.deploymentVerified = { verified: true, blockers: [] };
    expect(() => store.save(report, [])).toThrow('independent execution audit');
  });
  it('writes immutable checksum-checked readiness and AT records', () => {
    const path = root(); const store = new ReadinessRecordStore(path, join(path, '.evidence')); const r = buildReadinessReport(inputs());
    const at = { schemaVersion: 1 as const, id: 'AT-15A', mode: 'live' as const, requirements: ['15.1'], runId: r.id, releaseDigest: digest, observedConfigDigest: r.configurationDigest, assertions: [{ name: 'Synthetic evaluator fixture only', passed: true, evidenceIds: [] }], requestsUsed: 0, durationMs: 0, outcome: 'passed' as const };
    const file = store.save(r, [at]); expect(store.load(r.id)).toEqual({ report: r, acceptance: [at] }); expect(() => store.save(r, [at])).toThrow();
    expect(() => store.save(r, [{ ...at, runId: randomUUID() }])).toThrow('scope');
    const raw = JSON.parse(readFileSync(file, 'utf8')); raw.payload += ' '; writeFileSync(file, JSON.stringify(raw)); expect(() => store.load(r.id)).toThrow('integrity');
  });
  it('redacts known secrets in both readiness and AT records before persistence', () => {
    const path = root(); const secret = 'fixture-readiness-secret-canary';
    const store = new ReadinessRecordStore(path, join(path, '.evidence'), new Redactor([secret]));
    const r = buildReadinessReport(inputs()); r.claims.interviewVerified.blockers.push(secret);
    const at = { schemaVersion: 1 as const, id: 'AT-15C', mode: 'live' as const, requirements: ['15.9'], runId: r.id, releaseDigest: digest, observedConfigDigest: r.configurationDigest, assertions: [{ name: secret, passed: false, evidenceIds: [] }], requestsUsed: 0, durationMs: 0, outcome: 'failed' as const };
    const file = store.save(r, [at]); expect(readFileSync(file, 'utf8')).not.toContain(secret); expect(JSON.stringify(store.load(r.id))).not.toContain(secret);
    expect(() => store.save({ ...r, id: randomUUID() }, [{ ...at, outcome: 'passed' }])).toThrow();
  });
  it('renders clear text claims, scope, missing proof and escaped customer text', () => {
    const r = buildReadinessReport(inputs()); r.claims.interviewVerified.blockers.push('<script>private</script>');
    const html = renderReadinessHtml(r); expect(html).toContain('Incomplete'); expect(html).toContain('workshop'); expect(html).toContain('SAVED EVIDENCE'); expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
  });
  it('rejects duplicate module partitions and unknown report fields', () => {
    const o = inputs(); o.includedModules.push('waf-custom'); expect(() => buildReadinessReport(o)).toThrow('partition');
    expect(() => ReadinessReportSchema.parse({ ...buildReadinessReport(inputs()), token: 'private' })).toThrow();
  });
});
