import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors, compareTrustedReadbacks, type TrustedCollectorsOptions, type TrustedScope } from '../packages/demo-core/src/trusted-collectors.js';
import { apiShieldModule, type ApiShieldPolicy } from '../packages/demo-core/src/api-shield.js';
import type { AccessPolicy } from '../packages/demo-core/src/access-policy.js';
import { policyRequest } from '../packages/demo-core/src/api-shield-proof.js';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { CATALOG_SEED } from '../apps/storefront-worker/src/d1.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { labConfig } from './fixtures/lab.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';

const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.stop()); vi.restoreAllMocks(); });
const time = '2026-11-04T10:00:00.000Z'; const end = '2026-11-04T10:00:01.000Z';
function fixture() {
  const config = labConfig(); config.liveOptIn = true; config.credentials.accessReaderTokenKind = 'account';
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const scope: TrustedScope = { role: 'after', hostname: 'after.example.test', scenarioId: 'api-shield', runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64), start: time, end };
  const mtls: ApiShieldPolicy = { policyId: 'b'.repeat(32), beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin,
    capability: 'available', enabled: true, baselineExcluded: true, path: '/api', authorizedCertificate: { ref: 'certificate:lab-ok', hostname: scope.hostname, fingerprint: 'c'.repeat(64) }, invalidCertificateRef: 'certificate:lab-bad' };
  const access: AccessPolicy = { applicationId: '1'.repeat(32), policyId: '2'.repeat(32), audience: '3'.repeat(64), beforeOrigin: mtls.beforeOrigin, afterOrigin: mtls.afterOrigin,
    path: '/admin', capability: 'available', enabled: true, baselineExcluded: true, serviceTokenRef: 'service-token:lab-ok' };
  const tokenId = '4'.repeat(32);
  const receipts: Receipt[] = ['entry', 'completion'].map((stage, i) => ({ schemaVersion: 1, id: randomUUID(), runId: scope.runId, requestId: scope.requestId,
    scenarioId: scope.scenarioId, targetRole: scope.role, producerId: 'actual-container', sequence: i + 1, observedAt: time, rayId: null, releaseDigest: scope.releaseDigest, stage: stage as 'entry' | 'completion' }));
  const origin = { schemaVersion: 1, targetRole: scope.role, runId: scope.runId, scenarioId: scope.scenarioId, originCount: 1, receipts,
    coverage: { healthy: true, complete: true, gaps: [] as string[], windowStart: time, watermark: end, producerSequence: 2 as number | null } };
  const rule: { id: string; expression: string; enabled: boolean; action: string } = { id: mtls.policyId, expression: apiShieldModule(mtls).expression, enabled: true, action: 'block' };
  const rules = { id: '5'.repeat(32), phase: 'http_request_firewall_custom', version: '1', rules: [rule] };
  const apps = [{ id: access.applicationId, domain: `${scope.hostname}/admin`, aud: access.audience, type: 'self_hosted' }];
  const policies = [{ id: access.policyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }], exclude: [] as unknown[], require: [] as unknown[] }];
  const bindings = { bindings: [{ name: 'DB', type: 'd1', database_id: config.environments[1].d1Id }, { name: 'OBJECTS', type: 'r2_bucket', bucket_name: 'after-bucket' },
    { name: 'ORIGINS', type: 'durable_object_namespace', namespace_id: '6'.repeat(32), class_name: 'OriginContainer' }, { name: 'SECRET', type: 'secret_text', text: 'do-not-export-private' }] };
  const calls: { url: string; init: RequestInit }[] = [];
  const envelope = (result: unknown) => Response.json({ success: true, result, ...(Array.isArray(result) ? { result_info: { page: 1, total_pages: 1 } } : {}) });
  const dispatch: NonNullable<TrustedCollectorsOptions['dispatch']> = async (url, init) => {
    calls.push({ url, init }); const u = new URL(url);
    if (u.pathname.endsWith('/tokens/verify')) return envelope({ id: '8'.repeat(32), status: 'active' });
    if (u.pathname.endsWith(`/tokens/${'8'.repeat(32)}`)) return envelope({ id: '8'.repeat(32), status: 'active', policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${config.accountId}`]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }] });
    if (u.pathname === '/receipts') return Response.json(origin);
    if (u.pathname === '/internal/checkpoint') return Response.json({ healthy: true });
    if (u.pathname.endsWith('/entrypoint')) return envelope(rules);
    if (u.pathname.endsWith('/access/apps')) return envelope(apps);
    if (u.pathname.endsWith('/policies')) return envelope(policies);
    if (u.pathname.endsWith('/settings')) return envelope(bindings);
    throw new Error('Unplanned offline request');
  };
  const options: TrustedCollectorsOptions = { config, ledger, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)),
    mode: 'fixture', credentials: { reader: 'offline-reader-distinct-credential', collector: 'offline-collector-distinct-credential', runner: 'offline-runner-distinct-credential' }, dispatch, now: () => Date.parse(end) };
  return { options, scope, mtls, access, tokenId, origin, rules, apps, policies, bindings, calls, collector: createTrustedCollectors(options) };
}

describe('trusted collectors through actual guarded and metered adapters', () => {
  it('denies provider I/O by default; never falls back to global fetch', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Forbidden network'));
    const o = { ...f.options }; delete o.dispatch;
    const result = await createTrustedCollectors(o).workerBindings('after');
    expect(result.state).toBe('unknown'); expect(result.value).toBeNull(); expect(fetch).not.toHaveBeenCalled(); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it('reads named Worker bindings, strips secrets and fingerprints actual drift', async () => {
    const f = fixture(); const a = await f.collector.workerBindings('after');
    expect(a.state).toBe('observed'); expect(a.value?.bindings).toHaveLength(3); expect(a.value?.releaseDigest).toBeNull();
    expect(JSON.stringify(a)).not.toContain('do-not-export-private');
    const b = await f.collector.workerBindings('after');
    expect(compareTrustedReadbacks([a], [b], { start: time, end }).unchanged).toBe(true);
    expect(compareTrustedReadbacks([a], [b], { start: time, end }).deploymentVerified).toBe(false);
    f.bindings.bindings[0]!.database_id = 'foreign-db'; const c = await f.collector.workerBindings('after');
    expect(compareTrustedReadbacks([a], [c], { start: time, end }).historical).toBe(true);
    expect(f.collector.readsUsed).toBe(3); expect(f.options.ledger.snapshot.requestsUsed).toBe(3);
    expect(f.calls.every(c => c.init.method === 'GET' && c.init.redirect === 'manual')).toBe(true);
  });
  it('retains mode, timestamps, role and permission when checking readback drift', async () => {
    const f = fixture(); const a = await f.collector.workerBindings('after');
    expect(compareTrustedReadbacks([a], [{ ...a, state: 'unknown', value: null }], { start: time, end }).unchanged).toBe(false);
    expect(compareTrustedReadbacks([a, a], [a, a], { start: time, end }).historical).toBe(true);
    expect(compareTrustedReadbacks([a], [{ ...a, mode: 'live' }], { start: time, end }).unchanged).toBe(false);
    expect(compareTrustedReadbacks([a], [{ ...a, observedAt: '2026-11-03T00:00:00.000Z' }], { start: time, end }).historical).toBe(true);
  });
  it.each([401, 403])('keeps plain-text %s denial distinct from entitlement', async status => {
    const f = fixture(); const collector = createTrustedCollectors({ ...f.options, dispatch: async () => new Response('private canary', { status }) });
    const r = await collector.mtlsPolicy(f.mtls);
    expect(r.permission).toBe('denied'); expect(r.entitlement).toBe('unknown'); expect(r.value).toBeNull(); expect(JSON.stringify(r)).not.toContain('canary');
  });
  it('rejects missing provider pages and bounded-out inventories', async () => {
    const f = fixture(); const collector = createTrustedCollectors({ ...f.options, dispatch: async (url, init) => url.includes('/tokens/') ? f.options.dispatch!(url, init) : Response.json({ success: true, result: f.apps, result_info: { page: 1, total_pages: 2 } }) });
    const r = await collector.accessPolicy(f.access, f.tokenId);
    expect(r.state).toBe('unknown'); expect(r.value).toBeNull(); expect(f.options.ledger.snapshot.requestsUsed).toBe(3);
  });
  it('refuses paged reads without completeness metadata', async () => {
    const f = fixture(); const collector = createTrustedCollectors({ ...f.options, dispatch: async (url, init) => url.includes('/tokens/') ? f.options.dispatch!(url, init) : Response.json({ success: true, result: f.apps }) });
    const r = await collector.accessPolicy(f.access, f.tokenId);
    expect(r.state).toBe('unknown'); expect(r.gaps).toContain('Missing provider pages; no partial state accepted');
  });
  it('reads exact mTLS expression and actual rule priority without making a product signal', async () => {
    const f = fixture(); const a = await f.collector.mtlsPolicy(f.mtls);
    expect(a.state).toBe('observed'); expect(a.value?.matches).toBe(true); expect(a.value?.priority).toBe(0);
    f.rules.rules.unshift({ ...f.rules.rules[0]!, id: '7'.repeat(32), expression: '(http.host eq "other.example.test")' });
    const b = await f.collector.mtlsPolicy(f.mtls);
    expect(b.value?.priority).toBe(1); expect(b.value?.functionalDigest).not.toBe(a.value?.functionalDigest);
    f.rules.rules[1]!.expression = '(http.host eq "before.example.test")';
    const c = await f.collector.mtlsPolicy(f.mtls); expect(c.state).toBe('mismatch'); expect(c.value?.readback).toBeNull();
  });
  it.each(['action', 'enabled', 'fingerprint'])('rejects mTLS %s drift', async fault => {
    const f = fixture(); const rule = f.rules.rules[0]!;
    if (fault === 'action') rule.action = 'skip';
    if (fault === 'enabled') rule.enabled = false;
    if (fault === 'fingerprint') rule.expression = rule.expression.replace('c'.repeat(64), 'f'.repeat(64));
    expect((await f.collector.mtlsPolicy(f.mtls)).state).toBe('mismatch');
  });
  it('requires exact Access app, audience, complete policy and token ID readback', async () => {
    const f = fixture(); const r = await f.collector.accessPolicy(f.access, f.tokenId);
    expect(r.state).toBe('observed'); expect(r.value?.readback?.serviceTokenAllowed).toBe(true);
    expect((await f.collector.accessPolicy(f.access, null)).state).toBe('mismatch');
    f.apps[0]!.aud = 'f'.repeat(64);
    expect((await f.collector.accessPolicy(f.access, f.tokenId)).state).toBe('mismatch');
    expect(f.options.ledger.snapshot.requestsUsed).toBe(8);
  });
  it.each(['foreign-app', 'wrong-host', 'extra-policy', 'bypass', 'wrong-token', 'exclude', 'before-app'])('rejects Access %s', async fault => {
    const f = fixture();
    if (fault === 'foreign-app') f.apps[0]!.id = '9'.repeat(32);
    if (fault === 'wrong-host') f.apps[0]!.domain = 'before.example.test/admin';
    if (fault === 'extra-policy') f.policies.push({ ...f.policies[0]!, id: '9'.repeat(32) });
    if (fault === 'bypass') f.policies[0]!.decision = 'bypass';
    if (fault === 'wrong-token') f.policies[0]!.include[0]!.service_token.token_id = '9'.repeat(32);
    if (fault === 'exclude') f.policies[0]!.exclude.push({ everyone: {} });
    if (fault === 'before-app') f.apps.push({ ...f.apps[0]!, id: '9'.repeat(32), domain: 'before.example.test/admin' });
    expect((await f.collector.accessPolicy(f.access, f.tokenId)).state).not.toBe('observed');
  });
  it('joins complete origin receipts by role/run/request/release and spends two permits', async () => {
    const f = fixture(); const result = await f.collector.origin(f.scope);
    expect(result.state).toBe('observed'); expect(result.value?.requestEntered).toBe(true); expect(result.value?.requestCompleted).toBe(true); expect(result.value?.absenceProven).toBe(false);
    expect(f.options.ledger.snapshot.requestsUsed).toBe(2);
    expect(new Headers(f.calls[0]!.init.headers).get('authorization')).toBeNull();
    expect(new Headers(f.calls[1]!.init.headers).get('x-demo-run-token')).toBeNull();
  });
  it.each(['role', 'run', 'release', 'scenario', 'stale', 'duplicate'])('rejects foreign %s receipts', async fault => {
    const f = fixture(); const receipt = f.origin.receipts[0]!;
    if (fault === 'role') receipt.targetRole = 'before';
    if (fault === 'run') receipt.runId = randomUUID();
    if (fault === 'release') receipt.releaseDigest = 'f'.repeat(64);
    if (fault === 'scenario') receipt.scenarioId = 'access';
    if (fault === 'stale') receipt.observedAt = '2026-11-03T00:00:00.000Z';
    if (fault === 'duplicate') f.origin.receipts.push(receipt);
    const result = await f.collector.origin(f.scope); expect(result.state).toBe('mismatch'); expect(result.value).toBeNull();
  });
  it.each(['healthy', 'complete', 'gap', 'sequence', 'watermark', 'count'])('refuses negative proof without %s coverage', async fault => {
    const f = fixture(); f.origin.receipts = []; f.origin.originCount = 0;
    if (fault === 'healthy') f.origin.coverage.healthy = false;
    if (fault === 'complete') f.origin.coverage.complete = false;
    if (fault === 'gap') f.origin.coverage.gaps.push('Missing producer');
    if (fault === 'sequence') f.origin.coverage.producerSequence = null;
    if (fault === 'watermark') f.origin.coverage.watermark = time;
    if (fault === 'count') f.origin.originCount = 1;
    const result = await f.collector.origin(f.scope); expect(result.state).toBe('unknown'); expect(result.value?.absenceProven).toBe(false); expect(result.value?.originCount).toBeNull();
  });
  it.each(['gap', 'overflow', 'producers', 'duplicate-entry'])('does not trust healthy summaries with %s receipt faults', async fault => {
    const f = fixture();
    if (fault === 'gap') { f.origin.receipts[1]!.sequence = 3; f.origin.coverage.producerSequence = 3; }
    if (fault === 'overflow') f.origin.receipts[1]!.sequence = 3;
    if (fault === 'producers') f.origin.receipts[1]!.producerId = 'foreign-producer';
    if (fault === 'duplicate-entry') { f.origin.receipts.push({ ...f.origin.receipts[0]!, id: randomUUID(), sequence: 3 }); f.origin.coverage.producerSequence = 3; f.origin.originCount = 2; }
    const result = await f.collector.origin(f.scope);
    expect(result.value?.requestCompleted).toBe(false); expect(result.value?.absenceProven).toBe(false);
    if (fault !== 'duplicate-entry') expect(result.state).toBe('unknown');
  });
  it('allows negative coverage only for the exact request and full healthy window', async () => {
    const f = fixture(); const result = await f.collector.origin({ ...f.scope, requestId: randomUUID() });
    expect(result.value?.absenceProven).toBe(true); expect(result.value?.receipts).toEqual([]);
    await expect(f.collector.origin({ ...f.scope, hostname: 'before.example.test' })).rejects.toThrow('Foreign');
    await expect(f.collector.origin({ ...f.scope, end: '2026-11-03T10:00:00.000Z', start: '2026-11-03T10:00:00.000Z' })).rejects.toThrow('stale');
  });
  it('keeps Worker-only service success unknown, never manufactures service operations', async () => {
    const f = fixture(); const base = f.options.dispatch!;
    const collector = createTrustedCollectors({ ...f.options, dispatch: async (url, init) => new URL(url).pathname === '/internal/service-read' ? new Response('Worker says all services work', { headers: { 'x-lab-role': 'after', 'x-lab-release': 'a'.repeat(64), 'x-lab-services': 'd1,r2,container-completed' } }) : base(url, init) });
    f.origin.receipts = []; f.origin.originCount = 0;
    const r = await collector.serviceRead(f.scope);
    expect(r.state).toBe('unknown'); expect(r.value).toBeNull();
    expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it.each(['role', 'release', 'request'])('does not turn a successful foreign %s join into healthy service proof', async fault => {
    const f = fixture(); const base = f.options.dispatch!;
    if (fault === 'request') f.origin.receipts.forEach(r => { r.requestId = randomUUID(); });
    const collector = createTrustedCollectors({ ...f.options, dispatch: async (url, init) => new URL(url).pathname === '/internal/service-read' ? new Response('Synthetic shop', { headers: {
      'x-lab-role': fault === 'role' ? 'before' : 'after', 'x-lab-release': fault === 'release' ? 'f'.repeat(64) : 'a'.repeat(64) } }) : base(url, init) });
    const result = await collector.serviceRead(f.scope); expect(result.state).toBe('unknown'); expect(result.value).toBeNull();
  });
  it('collects actual Container-produced receipts without calling them D1/R2 proof', async () => {
    const f = fixture(); const actual: Receipt[] = [];
    const app = createContainerApp({ role: f.scope.role, scenarioId: f.scope.scenarioId, runId: f.scope.runId, producerId: 'real-offline-container', releaseDigest: f.scope.releaseDigest,
      internalSecret: 'offline-internal-credential-24-long', sendReceipt: async receipt => { actual.push(receipt); } });
    const scope = { ...f.scope, start: new Date(Date.now() - 1000).toISOString(), end: new Date().toISOString() };
    const base = f.options.dispatch!;
    const collector = createTrustedCollectors({ ...f.options, now: Date.now, dispatch: async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/internal/service-read') {
        const response = await app.request(await fixtureReservedRequest(new Request('http://container.internal/internal/render', { method: 'POST', headers: { authorization: 'Bearer offline-internal-credential-24-long', 'content-type': 'application/json' }, body: JSON.stringify({
          runId: scope.runId, requestId: scope.requestId, scenarioId: scope.scenarioId, targetRole: scope.role, rayId: null, operation: 'catalog', product: CATALOG_SEED,
          imageUrl: 'https://imagedelivery.net/owned/after-image/public', detail: 'Synthetic only', registration: null }) }), { producerId: 'real-offline-container', releaseDigest: f.scope.releaseDigest, internalSecret: 'offline-internal-credential-24-long' }));
        const payload = await response.json() as { html?: string };
        return new Response(payload.html ?? '', { status: response.status, headers: { 'x-lab-role': scope.role, 'x-lab-release': scope.releaseDigest } });
      }
      if (u.pathname === '/receipts') return Response.json({ schemaVersion: 1, targetRole: scope.role, runId: scope.runId, scenarioId: scope.scenarioId, originCount: actual.filter(r => r.stage === 'entry').length, receipts: actual,
        coverage: { healthy: true, complete: true, gaps: [], windowStart: scope.start, watermark: new Date().toISOString(), producerSequence: actual.length } });
      return base(url, init);
    } });
    const result = await collector.serviceRead(scope);
    expect(actual.map(r => r.stage)).toEqual(['entry', 'completion']); expect(result.state).toBe('unknown');
    expect(result.value).toBeNull(); // Container HTML lacks the authenticated D1/R2 read contract.
  });
  it('never promotes Ray-only or GraphQL event-only rows to TLS/Access signals', async () => {
    const f = fixture(); const request = { ...policyRequest(f.scope.runId, 'api-shield', f.mtls.afterOrigin, 'after', '/api', 'missing', null), requestId: f.scope.requestId };
    const collector = createTrustedCollectors({ ...f.options, dispatch: async () => Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: [{ datetime: time, rayName: '1234567890abcdef', action: 'block', source: 'firewallCustom', ruleId: f.mtls.policyId, clientRequestHTTPHost: f.scope.hostname }] }] } } }) });
    const r = await collector.policyAttribution(request, f.scope, '1234567890abcdef-DFW');
    expect(r.state).toBe('unsupported'); expect(r.value?.policySignal).toBeNull(); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
    const a = { ...policyRequest(f.scope.runId, 'access', f.access.afterOrigin, 'after', '/admin', 'missing', null), requestId: f.scope.requestId };
    expect((await collector.policyAttribution(a, { ...f.scope, scenarioId: 'access' }, null)).state).toBe('unsupported'); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
    await expect(collector.policyAttribution({ ...request, requestId: randomUUID() }, f.scope, '1234567890abcdef')).rejects.toThrow('Foreign');
  });
  it('stops reads at the collector cap, permit cap and cancellation; no free retries', async () => {
    const f = fixture(); const c = createTrustedCollectors({ ...f.options, maxReads: 1 });
    await c.workerBindings('after'); expect((await c.workerBindings('after')).state).toBe('unknown'); expect(f.calls).toHaveLength(1);
    const controller = new AbortController(); controller.abort();
    expect((await c.workerBindings('after', controller.signal)).state).toBe('unknown'); expect(f.calls).toHaveLength(1);
    const throttled = createTrustedCollectors({ ...f.options, dispatch: async () => new Response('retry denied', { status: 429 }) });
    expect((await throttled.workerBindings('after')).state).toBe('unknown'); expect(f.options.ledger.snapshot.requestsUsed).toBe(2);
  });
  it('cannot reset the shared ledger by making a new collector', async () => {
    const f = fixture(); const ledger = new BudgetLedger({ limits: { requests: 1, cleanupRequests: 0 } }); ledgers.push(ledger);
    expect((await createTrustedCollectors({ ...f.options, ledger }).workerBindings('after')).state).toBe('observed');
    expect((await createTrustedCollectors({ ...f.options, ledger }).workerBindings('after')).state).toBe('unknown');
    expect(f.calls).toHaveLength(1); expect(ledger.snapshot.requestsUsed).toBe(1);
  });
  it('rejects oversized JSON bodies without accepting partial provider state', async () => {
    const f = fixture(); const collector = createTrustedCollectors({ ...f.options, dispatch: async () => new Response('x'.repeat(65537)) });
    const r = await collector.workerBindings('after'); expect(r.state).toBe('unknown'); expect(r.value).toBeNull(); expect(f.options.ledger.snapshot.activeRequests).toBe(0);
  });
});
