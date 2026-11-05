import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { createContainerApp, receiptSender } from '../apps/storefront-container/src/app.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { StorefrontData, type Database } from '../apps/storefront-worker/src/d1.js';
import { OwnedAssets, contentDigest, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import { createTelemetryApp, type Producer } from '../apps/storefront-worker/src/telemetry.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import type { BrowserTransportOptions } from '../packages/demo-core/src/browser-transport.js';
import { SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
const ROOT = '/mnt/c/users/NotAPC/Desktop/cloudflare_before_after';
/** All edge/config/image responses are FIXTURE transports. Worker business paths,
 * Container receipts, authenticated telemetry, SQLite and object storage are real
 * local production modules. No mock receipt is accepted from demoLabFixture.
 */
export async function t38Bindings(root: string, fault?: 'ingest') {
  const lab = demoLabFixture(root); const receipts: Receipt[] = []; const producers: Producer[] = [];
  const internalSecret = 'fixture-t38-internal-secret-at-least-24';
  const ingestSecret = 'fixture-t38-ingest-secret-at-least-24';
  const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("fixture"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, r2Buckets: { BEFORE: 'before', AFTER: 'after' }, d1Persist: false, r2Persist: false });
  const bindings = new Map<'before' | 'after', StorefrontBindings>();
  const instances = new Map<string, ReturnType<typeof createContainerApp>>();
  const telemetry = (role: 'before' | 'after', acceptance?: { schemaVersion: 1; receiptId: string; acceptedAt: string; receiptDigest: string }) => createTelemetryApp({ db: bindings.get(role)!.db, role, origin: lab.config.telemetryOrigin, readerSecret: lab.credentials.collector, producers: producers.filter(p => p.role === role), ...(acceptance ? { acceptance } : {}) });
  try {
    for (const env of lab.config.environments) {
      const localDb = await mf.getD1Database(env.role.toUpperCase());
      for (const migration of ['0001_storefront.sql', '0002_receipts.sql', '0006_receipt_stage_acceptance.sql']) await localDb.exec(readFileSync(`${ROOT}/apps/storefront-worker/migrations/${migration}`, 'utf8').replace(/\n/g, ' '));
      const db = localDb as unknown as Database;
      const bucket = await mf.getR2Bucket(env.role.toUpperCase()) as unknown as ObjectBucket;
      await new StorefrontData(db, env.role).seed(); await new OwnedAssets(bucket, env.role).seedDetail('launch-shirt', 'Synthetic launch shirt. Demo data only.');
      bindings.set(env.role, { role: env.role, origin: env.origin, releaseDigest: env.releaseDigest, viewRunId: randomUUID(), runSecret: lab.credentials.runner, internalSecret, labId: lab.config.labId, db, bucket,
        image: { id: env.imageIds[0]!, role: env.role, labId: lab.config.labId, immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'fixture-account', variant: lab.inventory.image_variant, expectedDigest: SYNTHETIC_IMAGE_DIGEST },
        serviceResources: { d1: env.d1Id, r2: env.r2Bucket, container: env.containerBinding },
        containers: { getByName(key) {
          let app = instances.get(key);
          const [scopeRole, scopeScenario, scopeRun] = key.split(':');
          if (!app) {
            const [role, scenarioId, runId] = key.split(':') as ['before' | 'after', 'waf-custom' | 'waiting-room', string];
            const producer = { producerId: `p-${randomUUID()}`, role, scenarioId, runId, releaseDigest: env.releaseDigest, ingestSecret }; producers.push(producer);
            app = createContainerApp({ ...producer, internalSecret, sendReceipt: receiptSender(`${lab.config.telemetryOrigin}/ingest`, ingestSecret, async (url, init) => {
              if (fault === 'ingest') return new Response(null, { status: 503 });
              const body = String(init?.body); const stored = JSON.parse(body) as Receipt;
              const response = await telemetry(role, { schemaVersion: 1, receiptId: stored.id, acceptedAt: new Date().toISOString(), receiptDigest: await contentDigest(body) }).request(String(url), init);
              if (response.status === 204) receipts.push(JSON.parse(String(init?.body)));
              return response;
            }) }); instances.set(key, app);
          }
          const producerId = producers.findLast(p => p.role === scopeRole && p.scenarioId === scopeScenario && p.runId === scopeRun)!.producerId;
          return { fetch: async request => app!.request(await fixtureReservedRequest(request, { producerId, releaseDigest: env.releaseDigest, internalSecret })) };
        } },
      });
    }
  } catch (error) { await mf.dispose(); throw error; }
  const dispatch = async (value: string, init: RequestInit): Promise<Response> => {
    const url = new URL(value); const env = lab.config.environments.find(e => e.origin === url.origin);
    if (url.origin === lab.config.telemetryOrigin) {
      lab.calls.push({ url: value, method: init.method ?? 'GET' });
      const role = url.searchParams.get('role'); if (role !== 'before' && role !== 'after') throw new Error('Unapproved fixture receipt scope');
      url.searchParams.delete('role'); return telemetry(role).request(url.href, init);
    }
    if (env && url.pathname === '/internal/checkpoint') {
      lab.calls.push({ url: value, method: init.method ?? 'GET' });
      if (new Headers(init.headers).get('x-demo-run-token') !== lab.credentials.runner) return new Response(null, { status: 401 });
      const key = `${env.role}:${url.searchParams.get('scenarioId')}:${url.searchParams.get('runId')}`;
      const stub = bindings.get(env.role)!.containers.getByName(key);
      const response = await stub.fetch(new Request('http://container.internal/internal/checkpoint', { headers: { authorization: `Bearer ${internalSecret}` } }));
      const status = await telemetry(env.role).request(`${lab.config.telemetryOrigin}/producer-status`, { method: 'POST', headers: { authorization: `Bearer ${ingestSecret}`, 'content-type': 'application/json' }, body: await response.clone().text() });
      if (status.status !== 204) throw new Error('Actual producer checkpoint not accepted');
      return response;
    }
    if (env && url.pathname === '/internal/service-read') {
      lab.calls.push({ url: value, method: init.method ?? 'GET' });
      return createStorefrontWorker(bindings.get(env.role)!).request(value, init);
    }
    if (env) {
      const edge = await lab.dispatch(value, init);
      if (edge.status !== 200) return edge;
      const headers = new Headers(init.headers); headers.set('cf-ray', edge.headers.get('cf-ray')!.split('-')[0]!);
      const response = await createStorefrontWorker(bindings.get(env.role)!).request(value, { ...init, headers });
      response.headers.set('cf-ray', edge.headers.get('cf-ray')!); return response;
    }
    return lab.dispatch(value, init);
  };
  let roomRunId = ''; const visits = new Map<string, number>();
  const browserFixture: NonNullable<BrowserTransportOptions['fixture']> = async request => {
    const url = new URL(request.url);
    // Binary Images delivery is tested in the real UI browser route. The
    // existing runner fixture interface accepts UTF-8 only; never fake a PNG.
    if (url.origin === 'https://imagedelivery.net') { lab.calls.push({ url: request.url, method: request.method }); return { status: 503, contentType: 'text/plain', body: 'FIXTURE binary image transport unavailable' }; }
    const env = lab.config.environments.find(e => e.origin === url.origin); if (!env || !request.requestId) throw new Error('Unapproved fixture browser request');
    lab.calls.push({ url: request.url, method: request.method });
    const n = (visits.get(request.sessionId) ?? 0) + 1; visits.set(request.sessionId, n);
    if (request.sessionId === 'session-3' && n === 1) return { status: 200, contentType: 'text/html', headers: { 'set-cookie': '__cfwaitingroom=t38-secret-cookie; Path=/; Secure; HttpOnly' }, body: '<main data-queue><p data-demo-public>Synthetic shopper</p><p>FIXTURE queue</p></main>' };
    const response = await createStorefrontWorker(bindings.get(env.role)!).request(request.url, { headers: { 'x-demo-run-token': lab.credentials.runner, 'x-demo-run-id': roomRunId, 'x-demo-scenario': 'waiting-room', 'x-demo-request-id': request.requestId } });
    return { status: response.status, headers: Object.fromEntries(response.headers), contentType: 'text/html', body: await response.text() };
  };
  return { ...lab, bindings, dispatch, receipts, visits, browserFixture, setRoomRunId: (id: string) => { roomRunId = id; }, dispose: () => mf.dispose() };
}
