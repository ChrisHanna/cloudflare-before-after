import { Hono } from 'hono';
import { RuntimeFailure, failureRecord, readFailure, runtimeStep, type RuntimeScope } from './runtime-failure.js';
import { boundedText } from './runtime-transport.js';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Digest, Id, RayId, Role, ScenarioId } from '../../../packages/contracts/src/schemas.js';
import { RegistrationVerifier, type TurnstileOptions } from './turnstile.js';
import { REGISTER_CSS, notEnabledPage, registerPage, registerResultPage } from './register-page.js';
import { platformTlsVerification } from './tls-client-verification.js';
import { accessServiceIdentityResponse, type AccessJwtTrust } from './access-service-identity.js';
import type { TurnstileReceiptSchema } from '../../../packages/contracts/src/schemas.js';
import { StorefrontData, type Database } from './d1.js';
import { ServiceReadReceiptSchema, ServiceResourcesSchema } from '../../../packages/contracts/src/service-read.js';
import { D1WriteReadReceiptSchema } from '../../../packages/contracts/src/d1-probe.js';
import { runD1WriteRead } from './d1-probe.js';
import { R2WriteReadReceiptSchema } from '../../../packages/contracts/src/r2-probe.js';
import { runR2WriteRead } from './r2-probe.js';
import { OwnedAssets, imageUrl, contentDigest, type ImageAsset, type ObjectBucket } from './assets.js';
export interface ContainerStub { fetch(request: Request): Promise<Response> }
export interface StorefrontBindings {
  role: z.infer<typeof Role>; origin: string; releaseDigest: string; viewRunId: string;
  runSecret: string; internalSecret: string; labId: string;
  db: Database; bucket: ObjectBucket; image: ImageAsset;
  serviceResources?: z.infer<typeof ServiceResourcesSchema>;
  containers: { getByName(key: string): ContainerStub };
  turnstile?: TurnstileOptions;
  accessIdentity?: { mode: 'live' | 'fixture'; trust: AccessJwtTrust };
}
const Registration = z.strictObject({ record_id: Id, display_name: z.string().regex(/^synthetic-[A-Za-z0-9 _-]{1,64}$/), note: z.string().max(256), turnstileToken: z.string().max(4096).nullable().default(null) });
const ContainerResponse = z.strictObject({
  schemaVersion: z.literal(1), targetRole: Role, runId: Id, requestId: Id, releaseDigest: Digest,
  html: z.string().max(16384),
  operation: z.strictObject({ type: z.literal('create-registration'), value: Registration.omit({ turnstileToken: true }) }).nullable(),
});
async function sameSecret(actual: string, expected: string): Promise<boolean> {
  // Fixed-sized keyed digests avoid string length/content comparison at the trust boundary.
  if (actual.length > 4096) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const value = new TextEncoder().encode('lab-run');
  const signature = await crypto.subtle.sign('HMAC', key, value);
  const actualKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(actual || 'missing'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', actualKey, signature, value);
}
// Each Container producer owns an exact 100-request budget; public views use a fresh scope every 5 minutes so it never runs out.
async function viewWindowRun(viewRunId: string): Promise<string> {
  const window = Math.floor(Date.now() / 300000);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`public-view:${viewRunId}:${window}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(v => v.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createStorefrontWorker(env: StorefrontBindings): Hono {
  Role.parse(env.role); Digest.parse(env.releaseDigest); Id.parse(env.viewRunId);
  const origin = new URL(env.origin);
  if (origin.protocol !== 'https:' || origin.origin !== env.origin || origin.username || origin.password || origin.port) throw new Error('Invalid deployed origin');
  if (env.runSecret.length < 24 || env.internalSecret.length < 24) throw new Error('Service secrets are required');
  const data = new StorefrontData(env.db, env.role); const assets = new OwnedAssets(env.bucket, env.role);
  const deliveryUrl = imageUrl(env.image, env.role, env.labId);
  const resources = env.serviceResources ? ServiceResourcesSchema.parse(env.serviceResources) : null;
  const verifier = env.turnstile ? new RegistrationVerifier(env.db, env.role, env.turnstile) : null;
  if (verifier && verifier.config.hostname !== origin.hostname) throw new Error('Verifier hostname differs from deployment');
  const app = new Hono();
  // Weak keys are request-local. No shared last-error state or persistent store.
  const diagnosticScopes = new WeakMap<Request, RuntimeScope>();
  app.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Body exceeds limit' }, 413) }));
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).origin !== env.origin) return c.json({ error: 'Wrong deployment hostname' }, 421);
    c.header('x-lab-role', env.role); c.header('x-lab-release', env.releaseDigest);
    c.header('cache-control', 'no-store');
    c.header('content-security-policy', `default-src 'none'; img-src https://imagedelivery.net; style-src 'self' 'sha256-lelB3bxDXGDZze+JVU2O8y0dLQZFpZZbXBf86SjKEnc='; frame-ancestors http://127.0.0.1:8787 http://localhost:8787; base-uri 'none'; form-action 'self'${verifier && env.role === 'after' ? "; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com" : ''}`);
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    await next();
  });
  app.get('/health', c => c.json({ role: env.role, releaseDigest: env.releaseDigest, proof: 'worker-only' }));
  app.get('/internal/registration-config', async c => {
    if (!(await sameSecret(c.req.header('x-demo-run-token') ?? '', env.runSecret))) return c.json({ error: 'Authorized lab run required' }, 401);
    return c.json({ role: env.role, releaseDigest: env.releaseDigest, config: verifier?.config ?? null });
  });
  app.get('/internal/registration-evidence', async c => {
    if (!(await sameSecret(c.req.header('x-demo-run-token') ?? '', env.runSecret))) return c.json({ error: 'Authorized lab run required' }, 401);
    const run = Id.safeParse(c.req.query('runId')); if (!run.success || !verifier) return c.json({ error: 'Verification evidence unavailable' }, 503);
    const evidence = await verifier.evidence(run.data); const records = await Promise.all(evidence.receipts.map(async receipt => ({ requestId: receipt.requestId, recordId: receipt.recordId, exists: (await data.scope('turnstile', run.data).get(receipt.recordId)) !== null })));
    return c.json({ schemaVersion: 1, targetRole: env.role, runId: run.data, receipts: evidence.receipts, records, truncated: evidence.truncated });
  });
  app.post('/internal/registrations/cleanup', async c => {
    if (!(await sameSecret(c.req.header('x-demo-run-token') ?? '', env.runSecret))) return c.json({ error: 'Authorized lab run required' }, 401);
    const parsed = z.strictObject({ runId: Id }).safeParse(await c.req.json().catch(() => null)); if (!parsed.success) return c.json({ error: 'Owned run required' }, 400);
    await data.scope('turnstile', parsed.data.runId).cleanup(); return c.json({ cleaned: true, runId: parsed.data.runId });
  });
  app.get('/assets/register.css', c => c.body(REGISTER_CSS, 200, { 'content-type': 'text/css; charset=utf-8' }));
  app.get('/register', c => verifier ? c.html(registerPage(env.role, verifier.config)) : c.html(notEnabledPage(env.role), 503));
  app.post('/register/check', async c => {
    if (!verifier) return c.html(notEnabledPage(env.role), 503);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const token = form['cf-turnstile-response']; const result = await verifier.check(typeof token === 'string' ? token : null, c.req.raw.signal);
    const page = registerResultPage(env.role, verifier.config, result.reason);
    return c.html(page.html, page.status);
  });
  const routes = new Map<string, 'catalog' | 'launch' | 'api' | 'admin' | 'registration'>([['/', 'catalog'], ['/catalog', 'catalog'], ['/internal/service-read', 'catalog'], ['/internal/d1-write-read', 'catalog'], ['/internal/r2-write-read', 'catalog'], ['/launch', 'launch'], ['/api', 'api'], ['/admin', 'admin'], ['/register', 'registration']]);
  app.all('*', async c => {
    const operation = routes.get(c.req.path); const d1WriteRead = c.req.path === '/internal/d1-write-read'; const r2WriteRead = c.req.path === '/internal/r2-write-read';
    const writeRead = d1WriteRead || r2WriteRead;
    if (!operation || c.req.method !== (operation === 'registration' || writeRead ? 'POST' : 'GET')) return c.json({ error: 'Synthetic route not found' }, 404);
    const explicitRun = c.req.header('x-demo-run-id');
    const hasCorrelation = ['x-demo-run-id', 'x-demo-request-id', 'x-demo-scenario'].some(h => c.req.header(h) !== undefined);
    const authenticated = await sameSecret(c.req.header('x-demo-run-token') ?? '', env.runSecret);
    const serviceRead = c.req.path === '/internal/service-read';
    if ((serviceRead || writeRead) && ['x-demo-run-id', 'x-demo-request-id', 'x-demo-scenario'].some(name => !c.req.header(name))) return c.json({ error: 'Scoped service read required' }, 400);
    if ((hasCorrelation || operation === 'registration' || serviceRead || writeRead) && !authenticated) return c.json({ error: 'Authorized lab run required' }, 401);
    const run = Id.safeParse(explicitRun ?? await viewWindowRun(env.viewRunId));
    const scenario = ScenarioId.safeParse(c.req.header('x-demo-scenario') ?? 'analytics');
    const requestId = Id.safeParse(c.req.header('x-demo-request-id') ?? crypto.randomUUID());
    if (!run.success || !scenario.success || !requestId.success) return c.json({ error: 'Invalid correlation metadata' }, 400);
    const runtimeScope: RuntimeScope = { targetRole: env.role, scenarioId: scenario.data, runId: run.data, requestId: requestId.data, releaseDigest: env.releaseDigest };
    if (serviceRead && authenticated && !new URL(c.req.url).search) diagnosticScopes.set(c.req.raw, runtimeScope);
    if (writeRead) {
      const intent = z.strictObject({ action: z.literal(d1WriteRead ? 'd1-write-read' : 'r2-write-read') }).safeParse(await c.req.json().catch(() => null));
      if (!intent.success || scenario.data !== 'waf-custom' || new URL(c.req.url).search) return c.json({ error: 'Exact synthetic storage probe scope required' }, 400);
      if (!resources) return c.json({ error: 'Storage resource identity unavailable' }, 503);
    }
    let verification: z.infer<typeof TurnstileReceiptSchema> | null = null;
    let registration: z.infer<typeof Registration> | null = null;
    if (operation === 'registration') {
      const parsed = Registration.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Invalid synthetic registration' }, 400);
      registration = parsed.data;
      if (scenario.data !== 'turnstile') return c.json({ error: 'Registration requires its own scenario scope' }, 400);
      if (verifier) { verification = await verifier.verify({ runId: run.data, requestId: requestId.data, recordId: registration.record_id }, registration.turnstileToken, c.req.raw.signal); if (!verification.accepted) return c.json({ error: 'Application verification rejected registration', verificationMode: verification.verificationMode, requestId: requestId.data }, verification.reason === 'unavailable' ? 503 : 403); }
      else if (env.role === 'after') return c.json({ error: 'Protected verifier unavailable' }, 503);
    }
    const product = await runtimeStep('d1', () => data.product('launch-shirt')); const detail = await runtimeStep('r2', () => assets.detail('launch-shirt'));
    if (!product || !detail) { if (diagnosticScopes.has(c.req.raw)) throw new RuntimeFailure(!product ? 'product' : 'r2', 'failed'); return c.json({ error: 'Synthetic services not seeded' }, 503); }
    const signature = new URL(c.req.url).searchParams.get('signature') ?? '';
    if (signature.length > 256) return c.json({ error: 'Signature too long' }, 400);
    const ray = RayId.safeParse(c.req.header('cf-ray'));
    const { turnstileToken: _discard, ...safeRegistration } = registration ?? { turnstileToken: null };
    const payload = { runId: run.data, requestId: requestId.data, scenarioId: scenario.data, targetRole: env.role, rayId: ray.success ? ray.data : null, operation, product, imageUrl: deliveryUrl, detail: `${detail.text}${signature ? ` Test signature: ${signature}` : ''}`, registration: registration ? safeRegistration : null };
    const key = `${env.role}:${scenario.data}:${run.data}`;
    const response = await runtimeStep('namespace', () => env.containers.getByName(key).fetch(new Request('http://container.internal/internal/render', { method: 'POST', headers: { authorization: `Bearer ${env.internalSecret}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: c.req.raw.signal })));
    if (!response.ok) {
      const text = await boundedText(response, 512).catch(() => '');
      const failure = readFailure(text, runtimeScope);
      if (failure) throw failure;
      if (diagnosticScopes.has(c.req.raw)) throw new RuntimeFailure('forward', 'http-rejected', response.status);
      return c.json({ error: 'Container or receipt channel unavailable', originCoverage: 'unknown' }, 503);
    }
    const raw = await runtimeStep('parse', () => boundedText(response, 32768));
    const parsed = await runtimeStep('parse', () => ContainerResponse.safeParse(JSON.parse(raw)));
    if (!parsed.success) { if (diagnosticScopes.has(c.req.raw)) throw new RuntimeFailure('parse', 'invalid'); return c.json({ error: 'Invalid Container response' }, 502); }
    const result = parsed.data;
    if (result.runId !== run.data || result.requestId !== requestId.data || result.targetRole !== env.role || result.releaseDigest !== env.releaseDigest) { if (diagnosticScopes.has(c.req.raw)) throw new RuntimeFailure('parse', 'invalid'); return c.json({ error: 'Container identity mismatch' }, 502); }
    if (operation === 'registration') {
      if (!result.operation || JSON.stringify(result.operation.value) !== JSON.stringify(safeRegistration)) return c.json({ error: 'Invalid persistence operation' }, 502);
      await data.scope(scenario.data, run.data).create(result.operation.value);
      if (verifier && verification) await verifier.markPersisted(verification);
    } else if (result.operation !== null) return c.json({ error: 'Unexpected persistence operation' }, 502);
    c.header('x-demo-request-id', requestId.data);
    c.header('x-lab-services', 'd1,r2,images-reference,container-completed');
    if (d1WriteRead) {
      const outcome = await runD1WriteRead(env.db, { role: env.role, runId: run.data, requestId: requestId.data });
      const receipt = D1WriteReadReceiptSchema.parse({ schemaVersion: 1, kind: 'd1-write-read', source: 'owned-worker-d1',
        targetRole: env.role, scenarioId: 'waf-custom', runId: run.data, requestId: requestId.data, releaseDigest: env.releaseDigest,
        observedAt: new Date().toISOString(), resourceId: resources!.d1, ...outcome });
      return c.json(receipt, receipt.write === 'observed' && receipt.read === 'observed' && receipt.cleanup === 'observed' ? 200 : 503);
    }
    if (r2WriteRead) {
      const outcome = await runR2WriteRead(env.bucket, { role: env.role, runId: run.data, requestId: requestId.data, signal: c.req.raw.signal });
      const receipt = R2WriteReadReceiptSchema.parse({ schemaVersion: 1, kind: 'r2-write-read', source: 'owned-worker-r2',
        targetRole: env.role, scenarioId: 'waf-custom', runId: run.data, requestId: requestId.data, releaseDigest: env.releaseDigest,
        observedAt: new Date().toISOString(), resourceId: resources!.r2, ...outcome });
      return c.json(receipt, receipt.write === 'observed' && receipt.read === 'observed' && receipt.cleanup === 'observed' ? 200 : 503);
    }
    if (serviceRead) return c.json(ServiceReadReceiptSchema.parse({ schemaVersion: 1, targetRole: env.role, runId: run.data, requestId: requestId.data, scenarioId: scenario.data, releaseDigest: env.releaseDigest, observedAt: new Date().toISOString(), operations: [
      { service: 'd1', operation: 'read', resourceId: resources?.d1 ?? null, contentDigest: await contentDigest(JSON.stringify(product)) },
      { service: 'r2', operation: 'read', resourceId: resources?.r2 ?? null, contentDigest: detail.digest },
      { service: 'container', operation: 'execute', resourceId: resources?.container ?? null, contentDigest: await contentDigest(result.html) },
    ] }));
    if (operation === 'registration') return c.json({ accepted: true, requestId: requestId.data }, 201);
    if (operation === 'api') {
      const scopedTls = authenticated && env.role === 'after' && scenario.data === 'api-shield' && explicitRun !== undefined && c.req.header('x-demo-request-id') !== undefined;
      const facts = scopedTls ? platformTlsVerification(Reflect.get(c.req.raw, 'cf'), {
        runId: run.data, requestId: requestId.data, releaseDigest: env.releaseDigest, hostname: origin.hostname, observedAt: new Date().toISOString(),
      }) : null;
      return c.json({ synthetic: true, product: product.product_id, requestId: requestId.data, ...(scopedTls ? { tlsClientVerification: facts } : {}) });
    }
    if (operation === 'admin' && authenticated && env.role === 'after' && scenario.data === 'access' && c.req.header('x-demo-test')?.startsWith('access-v1:')) {
      if (!env.accessIdentity) return c.json({ error: 'Access service verifier unavailable' }, 503);
      const verified = await accessServiceIdentityResponse(c.req.raw, { ...env.accessIdentity, origin: env.origin,
        releaseDigest: env.releaseDigest, runSecret: env.runSecret }, Date.now());
      return verified ?? c.json({ error: 'Access service observation unavailable' }, 503);
    }
    return c.html(result.html);
  });
  app.onError((error, c) => {
    const scope = diagnosticScopes.get(c.req.raw);
    return c.json({ error: 'Storefront request failed', ...(scope ? { runtimeFailure: failureRecord(scope, error) } : {}) }, 500);
  });
  return app;
}
