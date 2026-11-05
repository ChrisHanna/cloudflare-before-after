import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runTurnstile, type TurnstileOptions } from '../packages/demo-core/src/turnstile.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { labConfig } from './fixtures/lab.js';
import { StorefrontData, type Database } from '../apps/storefront-worker/src/d1.js';
import { OwnedAssets, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { RegistrationVerifier, TEST_SECRET, TEST_SITEKEY, TEST_TOKEN } from '../apps/storefront-worker/src/turnstile.js';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
let mf: Miniflare; const previousTmp = process.env.TMPDIR; const dbs = new Map<string, Database>(); const buckets = new Map<string, ObjectBucket>();
const runSecret = 'fixture-run-key-turnstile-at-least-24'; const internalSecret = 'fixture-internal-turnstile-at-least-24'; const liveSecret = 'fixture-live-verifier-secret-at-least-24';
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required'); process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local only"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'ts-before', AFTER: 'ts-after' }, r2Buckets: { BEFORE: 'ts-before', AFTER: 'ts-after' }, d1Persist: false, r2Persist: false });
  for (const role of ['before', 'after'] as const) {
    const db = await mf.getD1Database(role.toUpperCase()) as unknown as Database; dbs.set(role, db);
    for (const migration of ['0001_storefront.sql', '0004_turnstile.sql']) await (db as any).exec(readFileSync(`apps/storefront-worker/migrations/${migration}`, 'utf8').replace(/\n/g, ' '));
    const bucket = await mf.getR2Bucket(role.toUpperCase()) as unknown as ObjectBucket; buckets.set(role, bucket);
    await new StorefrontData(db, role).seed(); await new OwnedAssets(bucket, role).seedDetail('launch-shirt', 'Synthetic detail');
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
function fixture(role: 'before' | 'after' = 'after', mode: 'test' | 'live' = 'test', result?: Record<string, unknown> | Error) {
  const runId = randomUUID(); const receipts: any[] = []; let calls = 0;
  const config = { mode: role === 'before' ? 'disabled' as const : mode, sitekey: role === 'before' ? null : mode === 'test' ? TEST_SITEKEY : '0xAAAAAAAAAAAAAAAAAAAAAAA', hostname: `${role}.example.test`, action: 'register' as const };
  const dispatch: typeof fetch = async (url, init) => { calls++; expect(String(url)).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify'); expect(init?.redirect).toBe('manual'); if (result instanceof Error) throw result; return Response.json(result ?? (new URLSearchParams(init?.body as string).get('response')?.startsWith('invalid-synthetic-') ? { success: false } : { success: true, hostname: mode === 'test' ? 'example.com' : config.hostname, action: 'register', challenge_ts: new Date().toISOString(), ...(mode === 'test' ? { metadata: { result_with_testing_key: true } } : {}) })); };
  const cache = new Map<string, ReturnType<typeof createContainerApp>>();
  const env: StorefrontBindings = { role, origin: `https://${role}.example.test`, releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret, internalSecret, labId: 'owned-lab', db: dbs.get(role)!, bucket: buckets.get(role)!, image: { id: 'launch-shirt', role, labId: 'owned-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'owned', variant: 'public', expectedDigest: 'b'.repeat(64) }, turnstile: { config, ...(role === 'after' ? { secret: mode === 'test' ? TEST_SECRET : liveSecret } : {}), dispatch }, containers: { getByName(key) { let container = cache.get(key); if (!container) { const [, scenarioId, run] = key.split(':'); container = createContainerApp({ role, scenarioId: scenarioId as any, runId: run!, producerId: `${role}-fixture`, releaseDigest: 'a'.repeat(64), internalSecret, sendReceipt: async receipt => { receipts.push(receipt); } }); cache.set(key, container); } return { fetch: async request => container!.request(await fixtureReservedRequest(request, { producerId: `${role}-fixture`, releaseDigest: 'a'.repeat(64), internalSecret })) }; } } };
  const app = createStorefrontWorker(env);
  const request = (token: string | null, recordId = randomUUID(), run = runId) => app.request(`${env.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-run-id': run, 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'turnstile', 'x-demo-run-token': runSecret }, body: JSON.stringify({ record_id: recordId, display_name: 'synthetic-person', note: 'Synthetic only', turnstileToken: token }) });
  const evidence = async (run: string = runId) => (await app.request(`${env.origin}/internal/registration-evidence?runId=${run}`, { headers: { 'x-demo-run-token': runSecret } })).json() as Promise<any>;
  return { env, runId, app, request, evidence, receipts, calls: () => calls };
}
describe('turnstile', () => {
  it('keeps the bypass strictly Before-only and records real scoped D1 persistence', async () => {
    const f = fixture('before'); expect((await f.request(null)).status).toBe(201); expect(f.calls()).toBe(0); expect(f.receipts).toHaveLength(2);
    const data = await f.evidence(); expect(data.receipts[0]).toMatchObject({ verificationMode: 'disabled', reason: 'baseline-only', accepted: true, persisted: true }); expect(data.records[0].exists).toBe(true);
    expect(() => new RegistrationVerifier(f.env.db, 'after', { config: f.env.turnstile!.config })).toThrow('Before-only');
  });
  it('rejects a missing token before Siteverify, Container work or persistence', async () => {
    const f = fixture(); const id = randomUUID(); expect((await f.request(null, id)).status).toBe(403); expect(f.calls()).toBe(0); expect(f.receipts).toHaveLength(0);
    expect(await new StorefrontData(f.env.db, 'after').scope('turnstile', f.runId).get(id)).toBeNull();
    expect((await f.evidence()).receipts[0]).toMatchObject({ reason: 'missing', accepted: false, persisted: false, siteverifyCalls: 0 });
  });
  it('rejects an invalid token with a sanitized verification receipt and no write', async () => {
    const f = fixture('after', 'test', { success: false, 'error-codes': ['invalid-input-response'], raw: 'token=must-not-leak' }); expect((await f.request('invalid-synthetic-token')).status).toBe(403);
    expect(f.calls()).toBe(1); expect(f.receipts).toHaveLength(0); const evidence = await f.evidence(); expect(evidence.receipts[0]).toMatchObject({ verificationMode: 'test', reason: 'invalid', siteverifyCalls: 1 }); expect(evidence.records[0].exists).toBe(false); expect(JSON.stringify(evidence)).not.toContain('must-not-leak');
  });
  it('admits a supported test-key control but labels it test, never live', async () => {
    const f = fixture(); expect((await f.request(TEST_TOKEN)).status).toBe(201); const data = await f.evidence(); expect(data.receipts[0]).toMatchObject({ verificationMode: 'test', accepted: true, persisted: true, siteverifyCalls: 1 }); expect(data.records[0].exists).toBe(true); expect(f.receipts).toHaveLength(2);
    const text = JSON.stringify(data); for (const value of [TEST_SECRET, TEST_TOKEN, liveSecret]) expect(text).not.toContain(value); expect(text).not.toContain('token_digest');
  });
  it('rejects same-run test-token replay without a second verifier call', async () => {
    const f = fixture(); expect((await f.request(TEST_TOKEN)).status).toBe(201); expect((await f.request(TEST_TOKEN)).status).toBe(403); expect(f.calls()).toBe(1);
    const data = await f.evidence(); expect(data.receipts.some((r: any) => r.reason === 'replay')).toBe(true); expect(data.records.filter((r: any) => r.exists)).toHaveLength(1);
  });
  it('binds production verification to hostname, action and a recent challenge', async () => {
    for (const response of [{ success: true, hostname: 'other.example.test', action: 'register', challenge_ts: new Date().toISOString() }, { success: true, hostname: 'after.example.test', action: 'login', challenge_ts: new Date().toISOString() }, { success: true, hostname: 'after.example.test', action: 'register', challenge_ts: '2020-01-01T00:00:00.000Z' }]) {
      const f = fixture('after', 'live', response); expect((await f.request(`synthetic-live-${randomUUID()}`)).status).toBe(403); expect(f.receipts).toHaveLength(0);
    }
    const f = fixture('after', 'live'); expect((await f.request(`synthetic-live-${randomUUID()}`)).status).toBe(201); expect((await f.evidence()).receipts[0].verificationMode).toBe('live');
  });
  it('rejects production token replay across run IDs and cannot call test keys production', async () => {
    const f = fixture('after', 'live'); const token = `synthetic-live-${randomUUID()}`; expect((await f.request(token)).status).toBe(201); expect((await f.request(token, randomUUID(), randomUUID())).status).toBe(403); expect(f.calls()).toBe(1);
    expect(() => new RegistrationVerifier(f.env.db, 'after', { config: { ...f.env.turnstile!.config, sitekey: TEST_SITEKEY }, secret: TEST_SECRET })).toThrow('test keys');
  });
  it('fails unavailable verification closed and keeps secrets/tokens out of API evidence', async () => {
    const f = fixture('after', 'test', new Error('secret=private-network-error')); expect((await f.request('private-input-token')).status).toBe(503); expect(f.receipts).toHaveLength(0); const data = await f.evidence(); expect(data.receipts[0].reason).toBe('unavailable'); expect(JSON.stringify(data)).not.toMatch(/private-network-error|private-input-token/);
  });
  it('renders only the public widget config and preserves frame protection', async () => {
    const f = fixture(); const response = await f.app.request(`${f.env.origin}/register`); const text = await response.text(); expect(text).toContain(TEST_SITEKEY); expect(text).toContain('TEST MODE'); expect(text).not.toContain(TEST_SECRET); expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:8787');
    expect((await f.app.request(`${f.env.origin}/internal/registration-evidence?runId=${f.runId}`)).status).toBe(401);
  });
  it('scopes evidence and cleanup to the requested authorized run without removing another run', async () => {
    const f = fixture('before'); const otherRun = randomUUID(); const otherId = randomUUID(); expect((await f.request(null)).status).toBe(201); expect((await f.request(null, otherId, otherRun)).status).toBe(201);
    expect((await f.evidence(randomUUID())).receipts).toEqual([]);
    const cleaned = await f.app.request(`${f.env.origin}/internal/registrations/cleanup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-run-token': runSecret }, body: JSON.stringify({ runId: f.runId }) }); expect(cleaned.status).toBe(200);
    expect(await new StorefrontData(f.env.db, 'before').scope('turnstile', otherRun).get(otherId)).not.toBeNull(); expect((await f.evidence()).records.every((r: any) => !r.exists)).toBe(true);
  });
  it('treats omitted tokens as missing and rejects concurrent token reuse', async () => {
    const f = fixture();
    const response = await f.app.request(`${f.env.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-run-id': f.runId, 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'turnstile', 'x-demo-run-token': runSecret }, body: JSON.stringify({ record_id: randomUUID(), display_name: 'synthetic-person', note: '' }) });
    expect(response.status).toBe(403); expect((await f.evidence()).receipts[0].reason).toBe('missing');
    const statuses = await Promise.all([f.request(TEST_TOKEN), f.request(TEST_TOKEN)]).then(values => values.map(r => r.status).sort());
    expect(statuses).toEqual([201, 403]); expect(f.calls()).toBe(1);
  });
  it('reapplies the migration without losing receipts or replay claims', async () => {
    const f = fixture(); await f.request(TEST_TOKEN);
    await (f.env.db as any).exec(readFileSync('apps/storefront-worker/migrations/0004_turnstile.sql', 'utf8').replace(/\n/g, ' '));
    expect((await f.request(TEST_TOKEN)).status).toBe(403); expect((await f.evidence()).receipts).toHaveLength(2); expect(f.calls()).toBe(1);
  });
  it('rejects all documented dummy key families in live mode', () => {
    const f = fixture('after', 'live');
    for (const prefix of ['1', '2', '3']) expect(() => new RegistrationVerifier(f.env.db, 'after', { config: f.env.turnstile!.config, secret: `${prefix}x0000000000000000000000000000000AA` })).toThrow('test keys');
  });
  it('fails malformed, oversized and failed Siteverify responses closed', async () => {
    for (const response of [new Response('not json'), new Response('x'.repeat(8193)), Response.json({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } }, { status: 503 })]) {
      const verifier = new RegistrationVerifier(dbs.get('after')!, 'after', { config: fixture().env.turnstile!.config, secret: TEST_SECRET, dispatch: async () => response });
      expect(await verifier.verify({ runId: randomUUID(), requestId: randomUUID(), recordId: randomUUID() }, `private-${randomUUID()}`)).toMatchObject({ accepted: false, persisted: false, reason: 'unavailable' });
    }
  });
});

const runnerRoots: string[] = [];
afterEach(() => { for (const root of runnerRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Fault = 'none' | 'status-only' | 'foreign' | 'persistence' | 'origin-missing' | 'origin-rejected' | 'unhealthy' | 'ambiguous' | 'drift' | 'final-read' | 'cleanup';
function runnerFixture(fault: Fault = 'none', verificationMode: 'test' | 'live' = 'test', afterResult?: Record<string, unknown>) {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'turnstile-run-')); runnerRoots.push(root);
  const config = labConfig(root); config.liveOptIn = true;
  const before = fixture('before'); const after = fixture('after', verificationMode, afterResult); let calls = 0; let configurationReads = 0; let cleanupCalls = 0;
  const collector = 'fixture-turnstile-collector-at-least-24';
  const dispatch = async (url: string, init: RequestInit) => {
    calls++; const u = new URL(url);
    if (u.origin === config.telemetryOrigin) {
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${collector}`);
      const role = u.searchParams.get('role')!;
      let receipts = (role === 'before' ? before : after).receipts.filter(r => r.runId === u.searchParams.get('runId'));
      if (fault === 'origin-missing') receipts = [];
      if (fault === 'origin-rejected' && role === 'after') {
        const evidence = await after.evidence(u.searchParams.get('runId')!); const rejected = evidence.receipts.find((r: any) => r.reason === 'missing');
        receipts = [...receipts, { ...receipts[0], id: randomUUID(), requestId: rejected.requestId }];
      }
      return Response.json({ schemaVersion: 1, targetRole: role, runId: u.searchParams.get('runId'), scenarioId: 'turnstile', originCount: receipts.filter(r => r.stage === 'entry').length, receipts, coverage: { healthy: fault !== 'unhealthy', complete: true, windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: receipts.length, gaps: [] } });
    }
    const f = u.origin === before.env.origin ? before : u.origin === after.env.origin ? after : null;
    if (!f) throw new Error('Unapproved fixture request');
    if (u.pathname === '/internal/registration-config' && ++configurationReads > 2 && fault === 'final-read') return Response.json({ error: 'unavailable' }, { status: 503 });
    if (u.pathname.endsWith('/cleanup')) { cleanupCalls++; if (fault === 'cleanup') return Response.json({ error: 'unavailable' }, { status: 503 }); }
    if (u.pathname === '/register' && f === after && fault === 'status-only') return Response.json({ error: 'edge denial' }, { status: 403 });
    const response = await f.app.request(url, init);
    if (u.pathname === '/internal/registration-config' && configurationReads > 2 && fault === 'drift') {
      const body = await response.json() as any; body.config.hostname = 'wrong.example.test'; return Response.json(body);
    }
    if (u.pathname === '/internal/registration-evidence' && f === after && (fault === 'foreign' || fault === 'persistence' || fault === 'ambiguous')) {
      const body = await response.json() as any;
      if (fault === 'foreign') body.receipts[0].runId = randomUUID();
      else if (fault === 'ambiguous') body.receipts[0] = body.receipts[1];
      else body.records.find((r: any) => r.requestId === body.receipts.find((v: any) => v.reason === 'missing').requestId).exists = true;
      return Response.json(body);
    }
    return response;
  };
  const run = (extra: Partial<TurnstileOptions> = {}) => runTurnstile({ projectRoot: root, config, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), mode: 'fixture', expectedAfter: after.env.turnstile!.config, credentials: { runner: runSecret, collector }, dispatch, ...(verificationMode === 'live' ? { positiveToken: `authorized-synthetic-${randomUUID()}` } : {}), ...extra });
  return { root, config, before, after, dispatch, run, counters: () => ({ calls, configurationReads, cleanupCalls }) };
}
describe('turnstile runner with real local Worker, Container and D1 fixtures', () => {
  it('executes the real runner through CLI dispatch and saves its scoped report', async () => {
    const f = runnerFixture(); f.config.demonstrations = { turnstile: { expectedAfter: f.after.env.turnstile!.config } };
    const result = await runDemoCli(['turnstile', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config, credentials: () => ({ runner: runSecret, reader: 'fixture-turnstile-reader-at-least-24', collector: 'fixture-turnstile-collector-at-least-24' }), dispatch: f.dispatch, ownershipRequests: 0, ownership: async () => new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)) });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output); expect(data).toMatchObject({ kind: 'result', journalComplete: true, report: { result: { scenarioId: 'turnstile', outcome: 'verified', requestsUsed: 17 } } });
    expect(new ReportStore(f.root, f.config.evidenceDirectory).load(data.report.result.runId)).toEqual(data.report);
    expect(f.counters().calls).toBe(17);
  });
  it('runs paired comparisons, verifies persistence and receipts, and cleans only its run', async () => {
    const f = runnerFixture(); const otherRun = randomUUID(); const otherId = randomUUID(); await f.before.request(null, otherId, otherRun);
    const phases: string[] = []; const result = await f.run({ onPhase: phase => { phases.push(phase); } });
    expect(result.decision).toEqual({ mode: 'fixture', outcome: 'verified', missingProof: [], contradictions: [] });
    expect(result.attribution).toBe('application-side'); expect(result.verificationMode).toBe('test'); expect(result.report.notes.limitations).toContain('TEST MODE');
    expect(result.verificationReceipts).toHaveLength(7); expect(result.report.result.requestsUsed).toBe(17); expect(f.counters()).toEqual({ calls: 17, configurationReads: 4, cleanupCalls: 2 });
    expect(phases).toEqual(['preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup', 'cleanup', 'finished']);
    expect(result.report.result.cleanup).toBe('complete'); expect(result.leftovers).toEqual([]);
    for (const receipt of result.verificationReceipts) expect(await new StorefrontData(dbs.get(receipt.targetRole)!, receipt.targetRole).scope('turnstile', receipt.runId).get(receipt.recordId)).toBeNull();
    expect(await new StorefrontData(dbs.get('before')!, 'before').scope('turnstile', otherRun).get(otherId)).not.toBeNull();
    const store = new ReportStore(f.root, f.config.evidenceDirectory); store.save(result.report, result.artifacts); expect(store.load(result.report.result.runId)).toEqual(result.report);
    const serialized = JSON.stringify(result); for (const secret of [runSecret, TEST_TOKEN, TEST_SECRET, 'fixture-turnstile-collector-at-least-24']) expect(serialized).not.toContain(secret);
    expect(result.artifacts.some(a => a.source === 'cloudflare')).toBe(false);
    const snapshots = result.artifacts.flatMap(a => 'path' in a.payload && a.payload.path === '/internal/registration-evidence' ? [JSON.parse(a.payload.excerpt)] : []);
    expect(snapshots.flatMap(s => s.receipts)).toHaveLength(7);
    expect(snapshots.find(s => s.targetRole === 'before').records.every((r: any) => r.exists)).toBe(true);
    expect(result.artifacts.filter(a => 'path' in a.payload && a.payload.path === '/internal/registration-config')).toHaveLength(4);
  });
  it('rejects status-only, foreign evidence, missing origins and lost final readback', async () => {
    for (const fault of ['status-only', 'foreign', 'origin-missing', 'unhealthy', 'ambiguous', 'final-read'] as const) {
      const result = await runnerFixture(fault).run(); expect(result.decision.outcome).not.toBe('verified'); expect(result.report.result.cleanup).toBe('complete'); expect(result.report.result.requestsUsed).toBeLessThanOrEqual(17);
    }
  });
  it('fails persistence contradictions and rejected registrations reaching the Container', async () => {
    for (const fault of ['persistence', 'origin-rejected', 'drift'] as const) expect((await runnerFixture(fault).run()).decision.outcome).toBe('failed');
  });
  it('never promotes test-key execution to live enforcement', async () => {
    const result = await runnerFixture().run({ mode: 'live' }); expect(result.decision.outcome).toBe('inconclusive'); expect(result.decision.missingProof).toContain('TEST MODE cannot verify live production-mode enforcement');
    expect((await runnerFixture('none', 'live').run()).decision.outcome).toBe('verified');
  });
  it('does not fail a live test-key run when Cloudflare accepts every token', async () => {
    // Observed from the real service: the documented always-pass secret returns success for any token and flags the result as a testing-key result.
    const f = runnerFixture('none', 'test', { success: true, hostname: 'example.com', challenge_ts: new Date().toISOString(), metadata: { result_with_testing_key: true } });
    const result = await f.run({ mode: 'live' });
    expect(result.decision.outcome).toBe('inconclusive'); expect(result.decision.contradictions).toEqual([]);
    expect(result.decision.missingProof).toContain('TEST MODE cannot verify live production-mode enforcement');
    expect(result.verificationReceipts).toHaveLength(6); expect(result.report.result.requestsUsed).toBe(16);
  });
  it('rejects insufficient budgets and missing live positive controls without traffic', async () => {
    const f = runnerFixture(); await expect(f.run({ limits: { requests: 16 } })).rejects.toThrow('fit'); expect(f.counters().calls).toBe(0);
    const live = runnerFixture('none', 'live'); const result = await live.run({ positiveToken: '' }); expect(result.decision.outcome).toBe('unavailable'); expect(result.report.result.requestsUsed).toBe(2); expect(live.after.calls()).toBe(0);
  });
  it('cancels after a real write, stops further traffic and cleans the owned registration', async () => {
    const f = runnerFixture(); const controller = new AbortController();
    const result = await f.run({ signal: controller.signal, onObservation: () => controller.abort() });
    expect(result.decision.outcome).toBe('inconclusive'); expect(result.report.result.cleanup).toBe('complete');
    expect(f.counters()).toEqual({ calls: 5, configurationReads: 2, cleanupCalls: 2 });
    const evidence = await f.before.evidence(result.report.result.runId);
    expect(evidence.receipts).toHaveLength(1); expect(evidence.records[0].exists).toBe(false); expect(f.after.calls()).toBe(0);
  });
  it('stops on cancellation and keeps cleanup failures visible', async () => {
    const f = runnerFixture(); const stopped = await f.run({ onStarted: value => value.stop() }); expect(stopped.decision.outcome).toBe('inconclusive'); expect(f.counters().calls).toBe(0);
    const broken = await runnerFixture('cleanup').run(); expect(broken.decision.outcome).toBe('inconclusive'); expect(broken.report.result.cleanup).toBe('incomplete'); expect(broken.leftovers).toHaveLength(2);
  });
});
