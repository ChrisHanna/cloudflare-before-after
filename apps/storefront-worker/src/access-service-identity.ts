import { z } from 'zod';
import { AccessServiceIdentitySchema, type AccessServiceIdentity } from '../../../packages/contracts/src/access-service-identity.js';
import { Digest, Id, Time } from '../../../packages/contracts/src/schemas.js';

const Issuer = z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/);
const ClientId = z.string().regex(/^[A-Za-z0-9._-]{8,256}$/);
const Unix = z.number().int().min(0).max(253402300799);
const Kid = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Header = z.strictObject({ alg: z.literal('RS256'), kid: Kid, typ: z.literal('JWT').optional() });
// Strict documented service shape: no personal/custom claims are exported or accepted.
const Claims = z.strictObject({ type: z.literal('app'), aud: z.array(Digest).min(1).max(8),
  exp: Unix, iss: Issuer, common_name: ClientId, iat: Unix, nbf: Unix.optional(), sub: z.literal('') });
const Jwk = z.strictObject({ kty: z.literal('RSA'), alg: z.literal('RS256'), use: z.literal('sig'), kid: Kid,
  e: z.literal('AQAB'), n: z.string().regex(/^[A-Za-z0-9_-]{342,683}$/), key_ops: z.array(z.literal('verify')).length(1).optional() });
const Jwks = z.object({ keys: z.array(Jwk).min(1).max(4) });
export const AccessJwtTrustSchema = z.strictObject({
  issuer: Issuer, audience: Digest, approvedClientId: ClientId,
  // Already read by a trusted bounded key loader. This verifier never fetches.
  jwks: z.string().min(1).max(16384), jwksUrl: z.string().max(512), keysObservedAt: Time,
  keyTtlSeconds: z.number().int().min(1).max(300).default(300),
  maxTokenAgeSeconds: z.number().int().min(1).max(86400).default(3600),
  maxTokenLifetimeSeconds: z.number().int().min(1).max(86400).default(86400),
  clockSkewSeconds: z.number().int().min(0).max(30).default(0),
});
export type AccessJwtTrust = z.input<typeof AccessJwtTrustSchema>;
const verified = new WeakSet<object>();
export interface VerifiedAccessService { readonly audience: string; readonly identity: 'lab-service-token'; readonly signatureVerified: true }
function bytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid encoding');
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const result = Uint8Array.from(raw, c => c.charCodeAt(0));
  // Refuse alternate encodings with nonzero unused bits.
  if (btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '') !== value) throw new Error('Invalid encoding');
  return result;
}
function uniqueJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text); const stack: (Set<string> | null)[] = [];
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (/^\s*:/.test(text.slice(match.index! + token.length))) {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      if (!keys || keys.has(key)) throw new Error('Ambiguous JSON'); keys.add(key);
    }
  }
  return parsed;
}
function json(value: string): unknown { return uniqueJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes(value))); }

/** One signature check and one key import at most; no network, cache or fallback.
 * Fixed null on all errors. No token, claims, key IDs or crypto errors leave here. */
