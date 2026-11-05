import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath, mkdtemp, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(await realpath(join(root, 'node_modules/wrangler/package.json')));
const { build } = require('esbuild'); const mfPath = require.resolve('miniflare');
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = await import(mfPath);
const runtime = createRequire(mfPath)('workerd'); process.env.MINIFLARE_WORKERD_PATH = runtime.default;
const executable = await realpath(runtime.default); const binarySha256 = createHash('sha256').update(await readFile(executable)).digest('hex');
const observedVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
const scratch = await mkdtemp(join(tmpdir(), 'a511-lifecycle-author-')); const baseline = process.argv.includes('--expect-red');
const bundle = await build({ entryPoints: [join(root, 'tests/runtime/a511-lifecycle-worker.fixture')], loader: { '.fixture': 'js' }, write: false, bundle: true, platform: 'browser', format: 'esm', external: ['cloudflare:workers'], nodePaths: [join(root, 'apps/storefront-worker/node_modules')], logLevel: 'silent' });
const secret = 'a511-lifecycle-synthetic-only-secret'; const runId = randomUUID(); const key = randomUUID();
// Capture runtime output, not merely hide it: any provider canary fails privacy checks.
const logs = []; class CapturedLog extends Log { constructor() { super(LogLevel.DEBUG); } log(message) { logs.push(String(message)); } warn(message) { logs.push(String(message)); } error(message) { logs.push(String(message)); } debug(message) { logs.push(String(message)); } info(message) { logs.push(String(message)); } }
const mf = new Miniflare(convertV4MiniflareOptions({ rootPath: scratch, modules: true, script: bundle.outputFiles[0].text, scriptPath: join(scratch, 'bundle.mjs'), name: 'lifecycle', compatibilityDate: '2026-11-03', compatibilityFlags: [], host: '127.0.0.1', port: 0, cf: false, unsafeRegisterWorker: false, unsafeInspectorProxy: false, unsafeLocalExplorer: false, unsafeObservability: false, telemetry: { enabled: false }, resourceTmpPath: join(scratch, 'runtime'), log: new CapturedLog(), logRequests: false,
 durableObjects: { ORIGINS: { className: 'LifecycleHarness', useSQLite: true } },
 bindings: { ROLE: 'before', RUN_ID: runId, RELEASE_DIGEST: 'a'.repeat(64), TELEMETRY_ORIGIN: 'https://telemetry.example.test', INTERNAL_SECRET: secret, INGEST_ROOT_SECRET: secret, REGISTRY_SECRET: secret },
 outboundService: async request => { assert.equal(request.url, 'https://telemetry.example.test/registry'); return new Response(null, { status: 204 }); }
}));
const call = (path, id, body) => mf.dispatchFetch(`https://fixture.test${path}?key=${key}&id=${id}`, body === undefined ? undefined : { method: 'POST', body: JSON.stringify(body) });
const facts = async id => (await call('/facts', id)).json();
async function until(id, predicate) { let value; for (let n = 0; n < 100; n++) { value = await facts(id); if (predicate(value)) return value; await new Promise(r => setTimeout(r, 10)); } throw new Error('Lifecycle fixture phase deadline'); }
async function begin(mode) { const id = randomUUID(); assert.equal((await call('/begin', id, { mode })).status, 202); await until(id, v => v.started); return id; }
async function alarm(id) { return (await call('/alarm', id)).json(); }
let checks = 0;
try {
  const held = await begin('headers'); const before = await facts(held);
  assert.equal(before.sdkInflight, 0); // Preserve the original private-accounting fact.
  const activeAlarm = await alarm(held);
  if (baseline) {
    assert.equal(activeAlarm.running, false); assert.ok(activeAlarm.stops > 0);
    console.log(JSON.stringify({ kind: 'lifecycle-baseline', result: 'RED-reproduced', pendingHeaders: true, sdkInflight: before.sdkInflight, alarmStoppedActive: true, cloudRequests: 0, observedVersion, executable, binarySha256 }));
  } else {
    assert.equal(activeAlarm.running, true, 'actual SDK alarm must defer shutdown during pending native headers'); assert.equal(activeAlarm.stops, 0); checks++;
  }
  await call('/release', held); await until(held, v => v.settled);
  await call('/cancel', held);
  if (!baseline) {
    assert.equal((await alarm(held)).running, false, 'idle shutdown resumes after last body cancellation'); checks++;
    // New operation per path; each runner owns fresh runtime/temp/ports.
    for (const ending of ['close', 'cancel', 'abort', 'body-error']) {
      const id = await begin('body'); await until(id, v => v.settled);
      assert.equal((await alarm(id)).running, true, `held unread body must protect alarm: ${ending}`); checks++;
      if (ending !== 'cancel') { await call('/consume', id); await call('/chunk', id); assert.equal((await alarm(id)).running, true, 'active response consumption protects alarm'); checks++; }
      await call(`/${ending}`, id);
      await until(id, v => v.finished);
      if (ending !== 'cancel') {
        let result; for (let n = 0; n < 100; n++) { result = await (await call('/result', id)).json(); if (result.readDone) break; await new Promise(r => setTimeout(r, 10)); }
        assert.equal(result.readDone, true); assert.equal(result.leaked, false); checks++;
      }
      assert.equal((await alarm(id)).running, false, `idle shutdown must resume: ${ending}`); checks++;
    }
    const unread = await begin('body'); await until(unread, v => v.settled); await call('/body-error', unread); await new Promise(r => setTimeout(r, 10)); assert.equal((await alarm(unread)).running, false, 'unread source error releases activity'); assert.equal((await (await call('/result', unread)).json()).leaked, false); checks++;
    const cancelError = await begin('cancel-error'); await until(cancelError, v => v.settled); await call('/cancel', cancelError); assert.equal((await alarm(cancelError)).running, false); assert.equal((await facts(cancelError)).cancelled, 1); checks++;
    assert.equal((await (await call('/on-error', cancelError)).json()).safe, true); checks++;
    const aborted = await begin('headers'); assert.equal((await alarm(aborted)).running, true); await call('/abort', aborted); await until(aborted, v => v.settled); assert.equal((await alarm(aborted)).running, false); assert.equal((await (await call('/result', aborted)).json()).leaked, false); checks++;
    const failed = await begin('forward-error'); await until(failed, v => v.settled); assert.equal((await alarm(failed)).running, false); const failure = await (await call('/result', failed)).json(); assert.equal(failure.status, 503); assert.equal(failure.leaked, false); checks++;
    const empty = await begin('empty'); await until(empty, v => v.settled); assert.equal((await alarm(empty)).running, false); checks++;
    // Concurrent leases: completion of one request never releases the other.
    const a = await begin('body'); const b = await begin('body'); await until(a, v => v.settled); await until(b, v => v.settled);
    await call('/cancel', a); assert.equal((await alarm(b)).running, true); checks++;
    await call('/cancel', b); assert.equal((await alarm(b)).running, false); checks++;
    assert.ok(!JSON.stringify(logs).includes('LIFECYCLE_PROVIDER_CANARY_PRIVATE')); checks++;
    console.log(JSON.stringify({ kind: 'lifecycle-repaired', checks, cloudRequests: 0, observedVersion, executable, binarySha256, logCanaryAbsent: true, realm: 'native actual SDK alarm/storage/request/streams; synthetic supervisor/TCP; forced idle deadline only in test' }));
  }
} finally { await mf.dispose(); await rm(scratch, { recursive: true, force: true }); }
