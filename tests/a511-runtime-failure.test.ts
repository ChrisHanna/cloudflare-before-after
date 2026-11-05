import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { CATALOG_SEED } from '../apps/storefront-worker/src/d1.js';
import { contentDigest } from '../apps/storefront-worker/src/assets.js';
import { RuntimeFailure, failureRecord, readFailure, runtimeStep, type RuntimeScope } from '../apps/storefront-worker/src/runtime-failure.js';
import { relayReceipt, telemetryOrigin, checkpointFor } from '../apps/storefront-worker/src/runtime-transport.js';
const canary = 'CANARY_PROVIDER_PRIVATE'; const secret = 'a511-only-synthetic-run-secret';
const scope = (): RuntimeScope => ({ targetRole: 'before', scenarioId: 'analytics', runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64) });
async function fixture(fault: 'd1' | 'product' | 'r2' | 'namespace' | 'parse' | 'remote' = 'd1') {
  const text = 'Synthetic detail'; const digest = await contentDigest(text);
  const env = { role: 'before', origin: 'https://synthetic.example.test', releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret: secret, internalSecret: secret, labId: 'synthetic-lab',
    db: { prepare() { return { bind() { return this; }, async first() { if (fault === 'd1') throw new Error(canary); return fault === 'product' ? { ...CATALOG_SEED, title: canary.repeat(20) } : CATALOG_SEED; } }; } },
    bucket: { get: async () => { if (fault === 'r2') throw new Error(canary); return { customMetadata: { digest, ownership: 'immutable-catalog', environment: 'before' }, text: async () => text }; } },
    image: { id: 'synthetic-shirt', role: 'before', labId: 'synthetic-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'b'.repeat(64) },
    containers: { getByName() { if (fault === 'namespace') throw new Error(canary); return { fetch: async (request: Request) => {
      const p = await request.json() as any;
      if (fault === 'parse') return new Response(canary);
      if (fault === 'remote') return Response.json({ ...failureRecord({ targetRole: p.targetRole, scenarioId: p.scenarioId, runId: randomUUID(), requestId: p.requestId, releaseDigest: 'a'.repeat(64) }, new RuntimeFailure('registry', 'http-rejected', 401)), provider: canary }, { status: 503, headers: { 'x-private-provider': canary } });
      throw new Error(canary);
    } }; } },
  } as unknown as StorefrontBindings;
  return { app: createStorefrontWorker(env), env };
}
const headers = (s: RuntimeScope) => ({ 'x-demo-run-id': s.runId, 'x-demo-request-id': s.requestId, 'x-demo-scenario': s.scenarioId, 'x-demo-run-token': secret });
describe('finite private request-local runtime diagnostics', () => {
  it('keeps the public failure generic and all canaries out of responses, headers and logs', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    try {
      for (const stage of ['d1', 'product', 'r2', 'namespace', 'parse', 'remote'] as const) {
        const f = await fixture(stage); const response = await f.app.request(`${f.env.origin}/catalog`);
        expect(await response.text()).toBe(stage === 'remote' ? '{"error":"Container or receipt channel unavailable","originCoverage":"unknown"}' : '{"error":"Storefront request failed"}');
        expect(JSON.stringify([...response.headers])).not.toContain(canary);
        const s = scope(); const privateResponse = await f.app.request(`${f.env.origin}/internal/service-read`, { headers: headers(s) }); const body = await privateResponse.json() as any;
        expect(body.runtimeFailure).toMatchObject({ ...s, schemaVersion: 1, stage: stage === 'remote' ? 'forward' : stage });
        expect(JSON.stringify(body)).not.toContain(canary); expect(JSON.stringify([...privateResponse.headers])).not.toContain(canary);
        expect(Buffer.byteLength(JSON.stringify(body.runtimeFailure))).toBeLessThanOrEqual(512);
        expect(body.runtimeFailure.httpStatus).toBe(stage === 'remote' ? 503 : undefined);
      }
      for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(canary);
    } finally { logs.forEach(log => log.mockRestore()); }
  });
  it('requires authenticated exact valid scope; rejects malformed correlation without diagnostics', async () => {
    const { app, env } = await fixture();
    for (const h of [{}, { ...headers(scope()), 'x-demo-run-token': 'forged' }, { ...headers(scope()), 'x-demo-run-id': 'not-a-uuid' }, { ...headers(scope()), 'x-demo-scenario': canary }]) {
      const response = await app.request(`${env.origin}/internal/service-read`, { headers: h }); expect(response.status).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain('runtimeFailure');
    }
    const response = await app.request(`${env.origin}/catalog`, { headers: headers(scope()) }); expect(await response.text()).not.toContain('runtimeFailure');
  });
  it('isolates concurrent runs and never returns stale state', async () => {
    const { app, env } = await fixture(); const scopes = Array.from({ length: 20 }, scope);
    const results = await Promise.all(scopes.map(async s => (await app.request(`${env.origin}/internal/service-read`, { headers: headers(s) })).json() as Promise<any>));
    for (let n = 0; n < scopes.length; n++) expect(results[n].runtimeFailure).toMatchObject(scopes[n]!);
    expect(await (await app.request(`${env.origin}/catalog`)).text()).not.toContain('runtimeFailure');
  });
  it('rejects unknown fields/stages/codes, forged run/role/release/correlation and oversized records', () => {
    const s = scope(); const record = failureRecord(s, new RuntimeFailure('registry', 'http-rejected', 401));
    expect(readFailure(JSON.stringify(record), s)).toBeInstanceOf(RuntimeFailure);
    for (const change of [{ runId: randomUUID() }, { targetRole: 'after' }, { requestId: randomUUID() }, { releaseDigest: 'b'.repeat(64) }, { stage: canary }, { code: canary }, { provider: canary }, { httpStatus: 0 }]) expect(readFailure(JSON.stringify({ ...record, ...change }), s)).toBeNull();
    expect(readFailure(' '.repeat(513), s)).toBeNull();
    expect(readFailure(JSON.stringify({ ...record, provider: canary.repeat(100) }), s)).toBeNull();
  });
  it('no-response errors have no invented HTTP status or raw error data', async () => {
    for (const error of [new TypeError(canary), new DOMException(canary, 'AbortError'), new DOMException(canary, 'TimeoutError'), { message: canary, stack: canary, status: 401 }]) {
      let captured: unknown;
      try { await runtimeStep('registry', () => { throw error; }); } catch (value) { captured = value; }
      const record = failureRecord(scope(), captured); expect(record.httpStatus).toBeUndefined(); expect(JSON.stringify(record)).not.toContain(canary); expect(record.code).toBe(error instanceof DOMException ? error.name === 'AbortError' ? 'cancelled' : 'timeout' : 'unknown');
    }
  });
  it('denies raw URL ambiguity before dispatch; checkpoint acknowledgments bind exact owner', async () => {
    const dispatch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(canary));
    try {
      for (const origin of ['http://telemetry.example.test', 'https://user:pass@telemetry.example.test', 'https://telemetry.example.test:444', 'https://telemetry.example.test/', 'https://*.example.test']) expect(() => telemetryOrigin(origin)).toThrow();
      for (const url of ['https://user:pass@telemetry.example.test/ingest', 'https://telemetry.example.test/ingest#fragment']) {
        // Request-shaped input retains raw fields that native Request canonicalizes away.
        const response = await relayReceipt({ url, method: 'POST' } as Request, { TELEMETRY_ORIGIN: 'https://telemetry.example.test', ROLE: 'before', RELEASE_DIGEST: 'a'.repeat(64), INGEST_ROOT_SECRET: secret }, {});
        expect(response.status).toBe(403);
      }
      expect(dispatch).not.toHaveBeenCalled();
      const owner = { producerId: 'synthetic', role: 'before' as const, scenarioId: 'analytics' as const, runId: randomUUID(), releaseDigest: 'a'.repeat(64) };
      const checkpoint = { producerId: owner.producerId, targetRole: owner.role, scenarioId: owner.scenarioId, runId: owner.runId, lastAttemptedSequence: 2, healthy: true, watermark: new Date().toISOString() };
      expect(checkpointFor(checkpoint, owner)).toEqual(checkpoint);
      for (const change of [{ producerId: 'foreign' }, { targetRole: 'after' }, { runId: randomUUID() }, { scenarioId: 'waf-custom' }, { provider: canary }]) expect(() => checkpointFor({ ...checkpoint, ...change }, owner)).toThrow();
    } finally { dispatch.mockRestore(); }
  });
});
