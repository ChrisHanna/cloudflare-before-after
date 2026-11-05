import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { readWorkerCodeMaterial, MAX_WORKER_CODE_BYTES } from '../packages/demo-core/src/worker-code.js';
import { WorkerCodeFingerprintSchema } from '../packages/contracts/src/worker-code.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import { labConfig } from './fixtures/lab.js';
import { securityEventsBody } from '../packages/demo-core/src/graphql.js';
import { collectDeploymentVerification } from '../packages/demo-core/src/deployment-verification-core.js';
import { deploymentFixture } from './workshop-core-fixtures.js';
const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.stop()); vi.restoreAllMocks(); });
const code = 'export default { fetch() { return new Response("PRIVATE_CODE_CANARY"); } }';
const signal = () => new AbortController().signal;
function multipart(order = ['main.js', 'data.txt'], main = 'main.js', changed = false) {
  const form = new FormData();
  for (const name of order) form.append(name, new Blob([name === 'main.js' ? code + (changed ? '// changed' : '') : 'PRIVATE_MODULE_CANARY'],
    { type: name === 'main.js' ? 'application/javascript+module' : 'text/plain' }), name);
  return new Response(form, { headers: { 'cf-worker-main-module-part': main } });
}
function fixture(response: () => Response | Promise<Response> = () => new Response(code, { headers: { 'content-type': 'application/javascript' } })) {
  const config = labConfig(); config.liveOptIn = true;
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const calls: { url: string; init: RequestInit }[] = [];
  const options = { config, ledger, mode: 'fixture' as const, observedOwnedResources: new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)),
    credentials: { reader: 'fixture-code-reader-credential', collector: 'fixture-code-collector-credential', runner: 'fixture-code-runner-credential' },
    dispatch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return response(); } };
  return { options, calls, collector: createTrustedCollectors(options), client: new GuardedClient(config, ledger, options) };
}
describe('independent owned Worker content fingerprints', () => {
  it('uses the pinned SDK content/v2 GET and retains no source or reflected release', async () => {
    const f = fixture(() => new Response(code, { headers: { 'content-type': 'application/javascript', 'x-lab-role': 'before', 'x-lab-release': 'e'.repeat(64) } }));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external network'));
    const result = await f.collector.workerCode('after');
    expect(result.state).toBe('observed'); expect(result.mode).toBe('fixture'); expect(result.entitlement).toBe('unknown');
    expect(result.value).toMatchObject({ targetRole: 'after', workerName: 'after-worker', format: 'javascript', moduleCount: 1, runtimeRelease: null, containerDigest: null });
    expect(result.value?.codeDigest).toMatch(/^[a-f0-9]{64}$/); expect(result.value?.contentBytes).toBe(Buffer.byteLength(code));
    expect(f.calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/content/v2`);
    expect(f.calls[0]!.init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(f.options.ledger.snapshot.requestsUsed).toBe(1); expect(f.collector.readsUsed).toBe(1);
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CODE_CANARY|export default|fixture-code-reader/); expect(fetch).not.toHaveBeenCalled();
  });
  it('changes the actual code digest when bytes change, independently of desired release', async () => {
    let body = code; const f = fixture(() => new Response(body, { headers: { 'content-type': 'text/javascript' } }));
    const before = await f.collector.workerCode('before'); body += '\n// changed'; const after = await f.collector.workerCode('after');
    expect(before.value?.codeDigest).not.toBe(after.value?.codeDigest); expect(before.value?.runtimeRelease).toBeNull();
  });
  it('normalizes multipart boundaries and ordering while covering every file', async () => {
    const a = await readWorkerCodeMaterial(multipart(), signal());
    const b = await readWorkerCodeMaterial(multipart(['data.txt', 'main.js']), signal());
    const c = await readWorkerCodeMaterial(multipart(undefined, undefined, true), signal());
    expect(a?.format).toBe('multipart'); expect(a?.moduleCount).toBe(2); expect(a?.codeDigest).toBe(b?.codeDigest); expect(a?.codeDigest).not.toBe(c?.codeDigest);
    expect(JSON.stringify(a)).not.toMatch(/PRIVATE_|main.js|data.txt/);
  });
  it.each(['missing-main', 'wrong-main', 'text-main', 'duplicate', 'traversal', 'string-part', 'too-many', 'unsupported-file'] as const)('rejects unknown multipart semantics: %s', async fault => {
    let response: Response;
    if (fault === 'missing-main') { response = multipart(); response.headers.delete('cf-worker-main-module-part'); }
    else if (fault === 'wrong-main') response = multipart(undefined, 'missing.js');
    else if (fault === 'text-main') response = multipart(undefined, 'data.txt');
    else {
      const form = new FormData(); form.append('main.js', new Blob([code], { type: 'application/javascript+module' }), 'main.js');
      if (fault === 'duplicate') form.append('main.js', new Blob([code], { type: 'application/javascript+module' }), 'main.js');
      if (fault === 'traversal') form.append('../private.js', new Blob([code], { type: 'text/plain' }), 'private.js');
      if (fault === 'string-part') form.append('metadata', 'PRIVATE_STRING_CANARY');
      if (fault === 'too-many') for (let i = 0; i < 32; i++) form.append(`extra${i}.txt`, new Blob(['x'], { type: 'text/plain' }), `extra${i}.txt`);
      if (fault === 'unsupported-file') form.append('extra.bin', new Blob(['x'], { type: 'application/x-unknown' }), 'extra.bin');
      response = new Response(form, { headers: { 'cf-worker-main-module-part': 'main.js' } });
    }
    expect(await readWorkerCodeMaterial(response, signal())).toBeNull();
  });
  it.each([401, 403, 404, 500])('does not expose a %s response body', async status => {
    const f = fixture(() => new Response('PRIVATE_DENIAL_CANARY', { status })); const read = await f.collector.workerCode('after');
    expect(read.value).toBeNull(); expect(read.state).toBe('unknown'); expect(read.permission).toBe([401, 403].includes(status) ? 'denied' : 'unknown');
    expect(JSON.stringify(read)).not.toContain('PRIVATE_DENIAL_CANARY');
  });
  it.each(['application/json', 'text/html', 'application/octet-stream', ''])('does not guess JavaScript from MIME %s', async type => {
    const f = fixture(() => new Response(code, { headers: { 'content-type': type } }));
    const read = await f.collector.workerCode('after'); expect(read.state).toBe('unsupported'); expect(read.value).toBeNull();
  });
  it('cancels oversized streams instead of retaining a prefix or accepting a declared length', async () => {
    const cancel = vi.fn(); let sent = false;
    const f = fixture(() => new Response(new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(new Uint8Array(MAX_WORKER_CODE_BYTES + 1)); } }, cancel }),
      { headers: { 'content-type': 'application/javascript', 'content-length': '1' } }));
    expect((await f.collector.workerCode('after')).value).toBeNull(); expect(cancel).toHaveBeenCalled(); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it('cancels a stalled source read on caller abort without retaining the prefix', async () => {
    let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); const cancel = vi.fn();
    const f = fixture(() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new TextEncoder().encode('PRIVATE_PREFIX')); started(); }, cancel }),
      { headers: { 'content-type': 'application/javascript' } }));
    const controller = new AbortController(); const pending = f.collector.workerCode('after', controller.signal);
    await ready; controller.abort(); const result = await pending;
    expect(result.value).toBeNull(); expect(cancel).toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('PRIVATE_PREFIX');
  });
  it('rejects the old deployment allowance before any provider or service dispatch', async () => {
    const f = fixture();
    await expect(collectDeploymentVerification({ projectRoot: process.cwd(), config: f.options.config, observedOwnedResources: f.options.observedOwnedResources,
      expected: deploymentFixture().state, mode: 'fixture', credentials: f.options.credentials, plannedRequests: 18, dispatch: f.options.dispatch })).rejects.toThrow('plan omits');
    expect(f.calls).toHaveLength(0);
  });
  it('keeps transport excerpts empty and sanitizes stream failures', async () => {
    const f = fixture(); const response = await f.client.requestWorkerCode('after', f.options.credentials.reader);
    expect(response.excerpt).toBe(''); expect(JSON.stringify(response)).not.toContain('PRIVATE_CODE_CANARY');
    await expect(readWorkerCodeMaterial(new Response(new ReadableStream({ start(controller) { controller.error(new Error('PRIVATE_STREAM_CANARY')); } }),
      { headers: { 'content-type': 'application/javascript' } }), signal())).rejects.toThrow('Worker code read unavailable');
  });
  it('refuses redirects, pre-aborted reads and raw content access', async () => {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: 'https://foreign.example/code' } }));
    expect((await f.collector.workerCode('after')).value).toBeNull(); expect(f.calls).toHaveLength(1);
    const stopped = new AbortController(); stopped.abort(); expect((await f.collector.workerCode('after', stopped.signal)).value).toBeNull(); expect(f.calls).toHaveLength(1);
    await expect(f.client.request({ kind: 'cloudflare', url: f.calls[0]!.url })).rejects.toThrow('hash-only'); expect(f.calls).toHaveLength(1);
  });
  it.each(['runtime', 'discovery'] as const)('rechecks the hash-only gate before redirected %s dispatch', async purpose => {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: `/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/content/v2` } }));
    const client = purpose === 'runtime' ? f.client : new GuardedClient(f.options.config, f.options.ledger, { ...f.options, purpose });
    await expect(client.request({ kind: 'cloudflare', url: `${f.options.config.apiOrigin}/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/settings`,
      followRedirects: true, headers: { authorization: `Bearer ${f.options.credentials.reader}` } })).rejects.toThrow();
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url).toContain('/settings'); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it.each(['%63ontent/v2', 'c%6fntent/v2', 'content%2Fv2', '%2563ontent/v2', 'content/v%32', 'content/v2/', 'CONTENT/V2', '/content/v2'])('rejects ambiguous or alternate raw content spelling %s before I/O', async path => {
    const f = fixture();
    await expect(f.client.request({ kind: 'cloudflare', url: `${f.options.config.apiOrigin}/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/${path}` })).rejects.toThrow();
    expect(f.calls).toHaveLength(0); expect(f.options.ledger.snapshot.requestsUsed).toBe(0);
  });
  it('cannot redirect an approved GraphQL read into a control-plane POST', async () => {
    const f = fixture(() => new Response(null, { status: 307, headers: { location: `/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/settings` } }));
    const end = new Date().toISOString(); const start = new Date(Date.now() - 1000).toISOString();
    await expect(f.client.request({ kind: 'cloudflare', url: `${f.options.config.apiOrigin}/client/v4/graphql`, method: 'POST', followRedirects: true,
      body: securityEventsBody({ zoneId: f.options.config.zoneId, hostname: 'after.example.test', rayId: 'a'.repeat(16), start, end, limit: 10 }) })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it('rechecks discovery account ownership on every redirect', async () => {
    const f = fixture(() => new Response(null, { status: 302, headers: { location: `/client/v4/accounts/${'b'.repeat(32)}/workers/scripts/other/settings` } }));
    const client = new GuardedClient(f.options.config, f.options.ledger, { ...f.options, purpose: 'discovery' });
    await expect(client.request({ kind: 'cloudflare', url: `${f.options.config.apiOrigin}/client/v4/accounts/${f.options.config.accountId}/workers/scripts/after-worker/settings`, followRedirects: true })).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  it('denies discovery-mode code reads and never accepts a foreign role', async () => {
    const f = fixture(); const client = new GuardedClient(f.options.config, f.options.ledger, { ...f.options, purpose: 'discovery' });
    await expect(client.requestWorkerCode('after', f.options.credentials.reader)).rejects.toThrow('owned runtime inventory');
    await expect(f.client.requestWorkerCode('foreign' as 'after', f.options.credentials.reader)).rejects.toThrow(); expect(f.calls).toHaveLength(0);
  });
  it('allows only scoped hash artifacts, not expected releases or source text', async () => {
    const f = fixture(); const read = await f.collector.workerCode('after'); const value = WorkerCodeFingerprintSchema.parse(read.value);
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: randomUUID(), scenarioId: 'waf-custom' as const, targetRole: 'after' as const,
      requestId: null, observedAt: value.observedAt, source: 'cloudflare' as const, payload: value };
    expect(makeArtifact(artifact).artifact.payload).toEqual(value);
    expect(() => makeArtifact({ ...artifact, targetRole: 'before' })).toThrow();
    expect(() => makeArtifact({ ...artifact, requestId: randomUUID() })).toThrow();
    expect(WorkerCodeFingerprintSchema.safeParse({ ...value, runtimeRelease: 'a'.repeat(64) }).success).toBe(false);
    expect(WorkerCodeFingerprintSchema.safeParse({ ...value, sourceText: code }).success).toBe(false);
  });
});
