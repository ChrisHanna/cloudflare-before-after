import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json')));
const { build } = require('esbuild');
const mfPath = require.resolve('miniflare');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(mfPath);
const mfRequire = createRequire(mfPath);
const workerd = mfRequire('workerd');
assert.equal(workerd.version, '1.20261103.1');
process.env.MINIFLARE_WORKERD_PATH = workerd.default;
const scratch = await mkdtemp(join(tmpdir(), 'a511-author-native-'));
const baseline = process.argv.includes('--baseline');
const bundle = await build({ entryPoints: [join(root, 'tests/runtime/a511-native-worker.fixture')], loader: { '.fixture': 'js' }, write: false, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], nodePaths: [join(root, 'apps/storefront-worker/node_modules')], logLevel: 'silent', plugins: baseline ? [{ name: 'reverse-only-original-unsupported-redirect', setup(b) { b.onLoad({ filter: /runtime-transport\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace("redirect: 'manual'", "redirect: 'error'"), loader: 'ts' })); } }] : [] });
const secret = 'offline-only-a511-native-synthetic-secret'; const release = 'a'.repeat(64); const viewRun = randomUUID();
const dispatches = []; let status = 204; let mode = '';
const opts = convertV4MiniflareOptions({ rootPath: scratch, modules: true, script: bundle.outputFiles[0].text, scriptPath: join(scratch, 'bundle.mjs'), name: 'a511-native', compatibilityDate: '2026-11-03', compatibilityFlags: [], host: '127.0.0.1', port: 0, cf: false, unsafeRegisterWorker: false, unsafeInspectorProxy: false, unsafeLocalExplorer: false, unsafeObservability: false, telemetry: { enabled: false }, resourceTmpPath: join(scratch, 'runtime'), log: new Log(LogLevel.NONE), logRequests: false,
 durableObjects: { ORIGINS: { className: 'RuntimeHarness', useSQLite: true } }, r2Buckets: { OBJECTS: 'synthetic' }, d1Databases: { DB: 'synthetic' },
 bindings: { ROLE: 'before', ORIGIN: 'https://synthetic.example.test', LAB_ID: 'synthetic-lab', RELEASE_DIGEST: release, VIEW_RUN_ID: viewRun, TELEMETRY_ORIGIN: 'https://telemetry.example.test', RUN_SECRET: secret, INTERNAL_SECRET: secret, INGEST_ROOT_SECRET: secret, REGISTRY_SECRET: secret, SETUP_SECRET: secret, IMAGE_ASSET_JSON: JSON.stringify({ id: 'synthetic-shirt', role: 'before', labId: 'synthetic-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'b'.repeat(64) }) },
 outboundService: async request => {
   const u = new URL(request.url); dispatches.push({ origin: u.origin, path: u.pathname });
   assert.ok(['https://telemetry.example.test', 'https://challenges.cloudflare.com'].includes(u.origin), 'closed adapter rejects destination');
   if (u.origin === 'https://challenges.cloudflare.com') {
     const code = Number(request.headers.get('x-fixture-status')); const body = request.headers.get('x-fixture-body');
     if (body === 'timeout') await new Promise(r => setTimeout(r, 30));
     return code === 200 ? new Response(body === 'malformed' ? 'CANARY_PROVIDER_PRIVATE' : JSON.stringify({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }), { status: 200 }) : new Response(null, { status: code, headers: { location: 'https://denied.example.test/token' } });
   }
   assert.ok(['/registry', '/producer-status', '/ingest'].includes(u.pathname));
   if (u.pathname === '/registry') assert.equal(request.headers.get('authorization'), `Bearer ${secret}`, 'registry authorization must match');
   if (mode === 'throw') throw new Error('CANARY_PROVIDER_PRIVATE');
   if (mode === 'wait') await new Promise(r => setTimeout(r, 30));
   assert.equal(request.headers.get('cookie'), null, 'relay must not forward arbitrary headers');
   const p = await request.json();
   if (u.pathname === '/ingest') return new Response(null, { status, headers: { 'x-receipt-id': mode === 'wrong-ack' ? randomUUID() : p.id, ...(status >= 300 && status < 400 ? { location: 'https://denied.example.test/steal' } : {}) } });
   return new Response(null, { status, ...(status >= 300 && status < 400 ? { headers: { location: 'https://denied.example.test/steal' } } : {}) });
 } });
const mf = new Miniflare(opts); let checks = 0;
const call = (path, init) => mf.dispatchFetch(`https://synthetic.example.test${path}`, init);
const post = value => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
const correlation = (runId = randomUUID()) => ({ 'x-demo-run-id': runId, 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'analytics', 'x-demo-run-token': secret });
const assertPrivate = async response => { const text = await response.text(); assert.ok(!text.includes('CANARY_PROVIDER_PRIVATE') && !JSON.stringify([...response.headers]).includes('CANARY_PROVIDER_PRIVATE')); return text; };
try {
  const db = await mf.getD1Database('DB');
  for (const migration of ['0001_storefront.sql', '0004_turnstile.sql']) await db.exec((await readFile(join(root, 'apps/storefront-worker/migrations', migration), 'utf8')).replace(/\n/g, ' '));
  assert.equal((await call('/internal/seed', { method: 'POST', headers: { authorization: `Bearer ${secret}` } })).status, 200); checks++;
  assert.equal((await (await call('/redirect-contract')).json()).rejected, true); checks++;
  console.log('native: catalog');
  const first = await call('/catalog'); assert.equal(first.status, process.argv.includes('--require-catalog-200') ? 200 : baseline ? 500 : 200); await assertPrivate(first); checks++;
  if (!baseline) {
    console.log('native: sdk/checkpoint');
    const key = `before:analytics:${viewRun}`;
    const facts = await (await call(`/facts?key=${encodeURIComponent(key)}`)).json();
    assert.equal(facts.nativeKv, 'function'); assert.equal(facts.nativeSql, 'function'); assert.equal(facts.intercepted, true);
    assert.ok(facts.events.some(e => e.kind === 'https' && e.host === '*')); assert.ok(facts.events.some(e => e.kind === 'http'));
    assert.equal(facts.events.find(e => e.kind === 'start').internet, false);
    assert.equal(facts.events.find(e => e.kind === 'start').ca, '/etc/cloudflare/certs/cloudflare-containers-ca.crt'); checks++;
    assert.equal((await call(`/internal/checkpoint?scenarioId=analytics&runId=${viewRun}`, { headers: { 'x-demo-run-token': secret } })).status, 200); checks++;
    for (const code of [401, 200, 301, 302, 303, 307, 308]) {
      status = code; const before = dispatches.length; const response = await call('/catalog', { headers: correlation() });
      assert.equal(response.status, 500); await assertPrivate(response); assert.equal(dispatches.length - before, 1); checks++;
    }
    console.log('native: ack matrix');
    for (const path of ['/registry', '/producer-status']) {
      for (const code of [204, 401, 200, 301, 302, 303, 307, 308]) { status = code; const before = dispatches.length; const result = await (await call('/ack', post({ path }))).json(); assert.equal(result.accepted, code === 204); assert.equal(dispatches.length - before, 1); checks++; }
      status = 204;
      for (const extra of [{ cancel: true }, { timeout: true }]) { mode = 'wait'; const result = await (await call('/ack', post({ path, ...extra }))).json(); assert.equal(result.accepted, false); checks++; }
      mode = '';
    }
    status = 204;
    console.log('native: fault stages');
    for (const [fault, stage] of [['start', 'start-ports'], ['forward', 'forward'], ['parse', 'parse']]) {
      const headers = correlation(); const faultKey = `before:analytics:${headers['x-demo-run-id']}`;
      console.log(`native: fault ${fault}`);
      await call(`/fault?key=${encodeURIComponent(faultKey)}`, post({ fault }));
      const response = await call('/internal/service-read', { headers }); const text = await assertPrivate(response); const body = JSON.parse(text);
      assert.equal(response.status, 500); assert.equal(body.runtimeFailure.stage, stage); assert.equal(body.runtimeFailure.runId, headers['x-demo-run-id']); assert.equal(body.runtimeFailure.httpStatus, undefined); checks++;
    }
    mode = 'throw';
    const h = correlation(); const failed = await call('/internal/service-read', { headers: h }); const data = JSON.parse(await assertPrivate(failed));
    assert.equal(data.runtimeFailure.stage, 'registry'); assert.equal(data.runtimeFailure.httpStatus, 500); checks++; mode = '';
    // Native SDK ContainerProxy handler, real HMAC, exact scope and receipt ack.
    console.log('native: relay');
    const owner = await (await call(`/internal/checkpoint?scenarioId=analytics&runId=${viewRun}`, { headers: { 'x-demo-run-token': secret } })).json();
    const identity = { producerId: owner.producerId, role: 'before', scenarioId: 'analytics', runId: viewRun, releaseDigest: release };
    const { createHmac } = await import('node:crypto'); const ingest = createHmac('sha256', secret).update(JSON.stringify(identity)).digest('hex');
    const reserved = (await (await call(`/facts?key=${encodeURIComponent(key)}`)).json()).lastReservation; const reservation = JSON.parse(reserved.encoded);
    const receipt = { schemaVersion: 1, id: reservation.entry.id, runId: viewRun, requestId: reservation.requestId, scenarioId: 'analytics', targetRole: 'before', producerId: identity.producerId, sequence: reservation.entry.sequence, observedAt: reservation.observedAt, rayId: null, releaseDigest: release, stage: 'entry' };
    const spec = { url: 'https://telemetry.example.test/ingest', method: 'POST', headers: { authorization: `Bearer ${ingest}`, 'content-type': 'application/json', cookie: 'CANARY_PROVIDER_PRIVATE', 'x-origin-receipt-reservation': reserved.encoded, 'x-origin-receipt-signature': reserved.signature }, body: JSON.stringify(receipt) };
    const relay = value => call(`/relay?key=${encodeURIComponent(key)}`, post(value));
    for (const stage of ['entry', 'completion']) { assert.equal((await relay({ ...spec, body: JSON.stringify({ ...receipt, stage, id: reservation[stage].id, sequence: reservation[stage].sequence }) })).status, 204); checks++; }
    for (const change of [ { url: 'http://telemetry.example.test/ingest' }, { url: 'https://denied.example.test/ingest' }, { url: 'https://telemetry.example.test:444/ingest' }, { url: 'https://telemetry.example.test/other' }, { url: 'https://telemetry.example.test/ingest?q=x' }, { method: 'PUT' }, { headers: { authorization: 'Bearer wrong' } }, { body: JSON.stringify({ ...receipt, runId: randomUUID() }) }, { body: JSON.stringify({ ...receipt, targetRole: 'after' }) }, { body: JSON.stringify({ ...receipt, scenarioId: 'waf-custom' }) }, { body: JSON.stringify({ ...receipt, producerId: 'forged' }) }, { body: JSON.stringify({ ...receipt, releaseDigest: 'b'.repeat(64) }) }, { body: JSON.stringify({ ...receipt, provider: 'untrusted' }) }, { body: 'CANARY_PROVIDER_PRIVATE' } ]) {
      const before = dispatches.length; const response = await relay({ ...spec, ...change }); assert.notEqual(response.status, 204); await assertPrivate(response); assert.equal(dispatches.length, before); checks++;
    }
    for (const code of [401, 200, 301, 302, 303, 307, 308]) { status = code; const before = dispatches.length; assert.notEqual((await relay(spec)).status, 204); assert.equal(dispatches.length - before, 1); checks++; }
    status = 204; mode = 'wrong-ack'; assert.equal((await relay(spec)).status, 503); mode = ''; checks++;
    // These are actual native Worker fetches of the real verifier, not Node mocks.
    console.log('native: turnstile');
    for (const code of [200, 401, 301, 302, 303, 307, 308]) {
      const before = dispatches.length; const response = await call('/turnstile', post({ status: code, runId: randomUUID(), requestId: randomUUID(), recordId: randomUUID(), token: randomUUID() }));
      const result = await response.json(); assert.equal(result.accepted, code === 200); assert.equal(dispatches.length - before, 1); assert.ok(!JSON.stringify(result).includes('CANARY')); checks++;
    }
    for (const extra of [{ body: 'malformed' }, { cancel: true }, { timeout: true, body: 'timeout' }]) { const result = await (await call('/turnstile', post({ status: 200, runId: randomUUID(), requestId: randomUUID(), recordId: randomUUID(), token: randomUUID(), ...extra }))).json(); assert.equal(result.accepted, false); assert.ok(!JSON.stringify(result).includes('CANARY')); checks++; }
    const replay = { status: 200, runId: randomUUID(), requestId: randomUUID(), recordId: randomUUID(), token: randomUUID() };
    assert.equal((await (await call('/turnstile', post(replay))).json()).accepted, true);
    const before = dispatches.length; assert.equal((await (await call('/turnstile', post({ ...replay, requestId: randomUUID() }))).json()).reason, 'replay'); assert.equal(dispatches.length, before); checks++;
  }
  assert.ok(dispatches.every(e => e.origin !== 'https://denied.example.test')); checks++;
} finally { await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
console.log(JSON.stringify({ kind: 'a511-native-runtime', mode: baseline ? 'baseline' : 'repaired', checks, cloudRequests: 0, runtime: 'workerd 1.20261103.1; SDK 0.3.7', realm: 'native namespace/storage/streams/SQL/R2; synthetic supervisor/TCP; closed outbound adapter' }));
