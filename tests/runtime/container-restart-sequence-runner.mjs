import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json'))); const { build } = require('esbuild');
const mfPath = require.resolve('miniflare'); const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(mfPath);
const runtime = createRequire(mfPath)('workerd'); process.env.MINIFLARE_WORKERD_PATH = runtime.default;
const executable = await realpath(runtime.default); const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim(); const binarySha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const scratch = await mkdtemp(join(tmpdir(), 'container-restart-sequence-')); const role = process.argv.includes('--after') ? 'after' : 'before'; const baseline = process.argv.includes('--baseline'); const productionServer = !process.argv.includes('--synthetic-http');
const secret = 'restart-sequence-synthetic-internal-secret'; const collector = 'restart-sequence-synthetic-collector-secret'; const release = 'a'.repeat(64); const runId = randomUUID(); let key = `${role}:analytics:${runId}`;
let mf, node, nodePort, config; let bridgePort; let logs = ''; let restarts = 0; const childIds = []; const signalMetrics = []; const ingestStatuses = []; const collectorStatuses = []; let failStage = ''; let failRegistryAck = false; let holdStage = ''; let held; let activeTcpAbort;
async function stopNode() { if (node) { const child = node; node = undefined; const ended = once(child, 'exit'); child.kill(productionServer ? 'SIGKILL' : 'SIGTERM'); await ended; } }
async function startNode(value) {
  config = value;
  const listener = createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r)); const port = listener.address().port; await new Promise(r => listener.close(r));
  const child = fork(join(root, 'tests/runtime/container-restart-sequence-node.mjs'), [join(scratch, productionServer ? 'server.mjs' : 'app.mjs'), JSON.stringify({ ...config, bridgePort, key }), ...(productionServer ? ['production-server'] : [])], { cwd: root, env: { PATH: process.env.PATH, ...(productionServer ? { ...config, PORT: String(port), NODE_EXTRA_CA_CERTS: join(scratch, 'fixture-ca.crt') } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  node = child; childIds.push(child.pid); child.on('message', value => { if (value.kind === 'signal') signalMetrics.push(value); }); child.stdout.on('data', b => { logs += b; }); child.stderr.on('data', b => { logs += b; });
  const ready = await Promise.race([once(child, 'message'), new Promise((_, reject) => setTimeout(() => reject(new Error('Node fixture startup deadline')), 5000).unref())]); assert.equal(ready[0].kind, 'ready'); nodePort = ready[0].port;
  if (productionServer) { let listening = false; for (let n = 0; n < 100; n++) { try { const probe = await fetch(`http://127.0.0.1:${nodePort}/internal/checkpoint`, { headers: { authorization: `Bearer ${config.APP_INTERNAL_SECRET}` }, signal: AbortSignal.timeout(200) }); await probe.body?.cancel(); if (probe.status === 200) { listening = true; break; } } catch {} await new Promise(r => setTimeout(r, 10)); } assert.equal(listening, true, 'production server fixture must be listening before native dispatch'); }
}
const bridge = createServer(async (req, res) => {
  try {
    if (req.url !== '/egress' || req.headers['x-fixture-key'] !== key) { res.writeHead(403); res.end(); return; }
    let body = ''; for await (const part of req) body += part; const receipt = JSON.parse(body);
    if (receipt.stage === holdStage) { await new Promise(resolve => { held = { resolve, receipt, res }; }); }
    if (receipt.stage === failStage) { failStage = ''; res.writeHead(503); res.end(); return; }
    if (res.destroyed) return;
    const response = await mf.dispatchFetch(`https://fixture.test/fixture/egress?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { authorization: req.headers.authorization, 'content-type': 'application/json', 'x-origin-receipt-reservation': req.headers['x-origin-receipt-reservation'], 'x-origin-receipt-signature': req.headers['x-origin-receipt-signature'] }, body });
    ingestStatuses.push(response.status); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch { if (!res.destroyed) { res.writeHead(503); res.end('Closed fixture failure'); } }
});
await new Promise(r => bridge.listen(0, '127.0.0.1', r)); bridgePort = bridge.address().port;
const call = (path, init) => mf.dispatchFetch(`https://fixture.test${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`, init);
const identity = async () => (await call('/fixture/identity')).json();
const product = { product_id: 'launch-shirt', title: 'Synthetic launch shirt', detail_key: 'catalog/launch-shirt', image_key: 'launch-shirt', content_digest: '8dc476470118143534d7a1616815da5d0e5e1fcbf61157d81e427834491f0caf' };
const payload = (requestId = randomUUID()) => ({ runId, requestId, scenarioId: 'analytics', targetRole: role, rayId: null, operation: 'catalog', product, imageUrl: 'https://imagedelivery.net/synthetic/shirt/public', detail: 'Synthetic detail', registration: null });
const render = (p = payload(), extra = {}) => call('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(p) });
async function restart() { const old = node.pid; await stopNode(); await startNode(config); assert.notEqual(node.pid, old); restarts++; }
let checks = 0;
try {
  if (productionServer) {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=restart synthetic CA', '-keyout', join(scratch, 'fixture-ca.key'), '-out', join(scratch, 'fixture-ca.crt')], { stdio: 'ignore' });
    const mappings = [["const caPath = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';", `const caPath = ${JSON.stringify(join(scratch, 'fixture-ca.crt'))};`], ["receiptSender(required('RECEIPT_URL'), required('RECEIPT_INGEST_SECRET'))", "receiptSender(required('RECEIPT_URL'), required('RECEIPT_INGEST_SECRET'), globalThis.__restartReceiptDispatch)"], ["server.listen(port, '0.0.0.0',", "server.listen(port, '127.0.0.1',"]];
    await build({ entryPoints: [join(root, 'apps/storefront-container/src/server.ts')], outfile: join(scratch, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent', plugins: [{ name: 'closed-server-fixture-boundaries-only', setup(b) { b.onLoad({ filter: /storefront-container\/src\/server\.ts$/ }, async args => { let source = await readFile(args.path, 'utf8'); for (const [from, to] of mappings) { assert.equal(source.split(from).length, 2); source = source.replace(from, to); } const observer = 'const abort = new AbortController();'; assert.equal(source.split(observer).length, 2); source = source.replace(observer, `${observer} globalThis.__restartSignalRecord?.(req, res, abort.signal);`); return { contents: source, loader: 'ts' }; }); } }] });
  }
  await build({ entryPoints: [join(root, 'apps/storefront-container/src/app.ts')], outfile: join(scratch, 'app.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
  const bundle = await build({ entryPoints: [join(root, 'tests/runtime/container-restart-sequence-worker.fixture')], loader: { '.fixture': 'js' }, write: false, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], nodePaths: [join(root, 'apps/storefront-worker/node_modules')], logLevel: 'silent' });
  mf = new Miniflare(convertV4MiniflareOptions({ rootPath: scratch, modules: true, script: bundle.outputFiles[0].text, scriptPath: join(scratch, 'worker.mjs'), name: 'restart-sequence', compatibilityDate: '2026-11-03', compatibilityFlags: [], host: '127.0.0.1', port: 0, cf: false, unsafeRegisterWorker: false, unsafeInspectorProxy: false, unsafeLocalExplorer: false, unsafeObservability: false, telemetry: { enabled: false }, resourceTmpPath: join(scratch, 'runtime'), log: new Log(LogLevel.NONE), logRequests: false,
    durableObjects: { ORIGINS: { className: 'RestartHarness', useSQLite: true } }, d1Databases: { DB: 'synthetic-receipts' },
    bindings: { ROLE: role, RUN_ID: runId, RELEASE_DIGEST: release, TELEMETRY_ORIGIN: 'https://telemetry.example.test', INTERNAL_SECRET: secret, INGEST_ROOT_SECRET: secret, REGISTRY_SECRET: secret, COLLECTOR_SECRET: collector },
    outboundService: async request => {
      const u = new URL(request.url); const body = request.method === 'POST' ? await request.text() : undefined;
      if (u.origin === 'https://telemetry.example.test') { const response = await mf.dispatchFetch(request.url, { method: request.method, headers: request.headers, ...(body ? { body } : {}) }); if (u.pathname === '/ingest') collectorStatuses.push(response.status); if (u.pathname === '/registry' && failRegistryAck) { failRegistryAck = false; await response.body?.cancel(); return new Response(null, { status: 503 }); } return response; }
      assert.equal(u.origin, 'https://node-fixture.example.test', 'no outbound fallback'); assert.ok(['/internal/render', '/internal/checkpoint'].includes(u.pathname));
      const requestedConfig = JSON.parse(request.headers.get('x-fixture-config'));
      if (node && config.APP_PRODUCER !== requestedConfig.APP_PRODUCER) await stopNode();
      if (!node) await startNode(requestedConfig);
      const headers = new Headers(request.headers); headers.delete('x-fixture-config'); const abort = new AbortController(); activeTcpAbort = abort;
      return fetch(`http://127.0.0.1:${nodePort}${u.pathname}`, { method: request.method, headers, ...(body ? { body } : {}), signal: abort.signal, redirect: 'error' });
    } }));
  const db = await mf.getD1Database('DB');
  for (const migration of ['0001_storefront.sql', '0002_receipts.sql', '0003_producer_registry.sql', '0006_receipt_stage_acceptance.sql']) await db.exec((await readFile(join(root, 'apps/storefront-worker/migrations', migration), 'utf8')).replace(/\n/g, ' '));
  const rows = async () => (await db.prepare('SELECT receipt_id,producer_id,sequence,request_id,stage FROM origin_receipts ORDER BY sequence').all()).results;
  if (!baseline) { failRegistryAck = true; assert.equal((await render()).status, 503); const pendingOwner = await identity(); assert.ok(pendingOwner.identity?.producerId, 'producer identity must survive a lost registry acknowledgment'); assert.equal((await render()).status, 200); assert.equal((await identity()).identity.producerId, pendingOwner.identity.producerId); assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM producer_registry').first()).count, 1); checks++; }
  if (baseline) assert.equal((await render()).status, 200); const first = await identity(); assert.deepEqual((await rows()).map(v => v.sequence), [1, 2]); checks++;
  await restart(); const second = await render(); const same = await identity(); assert.equal(same.identity.producerId, first.identity.producerId);
  if (baseline) {
    assert.equal(second.status, 503); assert.ok(collectorStatuses.includes(409)); assert.deepEqual((await rows()).map(v => v.sequence), [1, 2]);
    console.log(JSON.stringify({ kind: 'restart-sequence-baseline', role, result: 'RED-reproduced', restartedNode: true, sameProducer: true, secondStatus: second.status, sqlConflict: true, sequences: [1, 2], cloudRequests: 0, version, binarySha256 }));
  } else {
    assert.equal(second.status, 200, 'same producer must render after actual Node process restart'); assert.deepEqual((await rows()).map(v => v.sequence), [1, 2, 3, 4]); checks++;
    try { await call('/fixture/evict'); } catch { /* Actual native DO eviction rejects the invoking fixture request. */ }
    assert.equal((await render()).status, 200); assert.equal((await identity()).identity.producerId, first.identity.producerId); assert.deepEqual((await rows()).map(v => v.sequence), [1, 2, 3, 4, 5, 6]); checks++;
    // Adopt only a fully verified legacy two-stage request budget.
    await db.prepare('INSERT INTO producer_checkpoints(producer_id,environment,scenario_id,run_id,last_attempted_sequence,healthy,watermark) VALUES(?,?,?,?,?,?,?)').bind(first.identity.producerId, role, 'analytics', runId, 6, 0, new Date().toISOString()).run();
    await call('/fixture/forget-allocator'); assert.equal((await render()).status, 200); assert.deepEqual((await rows()).filter(v => v.sequence > 6).map(v => v.sequence), [7, 8]); assert.equal((await identity()).allocator.highWater, 8); checks++;
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => render())); assert.ok(concurrent.every(v => v.status === 200)); const all = await rows(); assert.equal(new Set(all.map(v => `${v.producer_id}:${v.sequence}`)).size, all.length); checks++;
    const retry = payload(); assert.equal((await render(retry)).status, 200); const count = (await rows()).length; assert.equal((await render(retry)).status, 200); assert.equal((await rows()).length, count); const retryHigh = (await identity()).allocator.highWater; assert.notEqual((await render({ ...retry, detail: 'changed same request' })).status, 200); assert.equal((await identity()).allocator.highWater, retryHigh); assert.equal((await rows()).length, count); checks++;
    for (const stage of ['entry', 'completion']) {
      failStage = stage; const p = payload(); assert.equal((await render(p)).status, 503); const original = (await rows()).filter(v => v.request_id === p.requestId); const retryHigh = (await identity()).allocator.highWater;
      assert.equal((await render(p)).status, 200); assert.equal((await identity()).allocator.highWater, retryHigh); const retried = (await rows()).filter(v => v.request_id === p.requestId); assert.equal(retried.length, 2); if (original.length) assert.deepEqual(retried[0], original[0]); checks++;
      failStage = stage; const abandoned = payload(); assert.equal((await render(abandoned)).status, 503); const before = (await identity()).allocator.highWater; assert.equal((await render()).status, 200); const latest = (await rows()).filter(v => v.sequence > before); assert.deepEqual(latest.map(v => v.sequence), [before + 1, before + 2]); checks++;
    }
    // Real Node crash after entry SQL commit, while completion is held.
    holdStage = 'completion'; const crashed = payload(); const pending = render(crashed);
    for (let n = 0; n < 100 && !held; n++) await new Promise(r => setTimeout(r, 10)); assert.ok(held);
    const beforeCrash = (await identity()).allocator.highWater; await stopNode(); holdStage = ''; held.resolve(); held = undefined; await pending;
    await startNode(config); restarts++; const crashEntry = (await rows()).find(v => v.request_id === crashed.requestId && v.stage === 'entry'); assert.ok(crashEntry); assert.equal((await render(crashed)).status, 200); assert.equal((await identity()).allocator.highWater, beforeCrash); assert.deepEqual((await rows()).find(v => v.request_id === crashed.requestId && v.stage === 'entry'), crashEntry); checks++;
    assert.equal((await render()).status, 200); assert.deepEqual((await rows()).filter(v => v.sequence > beforeCrash).map(v => v.sequence), [beforeCrash + 1, beforeCrash + 2]); checks++;
    // Cancel real TCP during each receipt phase; never deliver an aborted stage.
    for (const stage of ['entry', 'completion']) {
      holdStage = stage; const cancelled = payload(); const cancelPending = render(cancelled);
      for (let n = 0; n < 100 && !held; n++) await new Promise(r => setTimeout(r, 10)); assert.ok(held); activeTcpAbort.abort(); await cancelPending;
      if (productionServer) { for (let n = 0; n < 100 && !held.res.destroyed; n++) await new Promise(r => setTimeout(r, 10)); assert.equal(held.res.destroyed, true, 'actual handler signal must cancel the pending receipt transport'); }
      holdStage = ''; held.resolve(); held = undefined;
      await new Promise(r => setTimeout(r, 30)); assert.equal((await render()).status, 200); assert.equal((await rows()).filter(v => v.request_id === cancelled.requestId && v.stage === 'completion').length, 0); checks++;
    }
    if (productionServer) {
      const count = (await rows()).length; const before = signalMetrics.filter(v => v.reason === 'request-aborted').length;
      const upload = httpRequest({ hostname: '127.0.0.1', port: nodePort, path: '/internal/render', method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'content-length': '999' } }); upload.on('error', () => {}); upload.write('{"runId":'); await new Promise(r => setTimeout(r, 20)); upload.destroy();
      for (let n = 0; n < 100 && signalMetrics.filter(v => v.reason === 'request-aborted').length === before; n++) await new Promise(r => setTimeout(r, 10));
      assert.ok(signalMetrics.filter(v => v.reason === 'request-aborted').length > before); assert.equal((await rows()).length, count); checks++;
      assert.ok(signalMetrics.some(v => v.reason === 'response-finish' && v.ended && !v.aborted)); assert.ok(signalMetrics.some(v => v.reason === 'response-close' && !v.ended && v.aborted)); assert.ok(signalMetrics.every(v => !v.listenerLeaks)); checks++;
    }
    assert.equal((await identity()).allocator.healthy, false, 'failure history must not be relabeled healthy');
    const query = new URLSearchParams({ role, runId, scenarioId: 'analytics', start: new Date(Date.now() - 60000).toISOString(), end: new Date().toISOString() });
    const coverage = await (await mf.dispatchFetch(`https://telemetry.example.test/receipts?${query}`, { headers: { authorization: `Bearer ${collector}` } })).json(); assert.equal(coverage.originCount, null); assert.equal(coverage.coverage.complete, false); checks++;
    const scoped = payload(); assert.equal((await render(scoped, { 'x-origin-receipt-reservation': 'caller-chosen', 'x-origin-receipt-signature': '0'.repeat(64) })).status, 200); checks++;
    const cp = await call(`/internal/checkpoint?scenarioId=analytics&runId=${runId}`, { headers: { authorization: `Bearer ${secret}` } }); assert.equal(cp.status, 200); assert.equal((await cp.json()).healthy, false); const checkpointState = await db.prepare('SELECT last_attempted_sequence,healthy FROM producer_checkpoints WHERE producer_id=?').bind(first.identity.producerId).first(); assert.equal(checkpointState.healthy, 0); assert.equal(checkpointState.last_attempted_sequence, (await identity()).allocator.highWater); checks++;
    // Foreign checkpoint must fail adoption, not initialize an allocator at zero.
    await call('/fixture/forget-allocator'); await db.prepare('UPDATE producer_checkpoints SET run_id=? WHERE producer_id=?').bind(randomUUID(), first.identity.producerId).run(); const countBefore = (await rows()).length; assert.equal((await render()).status, 503); assert.equal((await rows()).length, countBefore); assert.equal((await identity()).allocator, undefined); checks++;
    const missingRun = randomUUID(); key = `${role}:analytics:${missingRun}`; failStage = 'entry'; assert.equal((await render({ ...payload(), runId: missingRun })).status, 503); await call('/fixture/forget-allocator'); const emptyHistoryRows = (await rows()).length; assert.equal((await render({ ...payload(), runId: missingRun })).status, 503); assert.equal((await identity()).allocator, undefined); assert.equal((await rows()).length, emptyHistoryRows); checks++;
    assert.ok(!collectorStatuses.includes(409), 'no repaired allocation may collide with actual SQL uniqueness'); assert.ok(!logs.includes('PRIVATE_CANARY')); checks++;
    console.log(JSON.stringify({ kind: 'restart-sequence-repaired', role, productionHandler: productionServer, signalLifecycleObserved: signalMetrics.length, checks, restarts, actualNodeProcesses: new Set(childIds).size, sqlRows: (await rows()).length, uniqueConflict: false, coverage: 'unknown after reserved gaps; no fabricated checkpoint', cloudRequests: 0, version, binarySha256, realm: 'actual Node process restart + native namespace/SDK/SQL collector; synthetic supervisor/TCP loopback bridge; no hosted TLS claim' }));
  }
} finally { if (held) held.resolve(); await stopNode(); if (mf) await mf.dispose(); bridge.closeAllConnections(); await new Promise(r => bridge.close(r)); await rm(scratch, { recursive: true, force: true }); }