async function verify(token: unknown, trust: AccessJwtTrust, nowMs: number): Promise<VerifiedAccessService | null> {
  try {
    const c = AccessJwtTrustSchema.parse(trust);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || c.jwksUrl !== `${c.issuer}/cdn-cgi/access/certs`
      || nowMs < Date.parse(c.keysObservedAt) || nowMs - Date.parse(c.keysObservedAt) > c.keyTtlSeconds * 1000) return null;
    if (typeof token !== 'string' || token.length > 8192) return null;
    const parts = token.split('.'); if (parts.length !== 3 || parts.some(p => !p)) return null;
    const [head, payload, signature] = parts as [string, string, string];
    if (head.length > 1024 || payload.length > 6144 || signature.length > 683) return null;
    const h = Header.parse(json(head)); const claims = Claims.parse(json(payload)); const now = Math.floor(nowMs / 1000);
    if (claims.iss !== c.issuer || !claims.aud.includes(c.audience) || new Set(claims.aud).size !== claims.aud.length
      || claims.common_name !== c.approvedClientId || claims.exp <= now - c.clockSkewSeconds || claims.iat > now + c.clockSkewSeconds
      || claims.iat >= claims.exp || claims.exp - claims.iat > c.maxTokenLifetimeSeconds || now - claims.iat > c.maxTokenAgeSeconds
      || (claims.nbf !== undefined && (claims.nbf > now + c.clockSkewSeconds || claims.nbf >= claims.exp))) return null;
    const keys = Jwks.parse(uniqueJson(c.jwks)).keys;
    if (new Set(keys.map(k => k.kid)).size !== keys.length) return null;
    // Validate every trusted key, not only the selected kid.
    for (const k of keys) { const n = bytes(k.n); if (n.length < 256 || n.length > 512 || n[0]! < 128) return null; }
    const selected = keys.find(k => k.kid === h.kid); if (!selected) return null;
    const sig = bytes(signature); if (sig.length !== bytes(selected.n).length) return null;
    const key = await crypto.subtle.importKey('jwk', { kty: selected.kty, n: selected.n, e: selected.e, alg: selected.alg, use: selected.use, key_ops: ['verify'] },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${head}.${payload}`))) return null;
    const result = Object.freeze({ audience: c.audience, identity: 'lab-service-token' as const, signatureVerified: true as const });
    verified.add(result); return result;
  } catch { return null; }
}
/** Bounds asynchronous wait as well as native RSA work. A timed-out crypto task
 * cannot be cancelled by WebCrypto, but remains one bounded import/verification. */
export async function verifyAccessServiceJwt(token: unknown, trust: AccessJwtTrust, nowMs: number): Promise<VerifiedAccessService | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([verify(token, trust, nowMs), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
export function isVerifiedAccessService(value: VerifiedAccessService): boolean { return verified.has(value); }
export interface AccessIdentityProducerConfig {
  origin: string; releaseDigest: string; mode: 'live' | 'fixture'; runSecret: string; trust: AccessJwtTrust;
}
async function sameSecret(actual: string, expected: string): Promise<boolean> {
  if (actual.length > 256 || expected.length < 24 || expected.length > 256) return false;
  const data = new TextEncoder().encode('access-lab-run');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, data);
  const other = await crypto.subtle.importKey('raw', new TextEncoder().encode(actual || 'missing'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', other, sig, data);
}
/** Called only in the authenticated After admin path. Container receipts are
 * collected independently; a response from this helper alone is NOT admission proof. */
export async function produceAccessServiceIdentity(request: Request, config: AccessIdentityProducerConfig, nowMs: number): Promise<AccessServiceIdentity | null> {
  try {
    config = { ...config, trust: AccessJwtTrustSchema.parse(config.trust) };
    const url = new URL(request.url); const origin = new URL(config.origin);
    if (origin.protocol !== 'https:' || origin.origin !== config.origin || origin.port || origin.username || origin.password
      || url.origin !== config.origin || url.pathname !== '/admin' || url.search || url.hash || request.method !== 'GET'
      || request.headers.has('cookie') || request.headers.has('authorization') || request.headers.get('x-demo-scenario') !== 'access'
      || !['live', 'fixture'].includes(config.mode)) return null;
    Digest.parse(config.releaseDigest);
    const runId = Id.parse(request.headers.get('x-demo-run-id')); const requestId = Id.parse(request.headers.get('x-demo-request-id'));
    const marker = request.headers.get('x-demo-test') ?? ''; const prefix = `access-v1:${config.mode}:`;
    if (!marker.startsWith(prefix) || !await sameSecret(request.headers.get('x-demo-run-token') ?? '', config.runSecret)) return null;
    const nonce = Id.parse(marker.slice(prefix.length));
    const identity = await verifyAccessServiceJwt(request.headers.get('cf-access-jwt-assertion'), config.trust, nowMs);
    if (!identity || !isVerifiedAccessService(identity)
      // This is an additional join, never header-only identity proof: the signed
      // common_name already matched server trust; the guarded runner mapped this
      // exact header from the independently read token UUID.
      || request.headers.get('cf-access-client-id') !== config.trust.approvedClientId) return null;
    return Object.freeze(AccessServiceIdentitySchema.parse({ schemaVersion: 1, kind: 'access-service-identity', source: 'verified-rs256-service-jwt',
      channel: 'authenticated-same-request-https', mode: config.mode, targetRole: 'after', scenarioId: 'access', runId, requestId, nonce,
      releaseDigest: config.releaseDigest, hostname: origin.hostname, path: '/admin', method: 'GET', observedAt: new Date(nowMs).toISOString(),
      audience: identity.audience, issuer: config.trust.issuer, issuerMatched: true, clientIdMatched: true, identity: identity.identity,
      signatureVerified: true, policyId: null, perRequestEvaluation: 'unknown' }));
  } catch { return null; }
}
export async function accessServiceIdentityResponse(request: Request, config: AccessIdentityProducerConfig, nowMs: number): Promise<Response | null> {
  const facts = await produceAccessServiceIdentity(request, config, nowMs);
  return facts ? Response.json(facts, { headers: { 'cache-control': 'no-store', 'x-lab-role': 'after', 'x-lab-release': facts.releaseDigest } }) : null;
}
