import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors, type TrustedCollectorsOptions, type TrustedScope } from '../packages/demo-core/src/trusted-collectors.js';
import { policyRequest, PolicySignalSchema } from '../packages/demo-core/src/api-shield-proof.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import { evidenceView } from '../packages/demo-core/src/evidence-view.js';
import { labConfig } from './fixtures/lab.js';

const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.stop()); vi.restoreAllMocks(); });
const start = '2026-11-04T10:00:00.000Z'; const end = '2026-11-04T10:00:01.000Z'; const ray = '1234567890abcdef';
function fixture(maxReads = 24) {
  const config = labConfig(); config.liveOptIn = true;
  config.demonstrations = { access: { applicationId: '1'.repeat(32), policyId: '2'.repeat(32), audience: '3'.repeat(64),
    beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin,
    capability: 'available', enabled: true, baselineExcluded: true, path: '/admin', serviceTokenRef: 'service-token:lab-only' } };
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const request = policyRequest(randomUUID(), 'access', config.environments[1].origin, 'after', '/admin', 'missing', null);
  const scope: TrustedScope = { role: 'after', hostname: 'after.example.test', scenarioId: 'access', runId: request.runId,
    requestId: request.requestId, releaseDigest: config.environments[1].releaseDigest, start, end };
  const row: Record<string, unknown> = { action: 'login', allowed: false, app_domain: 'after.example.test/admin', app_uid: '1'.repeat(32),
    created_at: '2026-11-04T10:00:00.500Z', ray_id: ray, user_email: 'private-person@example.invalid',
    ip_address: '203.0.113.17', connection: 'PRIVATE-CONNECTION', assertion: 'PRIVATE-ASSERTION' };
  const state = { rows: [row], page: { page: 1, total_pages: 1 } as { page: number; total_pages: number; cursor?: string } | undefined, status: 200, redirect: false };
  const calls: { url: string; init: RequestInit }[] = [];
  const options: TrustedCollectorsOptions = { config, ledger, mode: 'fixture', maxReads,
    observedOwnedResources: new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)),
    credentials: { reader: 'offline-access-reader-credential', collector: 'offline-access-collector-credential', runner: 'offline-access-runner-credential' },
    now: () => Date.parse(end), dispatch: async (url, init) => {
      calls.push({ url, init });
      if (state.redirect) return new Response(null, { status: 302, headers: { location: 'https://other.invalid/private' } });
      if (state.status !== 200) return new Response('private-person@example.invalid PRIVATE-ASSERTION', { status: state.status });
      return Response.json({ success: true, result: state.rows, ...(state.page ? { result_info: state.page } : {}) });
    } };
  return { config, ledger, request, scope, row, state, calls, options, collector: createTrustedCollectors(options) };
}
describe('pinned Access authentication audit API: facts without invented policy proof', () => {
  it('meters the exact account endpoint and emits only a unique sanitized app/Ray/time event', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    const result = await f.collector.policyAttribution(f.request, f.scope, `${ray}-DFW`);
    expect(result.state).toBe('unsupported'); expect(result.permission).toBe('granted'); expect(result.entitlement).toBe('unknown');
    expect(result.value?.edge).toBeNull(); expect(result.value?.policySignal).toBeNull();
    expect(result.value?.accessAuthentication).toMatchObject({ kind: 'access-authentication', rayId: ray, applicationId: '1'.repeat(32),
      hostname: 'after.example.test', path: '/admin', allowed: false, complete: true, policyId: null, audience: null, identity: 'unknown' });
    const serialized = JSON.stringify(result);
    for (const privateValue of ['private-person', '203.0.113.17', 'PRIVATE-CONNECTION', 'PRIVATE-ASSERTION', ...Object.values(f.options.credentials)]) expect(serialized).not.toContain(privateValue);
    expect(f.calls).toHaveLength(1); expect(f.ledger.snapshot.requestsUsed).toBe(1); expect(f.collector.readsUsed).toBe(1);
    const url = new URL(f.calls[0]!.url);
    expect(url.origin).toBe(f.config.apiOrigin); expect(url.pathname).toBe(`/client/v4/accounts/${f.config.accountId}/access/logs/access_requests`);
    expect(url.searchParams.get('since')).toBe(start); expect(url.searchParams.get('until')).toBe(end);
    expect(url.searchParams.get('page')).toBe('1'); expect(url.searchParams.get('per_page')).toBe('100');
    expect([...url.searchParams.keys()].some(key => /token|secret|email|identity/i.test(key))).toBe(false);
    expect(f.calls[0]!.init.method).toBe('GET'); expect(f.calls[0]!.init.redirect).toBe('manual'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['app', 'domain', 'ray', 'time', 'missing-time', 'missing-domain'] as const)('rejects a wrong or absent %s join', async fault => {
    const f = fixture();
    if (fault === 'app') f.row.app_uid = '9'.repeat(32);
    if (fault === 'domain') f.row.app_domain = 'other.example.test/admin';
    if (fault === 'ray') f.row.ray_id = '9'.repeat(16);
    if (fault === 'time') f.row.created_at = '2026-11-04T10:00:02.000Z';
    if (fault === 'missing-time') delete f.row.created_at;
    if (fault === 'missing-domain') delete f.row.app_domain;
    const result = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(result.state).toBe('unknown'); expect(result.value).toBeNull(); expect(f.calls).toHaveLength(1);
  });
  it('does not deduplicate an ambiguous Ray into proof', async () => {
    const f = fixture(); f.state.rows.push({ ...f.row });
    const result = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(result.state).toBe('mismatch'); expect(result.value).toBeNull(); expect(result.gaps.join()).toContain('Ambiguous');
  });
  it.each(['missing', 'more', 'cap', 'cursor', 'empty-cursor'] as const)('retains explicit incomplete source state: %s', async fault => {
    const f = fixture();
    if (fault === 'missing') f.state.page = undefined;
    if (fault === 'cursor' || fault === 'empty-cursor') f.state.page = { page: 1, total_pages: 1, cursor: fault === 'cursor' ? 'more-records' : '' };
    if (fault === 'more') f.state.page = { page: 1, total_pages: 2 };
    if (fault === 'cap') f.state.rows = Array.from({ length: 100 }, (_, index) => ({ ...f.row, ray_id: index === 0 ? ray : index.toString(16).padStart(16, '0') }));
    const result = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(result.state).toBe('unknown'); expect(result.value?.accessAuthentication?.complete).toBe(false);
    expect(result.value?.policySignal).toBeNull(); expect(f.calls).toHaveLength(1);
  });
  it.each([401, 403])('keeps %i permission denial separate from entitlement and behavior', async status => {
    const f = fixture(); f.state.status = status;
    const result = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(result.state).toBe('unknown'); expect(result.permission).toBe('denied'); expect(result.entitlement).toBe('unknown'); expect(result.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain('PRIVATE-ASSERTION');
  });
  it('does not turn allowed=true, unknown action text or missing fields into identity proof', async () => {
    const f = fixture(); f.row.allowed = true; f.row.action = 'PRIVATE-ACTION-CANARY';
    const result = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(result.value?.accessAuthentication).toMatchObject({ allowed: true, authenticationAction: 'unknown', policyId: null, audience: null, identity: 'unknown' });
    expect(result.value?.policySignal).toBeNull(); expect(PolicySignalSchema.safeParse(result.value?.accessAuthentication).success).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE-ACTION-CANARY');
    delete f.row.allowed;
    expect((await f.collector.policyAttribution(f.request, f.scope, ray)).value?.accessAuthentication?.allowed).toBeNull();
  });
  it('does not adopt invented service/policy/audience fields from REST audit rows', async () => {
    const f = fixture(); f.row.policyId = '2'.repeat(32); f.row.audience = '3'.repeat(64);
    f.row.common_name = 'PRIVATE-CLIENT-ID.access'; f.row.sub = ''; f.row.service_token_id = 'PRIVATE-TOKEN-ID';
    const r = await f.collector.policyAttribution(f.request, f.scope, ray);
    expect(r.value?.accessAuthentication).toMatchObject({ policyId: null, audience: null, identity: 'unknown' });
    expect(r.value?.policySignal).toBeNull();
    expect(JSON.stringify(r)).not.toContain('PRIVATE-CLIENT-ID'); expect(JSON.stringify(r)).not.toContain('PRIVATE-TOKEN-ID');
  });
  it('persists neutral evidence only as scoped Cloudflare authentication facts', async () => {
    const f = fixture(); const result = await f.collector.policyAttribution(f.request, f.scope, ray); const payload = result.value!.accessAuthentication!;
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: f.scope.runId, scenarioId: 'access' as const, targetRole: 'after' as const,
      requestId: f.scope.requestId, observedAt: result.observedAt, source: 'cloudflare' as const, payload };
    const stored = makeArtifact(artifact).artifact; expect(stored.payload).toEqual(payload);
    const view = evidenceView({ runId: f.scope.runId, scenarioId: 'access', mode: 'fixture', startedAt: start, endedAt: end,
      releaseDigest: f.scope.releaseDigest, hosts: { before: 'before.example.test', after: 'after.example.test' }, running: false, truncated: false }, [], [stored], Date.parse(end));
    const after = view.roles.find(role => role.role === 'after')!;
    expect(after.edgeEvents).toBeNull(); expect(after.rules).toBeNull(); expect(after.actions).toEqual([]);
    expect(() => makeArtifact({ ...artifact, source: 'verification' })).toThrow();
    expect(() => makeArtifact({ ...artifact, targetRole: 'before' })).toThrow();
    expect(() => makeArtifact({ ...artifact, requestId: null })).toThrow();
    expect(() => makeArtifact({ ...artifact, scenarioId: 'waf-custom' })).toThrow();
  });
  it('performs no lookup for absent/invalid correlation, foreign scope or baseline', async () => {
    const f = fixture();
    expect((await f.collector.policyAttribution(f.request, f.scope, null)).state).toBe('unsupported');
    expect((await f.collector.policyAttribution(f.request, f.scope, 'invalid')).state).toBe('unknown');
    await expect(f.collector.policyAttribution({ ...f.request, requestId: randomUUID() }, f.scope, ray)).rejects.toThrow('Foreign');
    const before = policyRequest(f.scope.runId, 'access', f.config.environments[0].origin, 'before', '/admin', 'baseline', null);
    expect((await f.collector.policyAttribution(before, { ...f.scope, role: 'before', hostname: 'before.example.test', requestId: before.requestId }, ray)).state).toBe('unsupported');
    expect(f.calls).toHaveLength(0);
  });
  it('bounds reads and refuses redirects or an implicit fetch fallback', async () => {
    const f = fixture(1); await f.collector.policyAttribution(f.request, f.scope, ray);
    expect((await f.collector.policyAttribution(f.request, f.scope, ray)).state).toBe('unknown'); expect(f.calls).toHaveLength(1);
    const redirect = fixture(); redirect.state.redirect = true;
    expect((await redirect.collector.policyAttribution(redirect.request, redirect.scope, ray)).state).toBe('unknown'); expect(redirect.calls).toHaveLength(1);
    const absent = fixture(); const options = { ...absent.options }; delete options.dispatch;
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    expect((await createTrustedCollectors(options).policyAttribution(absent.request, absent.scope, ray)).state).toBe('unknown'); expect(fetch).not.toHaveBeenCalled();
  });
  it('returns unknown without dispatch after cancellation or an oversized result', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect((await f.collector.policyAttribution(f.request, f.scope, ray, controller.signal)).state).toBe('unknown'); expect(f.calls).toHaveLength(0);
    f.state.rows = Array.from({ length: 101 }, () => ({ ...f.row }));
    expect((await f.collector.policyAttribution(f.request, f.scope, ray)).state).toBe('unknown'); expect(f.calls).toHaveLength(1);
  });
});
