import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors, type TrustedScope } from '../packages/demo-core/src/trusted-collectors.js';
import { apiShieldModule, runApiShield } from '../packages/demo-core/src/api-shield.js';
import { PolicySignalSchema, policyRequest } from '../packages/demo-core/src/api-shield-proof.js';
import { digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { apiOptions, fixtureIO, time, end } from './api-shield-fixtures.js';
import { labConfig } from './fixtures/lab.js';
const ledgers: BudgetLedger[] = [];
afterEach(() => ledgers.splice(0).forEach(ledger => ledger.stop()));
const ray = '1234567890abcdef';
function fixture() {
  const config = labConfig(); config.liveOptIn = true;
  const options = apiOptions(); options.policy.beforeOrigin = config.environments[0].origin; options.policy.afterOrigin = config.environments[1].origin;
  options.policy.authorizedCertificate.hostname = 'after.example.test';
  const scope: TrustedScope = { role: 'after', hostname: 'after.example.test', scenarioId: 'api-shield', runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64), start: time, end };
  const rule: { id: string; expression: string; enabled: boolean; action: string } = { id: options.policy.policyId, expression: apiShieldModule(options.policy).expression, enabled: true, action: 'block' };
  const event = { datetime: time, rayName: ray, action: 'block', source: 'firewallrules', ruleId: rule.id, clientRequestHTTPHost: scope.hostname };
  const events = [event]; let clock = Date.parse(end); let denyRule = false;
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  let paused: { response: Promise<Response>; started: () => void } | null = null;
  const ruleResponse = () => Response.json({ success: true, result: { id: 'e'.repeat(32), version: '1', phase: 'http_request_firewall_custom', rules: [rule] } });
  function pauseRead() {
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<Response>(resolve => { release = () => resolve(ruleResponse()); });
    paused = { response, started }; return { ready, release };
  }
  const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)),
    now: () => clock, credentials: { reader: 'fixture-distinct-reader-credential', collector: 'fixture-distinct-collector-credential', runner: 'fixture-distinct-runner-credential' },
    dispatch: async url => {
      if (new URL(url).pathname.endsWith('/graphql')) return Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: events }] } } });
      if (paused) { const held = paused; paused = null; held.started(); return held.response; }
      return denyRule ? new Response('private denial', { status: 403 }) : ruleResponse();
    } });
  const request = () => ({ ...policyRequest(scope.runId, 'api-shield', options.policy.afterOrigin, 'after', '/api', 'missing', null), requestId: scope.requestId });
  return { collector, scope, options, event, events, rule, request, pauseRead, setClock: (value: number) => { clock = value; }, deny: () => { denyRule = true; } };
}
describe('exact mTLS rule events retain unknown certificate facts', () => {
  it('uses an independently read exact rule, then the actual scoped event', async () => {
    const f = fixture(); const snapshot = await f.collector.mtlsPolicy(f.options.policy, undefined, f.scope.runId);
    const result = await f.collector.policyAttribution(f.request(), f.scope, `${ray}-DFW`);
    expect(result.state).toBe('observed'); expect(result.value?.policySignal).toMatchObject({ source: 'cloudflare-mtls-rule-event',
      policyId: f.event.ruleId, certificate: 'unknown', verified: null, revoked: null, fingerprint: null, action: 'block',
      observedConfigDigest: digestValue(snapshot.value!.readback) });
    expect(result.entitlement).toBe('unknown'); expect(result.mode).toBe('fixture');
  });
  it.each(['no-read', 'disabled', 'expression', 'rule-id', 'source', 'action', 'ray', 'host', 'time', 'duplicate', 'multiple', 'truncated', 'stale', 'new-run', 'first-foreign-run', 'unbound', 'failed-refresh', 'mutable-return'] as const)('does not qualify %s observations', async fault => {
    const f = fixture();
    if (fault === 'disabled') f.rule.enabled = false;
    if (fault === 'expression') f.rule.expression = 'true';
    const snapshot = fault === 'no-read' ? null : await f.collector.mtlsPolicy(f.options.policy, undefined, fault === 'unbound' ? undefined : f.scope.runId);
    if (fault === 'first-foreign-run') f.scope.runId = randomUUID();
    if (fault === 'rule-id') f.event.ruleId = '9'.repeat(32);
    if (fault === 'source') f.event.source = 'waf';
    if (fault === 'action') f.event.action = 'challenge';
    if (fault === 'ray') f.event.rayName = '9'.repeat(16);
    if (fault === 'host') f.event.clientRequestHTTPHost = 'before.example.test';
    if (fault === 'time') f.event.datetime = '2026-11-03T07:38:00.000Z';
    if (fault === 'duplicate') f.events.push({ ...f.event });
    if (fault === 'multiple') f.events.push({ ...f.event, source: 'waf' });
    if (fault === 'truncated') while (f.events.length < 100) f.events.push({ ...f.event });
    if (fault === 'stale') { f.scope.start = '2026-11-04T07:39:00.000Z'; f.scope.end = '2026-11-04T07:39:01.000Z'; f.setClock(Date.parse(f.scope.end)); f.event.datetime = f.scope.start; }
    if (fault === 'new-run') { await f.collector.policyAttribution(f.request(), f.scope, ray); f.scope.runId = randomUUID(); }
    if (fault === 'failed-refresh') { f.deny(); await f.collector.mtlsPolicy(f.options.policy, undefined, f.scope.runId); }
    if (fault === 'mutable-return') { snapshot!.value!.readback!.policyId = '9'.repeat(32); f.event.ruleId = '9'.repeat(32); }
    const result = await f.collector.policyAttribution(f.request(), f.scope, ray);
    expect(result.value?.policySignal ?? null).toBeNull();
  });
  it('cannot resurrect an older success after a newer denied refresh', async () => {
    const f = fixture(); const held = f.pauseRead();
    const old = f.collector.mtlsPolicy(f.options.policy, undefined, f.scope.runId); await held.ready;
    f.deny(); expect((await f.collector.mtlsPolicy(f.options.policy, undefined, f.scope.runId)).value).toBeNull();
    held.release(); expect((await old).value).toBeNull();
    expect((await f.collector.policyAttribution(f.request(), f.scope, ray)).value?.policySignal ?? null).toBeNull();
  });
  it.each(['verified', 'revoked', 'fingerprint', 'certificate', 'action', 'digest', 'ray', 'time'] as const)('cannot smuggle inferred %s facts into the event variant', field => {
    const event: Record<string, unknown> = { product: 'mtls', policyId: 'b'.repeat(32), hostname: 'after.lab.example', path: '/api', certificate: 'unknown',
      verified: null, revoked: null, fingerprint: null, action: 'block', source: 'cloudflare-mtls-rule-event', observedConfigDigest: 'a'.repeat(64), rayId: ray, eventTime: time };
    if (field === 'verified') event.verified = false;
    if (field === 'revoked') event.revoked = false;
    if (field === 'fingerprint') event.fingerprint = 'a'.repeat(64);
    if (field === 'certificate') event.certificate = 'missing';
    if (field === 'action') event.action = 'allow';
    if (field === 'digest') delete event.observedConfigDigest;
    if (field === 'ray') delete event.rayId;
    if (field === 'time') delete event.eventTime;
    expect(PolicySignalSchema.safeParse(event).success).toBe(false);
  });
  it.each(['qualified', 'digest', 'ray', 'time', 'unhealthy', 'gap', 'missing-ref', 'missing-invalid'] as const)('requires rule, request, coverage and every control: %s', async fault => {
    const options = apiOptions(); if (fault === 'missing-invalid') options.policy.invalidCertificateRef = null;
    const io = fixtureIO(options, (flow, request) => {
      if (request.role !== 'after' || request.case === 'authorized') return;
      flow.observation.rayId = ray;
      flow.signal = { product: 'mtls', policyId: options.policy.policyId, hostname: 'after.lab.example', path: '/api', certificate: 'unknown',
        verified: null, revoked: null, fingerprint: null, action: 'block', source: 'cloudflare-mtls-rule-event', observedConfigDigest: digestValue(options.readback), rayId: ray, eventTime: time };
      if (fault === 'digest') flow.signal.observedConfigDigest = '9'.repeat(64);
      if (fault === 'ray') flow.signal.rayId = '9'.repeat(16);
      if (fault === 'time') flow.signal.eventTime = end;
      if (fault === 'unhealthy') flow.coverage.healthy = false;
      if (fault === 'gap') flow.coverage.gaps.push('Known producer gap');
      if (fault === 'missing-ref') flow.originEvidence = [];
    });
    const result = await runApiShield(options, io);
    expect(result.decision.outcome).toBe(fault === 'qualified' ? 'verified' : 'inconclusive');
    if (fault === 'missing-invalid') expect(result.decision.missingProof.join()).toContain('invalid-certificate');
  });
});
