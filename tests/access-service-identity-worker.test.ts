import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { accessServiceIdentityResponse, isVerifiedAccessService, produceAccessServiceIdentity, verifyAccessServiceJwt, type AccessJwtTrust } from '../apps/storefront-worker/src/access-service-identity.js';

const now = Date.parse('2026-11-05T00:00:00.000Z'); const sec = now / 1000;
const issuer = 'https://synthetic-team.cloudflareaccess.com'; const audience = '3'.repeat(64); const clientId = 'SYNTHETIC-CLIENT-ID.access';
let pair: CryptoKeyPair; let other: CryptoKeyPair; let jwk: JsonWebKey; let trust: AccessJwtTrust;
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
async function sign(claims: unknown, header: unknown = { alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' }, key?: CryptoKey) {
  const text = `${encode(header)}.${encode(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key ?? pair.privateKey, new TextEncoder().encode(text));
  return `${text}.${Buffer.from(signature).toString('base64url')}`;
}
const claims = () => ({ type: 'app', aud: [audience], exp: sec + 60, iss: issuer, common_name: clientId, iat: sec - 1, sub: '' });
beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  jwk = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), alg: 'RS256', use: 'sig', kid: 'synthetic-key' } as JsonWebKey;
  // ext is WebCrypto export metadata, not part of the vendor JWKS contract.
  delete jwk.ext;
  trust = { issuer, audience, approvedClientId: clientId, jwks: JSON.stringify({ keys: [jwk] }), jwksUrl: `${issuer}/cdn-cgi/access/certs`, keysObservedAt: new Date(now).toISOString() };
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('real bounded WebCrypto RS256 service JWT verification', () => {
  it('accepts actual RSA signatures with optional nbf omitted and returns only safe facts', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const result = await verifyAccessServiceJwt(await sign(claims()), trust, now);
    expect(result).toEqual({ audience, identity: 'lab-service-token', signatureVerified: true });
    expect(isVerifiedAccessService(result!)).toBe(true); expect(isVerifiedAccessService({ ...result! })).toBe(false);
    expect(JSON.stringify(result)).not.toContain(clientId); expect(fetch).not.toHaveBeenCalled();
  });
  it('accepts a valid optional nbf and either current or previous trusted kid', async () => {
    const c = { ...claims(), nbf: sec - 1 }; expect(await verifyAccessServiceJwt(await sign(c), trust, now)).not.toBeNull();
    const previous = { ...jwk, kid: 'previous-key' };
    const token = await sign(c, { alg: 'RS256', kid: 'previous-key' });
    expect(await verifyAccessServiceJwt(token, { ...trust, jwks: JSON.stringify({ keys: [jwk, previous] }) }, now)).not.toBeNull();
  });
  it('rejects duplicate JSON keys, including escaped duplicate names', async () => {
    const valid = await sign(claims()); const [, payload, signature] = valid.split('.');
    const badHeader = Buffer.from('{"alg":"none","\\u0061lg":"RS256","kid":"synthetic-key"}').toString('base64url');
    expect(await verifyAccessServiceJwt(`${badHeader}.${payload}.${signature}`, trust, now)).toBeNull();
    expect(await verifyAccessServiceJwt(valid, { ...trust, jwks: `{"keys":[],"keys":[${JSON.stringify(jwk)}]}` }, now)).toBeNull();
  });
  it('bounds async crypto wait and returns no late proof', async () => {
    const token = await sign(claims()); vi.useFakeTimers();
    vi.spyOn(crypto.subtle, 'importKey').mockImplementation(() => new Promise<CryptoKey>(() => {}));
    const result = verifyAccessServiceJwt(token, trust, now); await vi.advanceTimersByTimeAsync(1001);
    expect(await result).toBeNull();
  });
  it.each(['signature', 'issuer', 'audience', 'empty-aud', 'duplicate-aud', 'expiry', 'future-iat', 'future-nbf', 'bad-nbf', 'bad-iat', 'bad-exp', 'time-order', 'age', 'lifetime', 'type', 'subject', 'email', 'custom', 'client-id', 'uuid-not-client-id'])(
    'rejects %s without exporting claims/errors', async fault => {
      const c: Record<string, unknown> = claims();
      if (fault === 'issuer') c.iss = 'https://evil.invalid';
      if (fault === 'audience') c.aud = ['4'.repeat(64)];
      if (fault === 'empty-aud') c.aud = [];
      if (fault === 'duplicate-aud') c.aud = [audience, audience];
      if (fault === 'expiry') c.exp = sec;
      if (fault === 'future-iat') c.iat = sec + 1;
      if (fault === 'future-nbf') c.nbf = sec + 1;
      if (fault === 'bad-nbf') c.nbf = 'PRIVATE-TIME';
      if (fault === 'bad-iat') c.iat = 1.5;
      if (fault === 'bad-exp') c.exp = null;
      if (fault === 'time-order') c.iat = sec + 60;
      if (fault === 'age') c.iat = sec - 3601;
      if (fault === 'lifetime') c.exp = sec + 86401;
      if (fault === 'type') c.type = 'org';
      if (fault === 'subject') c.sub = 'PRIVATE-PERSON';
      if (fault === 'email') c.email = 'private-person@example.invalid';
      if (fault === 'custom') c.custom = { email: 'private-person@example.invalid' };
      if (fault === 'client-id') c.common_name = 'PRIVATE-FOREIGN.access';
      if (fault === 'uuid-not-client-id') c.common_name = '4'.repeat(32);
      const result = await verifyAccessServiceJwt(await sign(c, undefined, fault === 'signature' ? other.privateKey : undefined), trust, now);
      expect(result).toBeNull();
    });
  it.each(['none', 'HS256', 'ES256', 'jku', 'x5u', 'crit', 'embedded-jwk', 'wrong-kid', 'typ', 'header-bound', 'token-bound'])('rejects header %s', async fault => {
    const h: Record<string, unknown> = { alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' };
    if (['none', 'HS256', 'ES256'].includes(fault)) h.alg = fault;
    if (fault === 'jku') h.jku = 'https://evil.invalid/key';
    if (fault === 'x5u') h.x5u = 'https://evil.invalid/key';
    if (fault === 'crit') h.crit = ['b64'];
    if (fault === 'embedded-jwk') h.jwk = jwk;
    if (fault === 'wrong-kid') h.kid = 'foreign';
    if (fault === 'typ') h.typ = 'OTHER';
    if (fault === 'header-bound') h.kid = 'a'.repeat(1025);
    const token = fault === 'token-bound' ? 'x'.repeat(8193) : await sign(claims(), h);
    expect(await verifyAccessServiceJwt(token, trust, now)).toBeNull();
  });
  it.each(['duplicate-kid', 'wrong-kty', 'wrong-alg', 'wrong-use', 'private-key', 'too-many', 'huge', 'small-rsa', 'exponent', 'key-url', 'stale-keys', 'future-keys', 'invalid-now', 'malformed'])('rejects key/config %s', async fault => {
    const config = { ...trust }; const key: Record<string, unknown> = { ...jwk }; let keys: unknown[] = [key];
    if (fault === 'duplicate-kid') keys.push(key);
    if (fault === 'wrong-kty') key.kty = 'oct';
    if (fault === 'wrong-alg') key.alg = 'HS256';
    if (fault === 'wrong-use') key.use = 'enc';
    if (fault === 'private-key') key.d = 'PRIVATE-KEY';
    if (fault === 'too-many') keys = Array.from({ length: 5 }, (_, i) => ({ ...key, kid: `kid-${i}` }));
    if (fault === 'small-rsa') key.n = 'a'.repeat(128);
    if (fault === 'exponent') key.e = 'Aw';
    if (fault === 'key-url') config.jwksUrl = 'https://evil.invalid/certs';
    if (fault === 'stale-keys') config.keysObservedAt = new Date(now - 300001).toISOString();
    if (fault === 'future-keys') config.keysObservedAt = new Date(now + 1).toISOString();
    config.jwks = fault === 'huge' ? 'x'.repeat(16385) : fault === 'malformed' ? '{' : JSON.stringify({ keys });
    expect(await verifyAccessServiceJwt(await sign(claims()), config, fault === 'invalid-now' ? NaN : now)).toBeNull();
  });
});
function request(token: string, fault?: string) {
  const headers: Record<string, string> = { 'cf-access-jwt-assertion': token, 'cf-access-client-id': clientId, 'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(),
    'x-demo-scenario': 'access', 'x-demo-run-token': 'synthetic-only-runner-key', 'x-demo-test': `access-v1:fixture:${randomUUID()}` };
  if (fault === 'secret') headers['x-demo-run-token'] = 'wrong';
  if (fault === 'header-client-id') headers['cf-access-client-id'] = 'OTHER-CLIENT-ID.access';
  if (fault === 'cookie') headers.cookie = 'CF_Authorization=PRIVATE-COOKIE';
  if (fault === 'authorization') headers.authorization = 'Bearer PRIVATE-AUTH';
  if (fault === 'scenario') headers['x-demo-scenario'] = 'analytics';
  if (fault === 'run') headers['x-demo-run-id'] = 'PRIVATE-RUN';
  if (fault === 'request') headers['x-demo-request-id'] = 'PRIVATE-REQUEST';
  if (fault === 'nonce') headers['x-demo-test'] = 'access-v1:fixture:PRIVATE-NONCE';
  if (fault === 'mode') headers['x-demo-test'] = `access-v1:live:${randomUUID()}`;
  return new Request(`https://${fault === 'host' ? 'before' : 'after'}.example.test/${fault === 'path' ? 'catalog' : 'admin'}${fault === 'query' ? '?private=1' : ''}`,
    { method: fault === 'method' ? 'POST' : 'GET', headers });
}
describe('authenticated same-request Worker helper (not yet entrypoint wiring)', () => {
  it('emits strict sanitized facts and no-store response from actual verification', async () => {
    const config = { origin: 'https://after.example.test', mode: 'fixture' as const, releaseDigest: 'a'.repeat(64), runSecret: 'synthetic-only-runner-key', trust };
    const req = request(await sign(claims())); const response = await accessServiceIdentityResponse(req, config, now);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    const facts = await response!.json(); expect(facts.policyId).toBeNull(); expect(facts.perRequestEvaluation).toBe('unknown'); expect(facts.identity).toBe('lab-service-token');
    for (const canary of [clientId, config.runSecret, req.headers.get('cf-access-jwt-assertion')!]) expect(JSON.stringify(facts)).not.toContain(canary);
  });
  it.each(['secret', 'header-client-id', 'cookie', 'authorization', 'scenario', 'run', 'request', 'nonce', 'mode', 'host', 'path', 'query', 'method', 'bad-jwt'])('refuses %s without an observation', async fault => {
    const config = { origin: 'https://after.example.test', mode: 'fixture' as const, releaseDigest: 'a'.repeat(64), runSecret: 'synthetic-only-runner-key', trust };
    expect(await produceAccessServiceIdentity(request(fault === 'bad-jwt' ? 'PRIVATE-ASSERTION' : await sign(claims()), fault), config, now)).toBeNull();
  });
});
