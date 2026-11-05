import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accessServiceIdentityResponse, type AccessJwtTrust } from '../apps/storefront-worker/src/access-service-identity.js';
import { AccessServiceIdentityCollector, bindAccessServiceAdmission, observedAccessExchange } from '../packages/demo-core/src/access-service-identity.js';
import { accessComparison } from '../packages/demo-core/src/access-policy.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { policyRequest, PolicySignalSchema, evaluatePolicyComparison, executePolicyComparison, type PolicyFlow } from '../packages/demo-core/src/api-shield-proof.js';
import { labConfig } from './fixtures/lab.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';

let pair: CryptoKeyPair; let trust: AccessJwtTrust;
const initial = Date.parse('2026-11-05T00:00:00.000Z'); const clientId = 'SYNTHETIC-CLIENT-ID.access'; const secret = 'SYNTHETIC-CLIENT-SECRET';
const issuer = 'https://synthetic-team.cloudflareaccess.com'; const audience = '3'.repeat(64); const runner = 'synthetic-only-runner-key';
const ledgers: BudgetLedger[] = [];
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const key = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), alg: 'RS256', use: 'sig', kid: 'synthetic-key' }; delete key.ext;
  trust = { issuer, audience, approvedClientId: clientId, jwks: JSON.stringify({ keys: [key] }), jwksUrl: `${issuer}/cdn-cgi/access/certs`, keysObservedAt: new Date(initial).toISOString() };
});
afterEach(() => { ledgers.splice(0).forEach(l => l.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function jwt() {
  const text = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url')}.${Buffer.from(JSON.stringify({
    type: 'app', aud: [audience], exp: initial / 1000 + 60, iat: initial / 1000 - 1, iss: issuer, common_name: clientId, sub: '',
  })).toString('base64url')}`;
  return `${text}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(text))).toString('base64url')}`;
}
async function fixture(fault = '') {
  const config = labConfig(); config.liveOptIn = true; config.credentials.accessReaderTokenKind = 'account';
  const policy = { applicationId: '1'.repeat(32), policyId: '2'.repeat(32), audience,
    beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin,
    capability: 'available' as const, enabled: true, baselineExcluded: true, path: '/admin' as const, serviceTokenRef: 'service-token:lab-only' };
  const tokenId = '4'.repeat(32); config.demonstrations = { access: policy,
    serviceToken: { ref: policy.serviceTokenRef, id: tokenId, clientIdRef: 'env:SYNTHETIC_CLIENT_ID', clientSecretRef: 'env:SYNTHETIC_CLIENT_SECRET' } };
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const app: Record<string, unknown> = { id: policy.applicationId, aud: audience, type: 'self_hosted', domain: 'after.example.test/admin', destinations: [{ type: 'public', uri: 'after.example.test/admin' }] };
  const rule = { id: policy.policyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] };
  const state = { now: initial, receipts: [] as Receipt[], tokenClient: clientId, saved: null as null | unknown, fault, producerCalls: 0 };
  const calls: { url: string; init: RequestInit }[] = []; let collectors!: ReturnType<typeof createTrustedCollectors>;
  const token = await jwt();
  const dispatch = async (url: string, init: RequestInit) => {
    calls.push({ url, init }); state.now += 10; const u = new URL(url);
    if (u.pathname.endsWith('/tokens/verify')) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active' } });
    if (u.pathname.endsWith(`/tokens/${'6'.repeat(32)}`)) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active', policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${config.accountId}`]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }] } });
    if (u.hostname === 'api.cloudflare.com') return Response.json({ success: true,
      result: u.pathname.includes('/service_tokens/') ? { id: tokenId, client_id: state.tokenClient, expires_at: '2026-11-06T00:00:00.000Z', client_secret: 'PRIVATE-UNREAD-SECRET' }
        : u.pathname.includes('/policies') ? [rule] : [app], result_info: { page: 1, total_pages: 1 } });
    if (u.pathname === '/admin') {
      if (['403', 'redirect', 'branded'].includes(state.fault)) return new Response(state.fault === 'branded' ? 'Cloudflare Access login' : '', { status: state.fault === 'redirect' ? 302 : 403,
        headers: state.fault === 'redirect' ? { location: 'https://synthetic-team.cloudflareaccess.com/cdn-cgi/access/login' } : {} });
      const headers = new Headers(init.headers); headers.set('cf-access-jwt-assertion', state.fault === 'bad-jwt' ? 'PRIVATE-ASSERTION' : token);
      state.producerCalls++;
      const r = await accessServiceIdentityResponse(new Request(url, { ...init, headers }), {
        origin: config.environments[1].origin, releaseDigest: config.environments[1].releaseDigest,
        mode: 'fixture', runSecret: runner, trust,
      }, state.now);
      if (!r) return Response.json({ unavailable: true }, { status: 503 });
      const body = await r.json() as Record<string, unknown>;
      const requestId = headers.get('x-demo-request-id')!; const runId = headers.get('x-demo-run-id')!;
      const base = { schemaVersion: 1 as const, runId, requestId, scenarioId: 'access' as const, targetRole: 'after' as const,
        producerId: 'synthetic-container', rayId: '1234567890abcdef', releaseDigest: config.environments[1].releaseDigest };
      state.receipts = [{ ...base, id: randomUUID(), sequence: 1, stage: 'entry', observedAt: new Date(state.now).toISOString() },
        { ...base, id: randomUUID(), sequence: 2, stage: 'completion', observedAt: new Date(state.now + 1).toISOString() }]; state.now += 2;
      if (state.fault === 'scope-race') await collectors.accessIdentitySnapshot(policy, tokenId, { runId, phase: 'before' });
      if (state.fault === 'drift') app.destinations = [{ type: 'public', uri: 'before.example.test/admin' }];
      if (state.fault === 'token-drift') state.tokenClient = 'OTHER-CLIENT-ID.access';
      if (state.fault === 'nonce') body.nonce = randomUUID();
      if (state.fault === 'run') body.runId = randomUUID();
      if (state.fault === 'request') body.requestId = randomUUID();
      if (state.fault === 'mode') body.mode = 'live';
      if (state.fault === 'release') body.releaseDigest = 'b'.repeat(64);
      if (state.fault === 'host') body.hostname = 'before.example.test';
      if (state.fault === 'path') body.path = '/catalog';
      if (state.fault === 'method') body.method = 'POST';
      if (state.fault === 'time') body.observedAt = new Date(initial - 1).toISOString();
      if (state.fault === 'audience') body.audience = '5'.repeat(64);
      if (state.fault === 'personal') body.email = 'private-person@example.invalid';
      if (state.fault === 'policy-invention') body.policyId = policy.policyId;
      if (state.fault === 'missing-receipt') state.receipts = [];
      if (state.fault === 'wrong-receipt') state.receipts[0]!.requestId = randomUUID();
      if (state.fault === 'duplicate-receipt') state.receipts.push({ ...state.receipts[0]!, id: randomUUID() });
      if (state.fault === 'ray') state.receipts.forEach(r => { r.rayId = '9'.repeat(16); });
      if (state.fault === 'replay' && state.saved) return Response.json(state.saved, { headers: r.headers });
      state.saved = body; const responseHeaders = new Headers(r.headers); responseHeaders.set('cf-ray', '1234567890abcdef-DFW');
      if (state.fault === 'metadata') responseHeaders.set('x-lab-role', 'before');
      if (state.fault === 'cache') responseHeaders.set('cache-control', 'public, max-age=60');
      if (state.fault === 'content-type') responseHeaders.set('content-type', 'text/html');
      if (state.fault === 'oversized-body') return new Response(JSON.stringify(body) + ' '.repeat(4096), { headers: responseHeaders });
      return new Response(JSON.stringify(body), { headers: responseHeaders });
    }
    if (u.pathname === '/internal/checkpoint') return Response.json({ checkpoint: true });
    if (u.pathname === '/receipts') return Response.json({ schemaVersion: 1, targetRole: 'after', runId: u.searchParams.get('runId'), scenarioId: 'access',
      originCount: state.receipts.filter(r => r.stage === 'entry').length, receipts: state.receipts,
      coverage: { healthy: state.fault !== 'coverage', complete: state.fault !== 'coverage', windowStart: u.searchParams.get('start'),
        watermark: u.searchParams.get('end'), producerSequence: 2, gaps: [] } });
    throw new Error('Unapproved mock route');
  };
  const observedOwnedResources = new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
  collectors = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources,
    credentials: { reader: 'synthetic-only-reader-key', collector: 'synthetic-only-collector-key', runner }, dispatch, now: () => state.now });
  const bridge = new AccessServiceIdentityCollector({ config, ledger, collectors, mode: 'fixture', observedOwnedResources,
    runnerCredential: runner, dispatch, now: () => state.now });
  const request = policyRequest(randomUUID(), 'access', config.environments[1].origin, 'after', '/admin', 'authorized', policy.serviceTokenRef);
  const pre = await collectors.accessIdentitySnapshot(policy, tokenId, { runId: request.runId, phase: 'before' });
  return { config, policy, tokenId, state, calls, ledger, collectors, bridge, request, before: pre.value!, credentials: { clientId, clientSecret: secret } };
}
async function nativePolicyFlow() {
  const f = await fixture(); const proof = await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials);
  expect(proof).not.toBeNull(); const x = observedAccessExchange(proof!)!; expect(bindAccessServiceAdmission(proof!)).toBe(proof);
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(f.state.now);
  const base = { mode: 'fixture' as const, runId: f.request.runId, requestId: f.request.requestId, scenarioId: 'access' as const, targetRole: 'after' as const };
  const observation = { schemaVersion: 1 as const, id: randomUUID(), ...base, observedAt: x.end, method: 'GET' as const, path: '/admin', status: x.response.status,
    latencyMs: x.response.latencyMs, rayId: x.response.rayId, action: null, ruleId: null, originCount: null, excerpt: x.response.excerpt };
  const flow: PolicyFlow = { observation, httpEvidence: makeArtifact({ ...base, id: randomUUID(), observedAt: x.end, source: 'http', payload: observation }).ref,
    signal: null, verificationEvidence: null, accessEnforcement: proof!, accessEnforcementEvidence: makeArtifact({ ...base, id: randomUUID(), observedAt: proof!.completedAt, source: 'verification', payload: proof! }).ref,
    receipts: structuredClone(x.origin.receipts), coverage: structuredClone(x.origin.coverage), originEvidence: [
      makeArtifact({ ...base, id: randomUUID(), requestId: null, observedAt: x.origin.coverage.watermark!, source: 'origin', payload: x.origin.coverage }).ref,
      ...x.origin.receipts.map(receipt => makeArtifact({ ...base, id: receipt.id, observedAt: receipt.observedAt, source: 'origin', payload: receipt }).ref),
    ] };
  const configurationEvidence = makeArtifact({ ...base, id: x.before.readId, requestId: null, observedAt: x.before.observedAt, source: 'configuration', payload: x.before }).ref;
  const comparison = accessComparison({ policy: f.policy, runId: f.request.runId, mode: 'fixture', releaseDigest: proof!.facts.releaseDigest,
    readback: { applicationId: x.before.applicationId, policyId: x.before.configuredPolicyId, audience: x.before.audience, hostname: x.before.hostname,
      path: '/admin', enabled: true, baselineExcluded: true, serviceTokenAllowed: true, decision: 'non_identity', bypass: false }, configurationEvidence });
  comparison.requests = [f.request]; return { f, proof: proof!, x, flow, comparison };
}
describe('F2 comparison retains real current producer provenance through validation copies', () => {
  it('credits the real native source through redaction and evaluation, once only', async () => {
    const { f, flow, comparison } = await nativePolicyFlow();
    expect(comparison.signalMatches(flow, f.request)).toBe(true);
    expect(comparison.signalMatches(structuredClone(flow), f.request)).toBe(false);
    const result = await executePolicyComparison(comparison, { exchange: async () => flow });
    expect(result.decision.missingProof).not.toContain('after authorized product attribution');
    expect(evaluatePolicyComparison(comparison, [flow]).missingProof).toContain('after authorized product attribution');
  });
  it('does not restore credit after a known flow was mutated and restored', async () => {
    const { f, flow, comparison } = await nativePolicyFlow(); expect(comparison.signalMatches(flow, f.request)).toBe(true);
    const digest = flow.httpEvidence.artifactDigest; flow.httpEvidence.artifactDigest = 'f'.repeat(64);
    expect(comparison.signalMatches(flow, f.request)).toBe(false); flow.httpEvidence.artifactDigest = digest;
    expect(comparison.signalMatches(flow, f.request)).toBe(false);
  });
  it('does not relabel an actual source as a foreign origin or credential reference', async () => {
    const { f, flow, comparison } = await nativePolicyFlow();
    expect(comparison.signalMatches(flow, { ...f.request, origin: 'https://other.invalid' })).toBe(false);
    expect(comparison.signalMatches(flow, { ...f.request, credentialRef: 'service-token:lab-other' })).toBe(false);
    expect(comparison.signalMatches(flow, f.request)).toBe(true);
  });
  it.each(['body', 'http-ref', 'origin-ref', 'receipt', 'configuration', 'mode', 'window', 'stale'])('refuses real-source %s mutation or relabel', async fault => {
    const { f, flow, comparison } = await nativePolicyFlow();
    if (fault === 'body') flow.observation.excerpt = '{}';
    if (fault === 'http-ref') flow.httpEvidence.artifactDigest = 'f'.repeat(64);
    if (fault === 'origin-ref') flow.originEvidence[0]!.artifactDigest = 'f'.repeat(64);
    if (fault === 'receipt') flow.receipts[0]!.id = randomUUID();
    if (fault === 'configuration') flow.accessEnforcement = { ...flow.accessEnforcement!, configurationDigest: 'f'.repeat(64) };
    if (fault === 'mode') flow.observation.mode = 'live';
    if (fault === 'window') flow.observation.observedAt = new Date(Date.parse(flow.observation.observedAt) + 1).toISOString();
    if (fault === 'stale') vi.setSystemTime(f.state.now + 120001);
    expect(comparison.signalMatches(flow, f.request)).toBe(false);
    expect(evaluatePolicyComparison(comparison, [flow]).missingProof).toContain('after authorized product attribution');
  });
});
describe('real joined producer/guarded-collector helpers; NOT default Worker entrypoint qualification', () => {
  it('joins real RSA verification, current HTTP, pre/post config and authenticated receipts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden')); const f = await fixture();
    const result = await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials);
    expect(result).not.toBeNull(); expect(result?.facts.identity).toBe('lab-service-token'); expect(result?.facts.mode).toBe('fixture');
    expect(result?.facts.policyId).toBeNull(); expect(result?.approvingPolicyId).toBeNull(); expect(result?.fullRuntimeState).toBeNull();
    expect(result?.configuredPolicyId).toBe(f.policy.policyId); expect(PolicySignalSchema.safeParse(result).success).toBe(false);
    expect(f.state.producerCalls).toBe(1); expect(f.calls).toHaveLength(11); expect(f.collectors.readsUsed).toBe(10); expect(f.ledger.snapshot.requestsUsed).toBe(11);
    const admin = f.calls.find(c => new URL(c.url).pathname === '/admin')!;
    expect(admin.init.redirect).toBe('manual'); expect(admin.url).not.toContain(clientId); expect(admin.url).not.toContain(secret);
    expect(bindAccessServiceAdmission(result!)).toBe(result); expect(bindAccessServiceAdmission(result!)).toBeNull();
    for (const canary of [clientId, secret, runner, 'PRIVATE-UNREAD-SECRET', 'PRIVATE-ASSERTION', 'private-person']) expect(JSON.stringify(result)).not.toContain(canary);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['nonce', 'run', 'request', 'mode', 'release', 'host', 'path', 'method', 'time', 'audience', 'personal', 'policy-invention',
    'missing-receipt', 'wrong-receipt', 'duplicate-receipt', 'ray', 'coverage', 'metadata', 'cache', 'content-type', 'oversized-body', 'scope-race', 'drift', 'token-drift', 'bad-jwt'])(
    'rejects %s without callback proof or scope fallback', async fault => {
      const f = await fixture(fault);
      expect(await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials)).toBeNull();
    });
  it.each(['403', 'redirect', 'branded'])('does not call the producer or infer denial from %s', async fault => {
    const f = await fixture(fault); expect(await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials)).toBeNull();
    expect(f.state.producerCalls).toBe(0); expect(f.calls).toHaveLength(6);
  });
  it('rejects request replay, saved-response replay and cloned/mutated brands', async () => {
    const f = await fixture(); const result = await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials);
    expect(result).not.toBeNull(); const used = f.calls.length;
    expect(await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials)).toBeNull(); expect(f.calls).toHaveLength(used);
    expect(bindAccessServiceAdmission(structuredClone(result!))).toBeNull();
    expect(() => { result!.facts.hostname = 'other.example.test'; }).toThrow();
    expect(() => { f.bridge.attempt(f.request)!.response.metadata.role = 'before'; }).toThrow();
    expect(() => { f.bridge.attempt(f.request)!.origin!.receipts[0]!.requestId = randomUUID(); }).toThrow();
    f.state.fault = 'replay'; const next = { ...f.request, requestId: randomUUID() };
    expect(await f.bridge.collect(next, f.before, f.policy, f.tokenId, f.credentials)).toBeNull();
  });
  it('invalidates pending adoption on refresh failure or elapsed freshness', async () => {
    const f = await fixture(); const result = await f.bridge.collect(f.request, f.before, f.policy, f.tokenId, f.credentials);
    expect(result).not.toBeNull(); f.state.now += 120001; expect(bindAccessServiceAdmission(result!)).toBeNull();
    const g = await fixture(); const current = await g.bridge.collect(g.request, g.before, g.policy, g.tokenId, g.credentials);
    g.state.tokenClient = 'OTHER-CLIENT-ID.access'; await g.collectors.accessIdentitySnapshot(g.policy, g.tokenId, { runId: g.request.runId, phase: 'before' });
    expect(bindAccessServiceAdmission(current!)).toBeNull();
  });
  it('refuses cross-ledger and cross-mode current collectors', async () => {
    const f = await fixture(); const ledger = new BudgetLedger(); ledgers.push(ledger);
    const observedOwnedResources = new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
    expect(() => new AccessServiceIdentityCollector({ config: f.config, ledger, collectors: f.collectors, mode: 'fixture', observedOwnedResources,
      runnerCredential: runner })).toThrow('context');
    expect(() => new AccessServiceIdentityCollector({ config: f.config, ledger: f.ledger, collectors: f.collectors, mode: 'live', observedOwnedResources,
      runnerCredential: runner })).toThrow('context'); expect(f.calls).toHaveLength(5);
  });
  it.each(['cloned-snapshot', 'wrong-client-id', 'token-uuid', 'wrong-request-case', 'cancelled'])('refuses %s before bridge dispatch', async fault => {
    const f = await fixture(); const controller = new AbortController(); let before = f.before;
    if (fault === 'cloned-snapshot') before = structuredClone(before);
    if (fault === 'wrong-client-id') f.credentials.clientId = 'OTHER-CLIENT-ID.access';
    if (fault === 'token-uuid') f.credentials.clientId = f.tokenId;
    if (fault === 'wrong-request-case') f.request = { ...f.request, case: 'missing' };
    if (fault === 'cancelled') controller.abort();
    expect(await f.bridge.collect(f.request, before, f.policy, f.tokenId, f.credentials, controller.signal)).toBeNull(); expect(f.calls).toHaveLength(5);
  });
});
