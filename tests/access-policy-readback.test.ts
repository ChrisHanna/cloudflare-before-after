import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors, observedAccessSnapshot } from '../packages/demo-core/src/trusted-collectors.js';
import { AccessApplicationSchema, exactAccessTarget, effectiveAccessTargets } from '../packages/demo-core/src/access-policy-readback.js';
import { labConfig } from './fixtures/lab.js';

const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.stop()); vi.restoreAllMocks(); });
function fixture(maxReads = 24, kind: 'account' | 'user' | null = 'account') {
  const config = labConfig(); config.liveOptIn = true; if (kind) config.credentials.accessReaderTokenKind = kind;
  const policy = { applicationId: '1'.repeat(32), policyId: '2'.repeat(32), audience: '3'.repeat(64),
    beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin,
    capability: 'available' as const, enabled: true, baselineExcluded: true, path: '/admin' as const, serviceTokenRef: 'service-token:lab-only' };
  const tokenId = '4'.repeat(32); const clientId = 'SYNTHETIC-CLIENT-ID.access';
  config.demonstrations = { access: policy, serviceToken: { ref: policy.serviceTokenRef, id: tokenId, clientIdRef: 'env:SYNTHETIC_CLIENT_ID', clientSecretRef: 'env:SYNTHETIC_CLIENT_SECRET' } };
  const app: Record<string, unknown> = { id: policy.applicationId, domain: 'after.example.test/admin', aud: policy.audience, type: 'self_hosted' };
  const rule: Record<string, unknown> = { id: policy.policyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] };
  const token: Record<string, unknown> = { id: tokenId, client_id: clientId, expires_at: '2026-11-06T00:00:00.000Z', name: 'PRIVATE-NAME', client_secret: 'PRIVATE-SECRET' };
  const readerId = '6'.repeat(32); const grant: Record<string, unknown> = { id: readerId, status: 'active', policies: [{ effect: 'allow', permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }], resources: { [`com.cloudflare.api.account.${config.accountId}`]: '*' as unknown } }] };
  const state = { grant, extra: {} as Record<string, unknown>, apps: [app], rules: [rule], token, page: { page: 1, total_pages: 1 } as unknown, status: 200, now: Date.parse('2026-11-05T00:00:00.000Z'), wait: null as null | (() => Promise<void>) };
  const ledger = new BudgetLedger(); ledgers.push(ledger); const calls: string[] = [];
  const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', maxReads,
    observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)),
    credentials: { reader: 'synthetic-only-reader-key', collector: 'synthetic-only-collector-key', runner: 'synthetic-only-runner-key' }, now: () => state.now,
    dispatch: async url => { calls.push(url); if (url.endsWith('/tokens/verify')) return Response.json({ success: true, result: { id: readerId, status: 'active' } });
      if (url.endsWith(`/tokens/${readerId}`)) return Response.json({ success: true, result: state.grant });
      if (state.wait) await state.wait(); return Response.json({ success: state.status === 200,
      result: url.includes('/service_tokens/') ? state.token : url.includes('/policies?') ? state.rules : state.apps, result_info: state.page, ...state.extra }, { status: state.status }); } });
  return { config, policy, tokenId, clientId, app, rule, state, ledger, calls, collector };
}
describe('Access effective scope, separate from shared non-Access parsers', () => {
  it.each(['self_hosted_domains', 'destinations'])('retains the real %s Before /admin regression and changes its fingerprint', async field => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const minimal = await f.collector.accessPolicy(f.policy, f.tokenId);
    f.app[field] = field === 'destinations' ? [{ type: 'public', uri: 'before.example.test/admin' }] : ['before.example.test/admin'];
    const expanded = await f.collector.accessPolicy(f.policy, f.tokenId);
    expect(minimal.state).toBe('observed'); expect(minimal.value?.readback?.baselineExcluded).toBe(true);
    expect(expanded.state).toBe('mismatch'); expect(expanded.value?.readback).toBeNull();
    expect(expanded.value?.functionalDigest).not.toBe(minimal.value?.functionalDigest);
    expect(f.calls).toHaveLength(6); expect(fetch).not.toHaveBeenCalled();
  });
  it('supports exact public destinations and vendor destination-over-legacy precedence', async () => {
    const f = fixture(); f.app.destinations = [{ type: 'public', uri: 'after.example.test/admin' }];
    f.app.self_hosted_domains = ['before.example.test/admin'];
    const result = await f.collector.accessPolicy(f.policy, f.tokenId);
    expect(result.state).toBe('observed'); expect(result.value?.readback?.baselineExcluded).toBe(true);
    expect(effectiveAccessTargets(AccessApplicationSchema.parse(f.app))).toEqual([{ hostname: 'after.example.test', path: '/admin' }]);
  });
  it.each(['*.example.test/admin', 'after.example.test/*', 'https://after.example.test/admin', 'after.example.test:443/admin',
    'after.example.test/admin?x=1', 'after.example.test/admin#x', 'after.example.test/%61dmin', 'after.example.test/a/../admin', 'after.example.test//admin'])('refuses unsupported target %s', target => {
    expect(exactAccessTarget(target)).toBeNull();
  });
  it('retains auth-setting drift in the functional fingerprint', async () => {
    const f = fixture(); const original = await f.collector.accessPolicy(f.policy, f.tokenId);
    f.app.session_duration = '1h'; const changed = await f.collector.accessPolicy(f.policy, f.tokenId);
    expect(changed.state).toBe('observed'); expect(changed.value?.functionalDigest).not.toBe(original.value?.functionalDigest);
  });
  it.each(['private', 'wildcard', 'empty', 'duplicate', 'worker', 'warp', 'single-header', 'unknown-flag'])('does not complete %s scope', async fault => {
    const f = fixture();
    if (fault === 'private') f.app.destinations = [{ type: 'private', hostname: 'before.example.test' }];
    if (fault === 'wildcard') f.app.destinations = [{ type: 'public', uri: '*.example.test/admin' }];
    if (fault === 'empty') f.app.destinations = [];
    if (fault === 'duplicate') f.app.destinations = [{ uri: 'after.example.test/admin' }, { uri: 'after.example.test/admin' }];
    if (fault === 'worker') f.app.type = 'worker';
    if (fault === 'warp') f.app.allow_authenticate_via_warp = true;
    if (fault === 'single-header') f.app.read_service_tokens_from_header = 'PRIVATE-HEADER';
    if (fault === 'unknown-flag') f.app.future_scope = 'PRIVATE-CANARY';
    const r = await f.collector.accessPolicy(f.policy, f.tokenId);
    expect(r.state).toBe('unsupported'); expect(r.value?.matches).toBe(false); expect(JSON.stringify(r)).not.toContain('PRIVATE');
  });
  it.each(['competing', 'inventory-cap', 'duplicate-id', 'missing-page', 'missing-total', 'more-pages', 'cursor', 'empty-cursor', 'bad-count', 'approval', 'bypass', 'wrong-token', 'require', 'missing-app'])('refuses %s', async fault => {
    const f = fixture();
    if (fault === 'competing') f.state.apps.push({ ...f.app, id: '5'.repeat(32), domain: 'before.example.test' });
    if (fault === 'inventory-cap') f.state.apps = Array.from({ length: 100 }, (_, i) => ({ ...f.app, id: i.toString(16).padStart(32, '0') }));
    if (fault === 'duplicate-id') f.state.apps.push({ ...f.app });
    if (fault === 'missing-page') f.state.page = undefined;
    if (fault === 'missing-total') f.state.page = { page: 1 };
    if (fault === 'cursor' || fault === 'empty-cursor') f.state.page = { page: 1, total_pages: 1, cursor: fault === 'cursor' ? 'more-records' : '' };
    if (fault === 'bad-count') f.state.page = { page: 1, total_pages: 1, count: 0, total_count: 2 };
    if (fault === 'more-pages') f.state.page = { page: 1, total_pages: 2 };
    if (fault === 'approval') f.rule.approval_required = true;
    if (fault === 'bypass') f.rule.decision = 'bypass';
    if (fault === 'wrong-token') f.rule.include = [{ service_token: { token_id: '6'.repeat(32) } }];
    if (fault === 'require') f.rule.require = [{ email: 'PRIVATE-PERSON@example.invalid' }];
    if (fault === 'missing-app') f.state.apps = [];
    expect((await f.collector.accessPolicy(f.policy, f.tokenId)).state).not.toBe('observed');
  });
});
describe('fresh in-memory UUID to Client ID mapping', () => {
  it.each(['messages', 'errors', 'resource_filtered', 'partial', 'metadata'])('F1 refuses warning/filter marker %s before scope credit', async field => {
    const f = fixture(); f.state.extra = { [field]: field === 'messages' || field === 'errors' ? [{ message: 'PRIVATE-WARNING-CANARY' }] : field === 'metadata' ? { resource_filtered: true } : true };
    const read = await f.collector.accessPolicy(f.policy, f.tokenId);
    expect(read.state).toBe('unknown'); expect(read.value).toBeNull();
    const snapshot = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' });
    expect(snapshot.state).toBe('unknown'); expect(snapshot.value).toBeNull(); expect(JSON.stringify({ read, snapshot })).not.toContain('PRIVATE-WARNING-CANARY');
  });
  it('reserves five first reads, then reuses only the current counted reader grant', async () => {
    const f = fixture(); const runId = randomUUID();
    const r = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId, phase: 'before' });
    expect(r.state).toBe('observed'); expect(f.calls).toHaveLength(5); expect(f.ledger.snapshot.requestsUsed).toBe(5); expect(f.collector.readsUsed).toBe(5);
    expect(f.calls[4]).toContain(`/access/service_tokens/${f.tokenId}`);
    expect(observedAccessSnapshot(r.value!, f.collector, f.state.now)?.clientId).toBe(f.clientId);
    expect(observedAccessSnapshot({ ...r.value! }, f.collector, f.state.now)).toBeNull();
    const other = fixture(); expect(observedAccessSnapshot(r.value!, other.collector, f.state.now)).toBeNull();
    const text = JSON.stringify(r); for (const canary of [f.clientId, 'PRIVATE-NAME', 'PRIVATE-SECRET']) expect(text).not.toContain(canary);
    const after = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId, phase: 'after' }); expect(after.state).toBe('observed');
    expect(f.calls).toHaveLength(8); expect(f.calls.filter(u => u.includes('/tokens/'))).toHaveLength(2);
    f.state.now += 120001; expect(observedAccessSnapshot(r.value!, f.collector, f.state.now)).toBeNull();
    expect((await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId, phase: 'after' })).value).toBeNull(); expect(f.calls).toHaveLength(8);
  });
  it.each(['account', 'user'] as const)('uses only the explicit %s token endpoints with the current reader', async kind => {
    const f = fixture(24, kind); const r = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' });
    expect(r.state).toBe(kind === 'account' ? 'observed' : 'unknown');
    if (kind === 'user') { expect(r.value).toBeNull(); expect(f.calls).toHaveLength(2); expect(f.config.credentials.accessReaderTokenKind).toBe('user'); }
    const prefix = kind === 'account' ? `/accounts/${f.config.accountId}/tokens` : '/user/tokens';
    expect(new URL(f.calls[0]!).pathname).toBe(`/client/v4${prefix}/verify`); expect(new URL(f.calls[1]!).pathname).toBe(`/client/v4${prefix}/${'6'.repeat(32)}`);
  });
  it('F1 rejects nominal broad user grants when effective principal visibility is unknown', async () => {
    const f = fixture(24, 'user');
    // The returned token grant is broad, but the user's own app/member scope is
    // deliberately absent. The visible app list cannot repair that missing proof.
    const r = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' });
    expect(r.state).toBe('unknown'); expect(r.value).toBeNull(); expect(f.calls).toHaveLength(2);
    expect(f.calls.some(url => url.includes('/access/apps'))).toBe(false); expect(f.config.credentials.accessReaderTokenKind).toBe('user');
  });
  it.each(['missing-kind', 'silent-filter', 'wrong-account', 'deny', 'wrong-action', 'wrong-id', 'inactive', 'condition', 'expired', 'projected'])('F1 refuses unqualified current reader %s', async fault => {
    const f = fixture(24, fault === 'missing-kind' ? null : 'account'); const account = `com.cloudflare.api.account.${f.config.accountId}`;
    if (fault === 'silent-filter') f.state.grant.policies = [{ effect: 'allow', resources: { [account]: { 'com.cloudflare.api.account.access.apps': f.policy.applicationId } }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }];
    if (fault === 'wrong-account') f.state.grant.policies = [{ effect: 'allow', resources: { 'com.cloudflare.api.account.ffffffffffffffffffffffffffffffff': '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }];
    if (fault === 'deny') f.state.grant.policies = [{ effect: 'deny', resources: { [account]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }];
    if (fault === 'wrong-action') f.state.grant.policies = [{ effect: 'allow', resources: { [account]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Workers Scripts Read' }] }];
    if (fault === 'wrong-id') f.state.grant.id = '8'.repeat(32);
    if (fault === 'inactive') f.state.grant.status = 'disabled';
    if (fault === 'condition') f.state.grant.condition = { request_ip: { in: ['203.0.113.1/32'] } };
    if (fault === 'expired') f.state.grant.expires_on = '2026-11-04T00:00:00.000Z';
    if (fault === 'projected') f.state.grant = { id: '6'.repeat(32), qualified: true };
    const runId = randomUUID(); const r = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId, phase: 'before' });
    expect(r.state).toBe('unknown'); expect(r.value).toBeNull(); expect(f.calls.length).toBeLessThanOrEqual(2);
    const used = f.calls.length; await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId, phase: 'after' }); expect(f.calls).toHaveLength(used);
  });
  it.each(['cap', 'denied', 'missing', 'expired', 'wrong-id', 'projected', 'cancelled', 'missing-approval', 'huge'])('does not map %s', async fault => {
    const f = fixture(fault === 'cap' ? 2 : 24); const controller = new AbortController();
    if (fault === 'denied') f.state.status = 403;
    if (fault === 'missing') delete f.state.token.client_id;
    if (fault === 'expired') f.state.token.expires_at = '2026-11-04T00:00:00.000Z';
    if (fault === 'wrong-id') f.state.token.id = '5'.repeat(32);
    if (fault === 'projected') f.state.token = { id: f.tokenId, expires_at: '2026-11-06T00:00:00.000Z', mapped: true };
    if (fault === 'cancelled') controller.abort();
    if (fault === 'missing-approval') delete f.config.demonstrations!.serviceToken!.id;
    if (fault === 'huge') f.state.token.client_id = 'x'.repeat(257);
    const collector = fault === 'missing-approval' ? createTrustedCollectors({ config: f.config, ledger: f.ledger, mode: 'fixture',
      observedOwnedResources: new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), credentials: { reader: 'synthetic-only-reader-key', collector: 'synthetic-only-collector-key', runner: 'synthetic-only-runner-key' },
      dispatch: async () => { throw new Error('Should not dispatch'); } }) : f.collector;
    const r = await collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' }, controller.signal);
    expect(r.value).toBeNull(); expect(r.state).not.toBe('observed'); if (['cap', 'cancelled', 'missing-approval'].includes(fault)) expect(f.calls).toHaveLength(0);
  });
  it('invalidates older visibility when a newer same-reader grant check fails', async () => {
    const f = fixture(); const old = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' });
    expect(old.state).toBe('observed'); f.state.grant.status = 'disabled';
    const fresh = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, { runId: randomUUID(), phase: 'before' });
    expect(fresh.value).toBeNull(); expect(observedAccessSnapshot(old.value!, f.collector, f.state.now)).toBeNull();
  });
  it('invalidates an old snapshot at refresh start, including a failed refresh', async () => {
    const f = fixture(); const ctx = { runId: randomUUID(), phase: 'before' as const };
    const first = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, ctx); expect(first.value).not.toBeNull();
    f.state.status = 403; await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, ctx);
    expect(observedAccessSnapshot(first.value!, f.collector, f.state.now)).toBeNull();
  });
  it('does not resurrect a superseded concurrent refresh', async () => {
    const f = fixture(); const ctx = { runId: randomUUID(), phase: 'before' as const }; let release!: () => void;
    let entered!: () => void; const ready = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
    f.state.wait = async () => { f.state.wait = null; entered(); await gate; };
    const slow = f.collector.accessIdentitySnapshot(f.policy, f.tokenId, ctx); await ready;
    const fast = await f.collector.accessIdentitySnapshot(f.policy, f.tokenId, ctx); release(); const stale = await slow;
    expect(fast.state).toBe('observed'); expect(stale.value).toBeNull();
    expect(observedAccessSnapshot(fast.value!, f.collector, f.state.now)).not.toBeNull();
  });
});
