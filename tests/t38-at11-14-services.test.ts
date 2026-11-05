import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { StorefrontData, CATALOG_SEED, type Database } from '../apps/storefront-worker/src/d1.js';
import { OwnedAssets, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { installedBrowser } from './browser-transport-fixtures.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
import { SYNTHETIC_IMAGE_BASE64, SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
import { atRecord } from '../packages/demo-core/src/t38-at11-14-record.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { evaluateDeployment } from '../packages/demo-core/src/deployment-verification-core.js';
import { deploymentFixture, time, end } from './workshop-core-fixtures.js';
let mf: Miniflare; const envs: StorefrontBindings[] = []; const receipts: Receipt[] = [];
const runSecret = 'fixture-t38-run-secret-at-least-24'; const internalSecret = 'fixture-t38-internal-secret-at-least-24';
const previousTmp = process.env.TMPDIR;
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('Owned scratch required'); process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, r2Buckets: { BEFORE: 'before', AFTER: 'after' }, d1Persist: false, r2Persist: false });
  for (const role of ['before', 'after'] as const) {
    const db = await mf.getD1Database(role.toUpperCase()); await db.exec(readFileSync('apps/storefront-worker/migrations/0001_storefront.sql', 'utf8').replace(/\n/g, ' '));
    const bucket = await mf.getR2Bucket(role.toUpperCase()) as unknown as ObjectBucket;
    await new StorefrontData(db as unknown as Database, role).seed(); await new OwnedAssets(bucket, role).seedDetail('launch-shirt', 'Synthetic detail');
    const instances = new Map<string, ReturnType<typeof createContainerApp>>();
    envs.push({ role, db: db as unknown as Database, bucket, origin: `https://${role}.example.test`, releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret, internalSecret, labId: 'owned-lab',
      image: { id: 'launch-shirt', role, labId: 'owned-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'owned', variant: 'public', expectedDigest: SYNTHETIC_IMAGE_DIGEST },
      containers: { getByName(key) {
        let app = instances.get(key); if (!app) { const [scopeRole, scenarioId, runId] = key.split(':'); app = createContainerApp({ role: scopeRole as 'before' | 'after', scenarioId: scenarioId as 'waf-custom', runId: runId!, producerId: `${role}-fixture`, releaseDigest: 'a'.repeat(64), internalSecret, sendReceipt: async r => { receipts.push(r); } }); instances.set(key, app); }
        return { fetch: async request => app!.request(await fixtureReservedRequest(request, { producerId: `${role}-fixture`, releaseDigest: 'a'.repeat(64), internalSecret })) };
      } },
    });
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
describe('T38 AT-12 actual local bindings, Worker, Container and browser', () => {
  it('AT-12A renders both services and decodes each owned image in Chromium', async () => {
    const started = performance.now(); const browser = await installedBrowser(); const runId = randomUUID(); let calls = 0;
    try {
      for (const env of envs) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        try {
          const requestId = randomUUID();
          await context.route('**/*', async route => {
            calls++; const url = new URL(route.request().url());
            if (url.origin === env.origin && url.pathname === '/catalog') {
              const response = await createStorefrontWorker(env).request(url.href, { headers: { 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': runSecret } });
              await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
            } else if (url.origin === 'https://imagedelivery.net' && url.pathname === '/owned/launch-shirt/public') await route.fulfill({ contentType: 'image/png', body: Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64') });
            else await route.abort();
          });
          const page = await context.newPage(); await page.goto(`${env.origin}/catalog`);
          expect(await page.locator('h1').innerText()).toBe(CATALOG_SEED.title);
          expect(await page.locator('img').evaluate(async image => { await (image as HTMLImageElement).decode(); return (image as HTMLImageElement).naturalWidth; })).toBeGreaterThan(0);
          expect(receipts.some(r => r.runId === runId && r.requestId === requestId && r.targetRole === env.role && r.stage === 'entry')).toBe(true);
          expect(await new OwnedAssets(env.bucket, env.role).detail('launch-shirt')).toMatchObject({ text: 'Synthetic detail' });
        } finally { await context.close(); }
      }
      const artifacts = receipts.filter(r => r.runId === runId).map(r => makeArtifact({ id: r.id, mode: 'fixture', runId, scenarioId: r.scenarioId, targetRole: r.targetRole, requestId: r.requestId, observedAt: r.observedAt, source: 'origin', payload: r }).artifact);
      const record = atRecord({ id: 'AT-12A', artifacts, releaseDigest: envs[0]!.releaseDigest, requestsUsed: calls, durationMs: performance.now() - started, checks: [{ name: 'Local pair Container receipts and image decode', passed: receipts.filter(r => r.runId === runId && r.stage === 'entry').length === 2 }] });
      console.info(JSON.stringify(record)); expect(record.mode).toBe('fixture'); expect(record.outcome).toBe('unavailable');
    } finally { await browser.close(); }
  }, 30000);
  it('AT-12A names missing bindings and refuses Worker-only or undecoded-image proof', () => {
    for (const service of ['d1', 'r2', 'images', 'container'] as const) {
      const f = deploymentFixture(); const after = structuredClone(f.state);
      if (service === 'images') after.bindings.after.images = []; else after.bindings.after[service] = null;
      f.probes[1]!.operations = f.probes[1]!.operations.filter(o => o.service !== service);
      const result = evaluateDeployment({ mode: 'fixture', config: f.config, expected: f.state, before: f.state, after, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: end });
      expect(result.deploymentVerified).toBe(false); expect(result.blockers).toContain('matching-functional-state');
      expect(result.blockers.some(b => b.startsWith(`after-${service}-`))).toBe(true);
    }
  });
  it('AT-12B protects every ownership tuple and keeps repeated seeds stable', async () => {
    const started = performance.now(); const otherRun = randomUUID(); const id = randomUUID(); let checks = 0;
    for (const env of envs) {
      const run = randomUUID();
      const data = new StorefrontData(env.db, env.role); const assets = new OwnedAssets(env.bucket, env.role);
      const owner = data.scope('waf-custom', run); const objects = assets.scope('waf-custom', run);
      await owner.create({ record_id: id, display_name: 'synthetic-owner', note: 'owner' }); await objects.put('owned', 'owner');
      const otherEnv = envs.find(e => e.role !== env.role)!;
      const tuples = [{ data, assets, scenario: 'turnstile' as const, run }, { data, assets, scenario: 'waf-custom' as const, run: otherRun }, { data: new StorefrontData(otherEnv.db, otherEnv.role), assets: new OwnedAssets(otherEnv.bucket, otherEnv.role), scenario: 'waf-custom' as const, run }];
      for (const tuple of tuples) {
        const d = tuple.data.scope(tuple.scenario, tuple.run); const a = tuple.assets.scope(tuple.scenario, tuple.run);
        expect(await d.get(id)).toBeNull(); expect(await a.get('owned')).toBeNull(); await expect(d.updateNote(id, 'corrupt')).rejects.toThrow();
        await d.cleanup(); await a.cleanup(); expect((await owner.get(id))?.note).toBe('owner'); expect(await objects.get('owned')).toBe('owner');
        await d.create({ record_id: id, display_name: 'synthetic-other', note: 'other' }); await a.put('owned', 'other'); checks++;
      }
      await owner.cleanup(); await objects.cleanup(); expect(await owner.get(id)).toBeNull(); expect(await objects.get('owned')).toBeNull();
      for (const t of tuples) { expect((await t.data.scope(t.scenario, t.run).get(id))?.note).toBe('other'); expect(await t.assets.scope(t.scenario, t.run).get('owned')).toBe('other'); }
      await data.seed(); await data.seed(); await assets.seedDetail('launch-shirt', 'Synthetic detail');
      expect(await env.db.prepare('SELECT COUNT(*) AS count FROM catalog').first()).toEqual({ count: 1 });
      expect((await env.bucket.list({ prefix: 'catalog/', limit: 100 })).objects).toHaveLength(1);
      expect(await data.product('launch-shirt')).toEqual(CATALOG_SEED);
      expect(createHash('sha256').update(Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64')).digest('hex')).toBe(env.image.expectedDigest);
      const container = (runId: string) => createContainerApp({ role: env.role, scenarioId: 'waf-custom', runId, producerId: `${env.role}-isolated`, releaseDigest: env.releaseDigest, internalSecret, sendReceipt: async r => { receipts.push(r); } });
      const first = container(run); const second = container(otherRun);
      const payload = { runId: run, requestId: randomUUID(), scenarioId: 'waf-custom', targetRole: env.role, rayId: null, operation: 'catalog', product: CATALOG_SEED, imageUrl: 'https://imagedelivery.net/owned/launch-shirt/public', detail: 'Synthetic detail', registration: null };
      const render = async (value: typeof payload) => first.request(await fixtureReservedRequest(new Request('http://container.internal/internal/render', { method: 'POST', headers: { authorization: `Bearer ${internalSecret}`, 'content-type': 'application/json' }, body: JSON.stringify(value) }), { producerId: `${env.role}-isolated`, releaseDigest: env.releaseDigest, internalSecret }));
      expect((await render(payload)).status).toBe(200); expect((await render({ ...payload, runId: otherRun })).status).toBe(403);
      const checkpoint = async (app: ReturnType<typeof createContainerApp>) => (await (await app.request('http://container.internal/internal/checkpoint', { headers: { authorization: `Bearer ${internalSecret}` } })).json() as { lastAttemptedSequence: number }).lastAttemptedSequence;
      expect(await checkpoint(first)).toBe(2); expect(await checkpoint(second)).toBe(0);
    }
    const record = atRecord({ id: 'AT-12B', releaseDigest: envs[0]!.releaseDigest, requestsUsed: 0, durationMs: performance.now() - started, checks: [{ name: 'Six foreign tuples and stable immutable seeds', passed: checks === 6 }] }); console.info(JSON.stringify(record)); expect(record.outcome).toBe('unavailable');
  });
});
