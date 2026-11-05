import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTelemetryApp, type Producer } from '../apps/storefront-worker/src/telemetry.js';
import type { Database } from '../apps/storefront-worker/src/d1.js';
import { contentDigest } from '../apps/storefront-worker/src/assets.js';
let mf: Miniflare; let db: Database; const previousTmp = process.env.TMPDIR;
const origin = 'https://receipts.example.test'; const readerSecret = 'fixture-read-only-collector-secret'; const ingestSecret = 'fixture-producer-ingestion-secret';
const start = '2026-11-04T00:00:00.000Z'; const end = '2026-11-04T00:00:05.000Z';
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required'); process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("telemetry test"); } }', host: '127.0.0.1', port: 0, d1Databases: { DB: 'receipts' }, d1Persist: false });
  const local = await mf.getD1Database('DB'); for (const file of ['0002_receipts.sql', '0006_receipt_stage_acceptance.sql']) await local.exec(readFileSync(`apps/storefront-worker/migrations/${file}`, 'utf8').replace(/\n/g, ' ')); db = local as unknown as Database;
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
function fixture() {
  const producer: Producer = { producerId: `p-${randomUUID()}`, role: 'before', scenarioId: 'waf-custom', runId: randomUUID(), releaseDigest: 'a'.repeat(64), ingestSecret };
  const app = createTelemetryApp({ db, role: 'before', origin, readerSecret, producers: [producer], now: () => Date.parse(end) + 1000 });
  const receipt = (sequence: number, patch = {}) => ({ schemaVersion: 1, id: randomUUID(), runId: producer.runId, requestId: randomUUID(), scenarioId: 'waf-custom', targetRole: 'before', producerId: producer.producerId, sequence, observedAt: start, rayId: null, releaseDigest: producer.releaseDigest, stage: 'entry', ...patch });
  const send = async (path: string, data: any, key = ingestSecret) => {
    // Trusted stage acceptance is injected per receipt, as the Worker does after verifying signed headers.
    const acceptance = path === '/ingest' ? { schemaVersion: 1 as const, receiptId: data.id, acceptedAt: start, receiptDigest: await contentDigest(JSON.stringify(data)) } : undefined;
    const target = acceptance ? createTelemetryApp({ db, role: 'before', origin, readerSecret, producers: [producer], now: () => Date.parse(end) + 1000, acceptance }) : app;
    return target.request(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  };
  const status = (n: number, healthy = true, watermark = end) => send('/producer-status', { producerId: producer.producerId, targetRole: 'before', scenarioId: 'waf-custom', runId: producer.runId, lastAttemptedSequence: n, healthy, watermark });
  const read = (key = readerSecret, runId = producer.runId) => app.request(`${origin}/receipts?${new URLSearchParams({ runId, scenarioId: 'waf-custom', start, end })}`, { headers: { authorization: `Bearer ${key}` } });
  const pair = async (sequence: number) => { const entry = receipt(sequence); await send('/ingest', entry); await send('/ingest', { ...entry, id: randomUUID(), sequence: sequence + 1, stage: 'completion' }); };
  return { producer, app, receipt, send, status, read, pair };
}
describe('receipt-channel', () => {
  it('authenticates receipt ownership and acknowledges exact idempotent writes only', async () => {
    const f = fixture(); const r = f.receipt(1);
    const response = await f.send('/ingest', r); expect(response.status).toBe(204); expect(response.headers.get('x-receipt-id')).toBe(r.id);
    expect((await f.send('/ingest', r)).status).toBe(204);
    expect((await f.send('/ingest', { ...r, requestId: randomUUID() })).status).toBe(409);
    expect((await f.send('/ingest', f.receipt(1))).status).toBe(409);
    expect((await f.send('/ingest', f.receipt(2, { targetRole: 'after' }))).status).toBe(403);
    expect((await f.send('/ingest', f.receipt(2, { runId: randomUUID() }))).status).toBe(403);
    expect((await f.send('/ingest', f.receipt(2), readerSecret)).status).toBe(401);
    expect((await f.read(ingestSecret)).status).toBe(401);
    expect((await f.send('/catalog', {})).status).toBe(404);
  });
  it('requires complete healthy producer checkpoints before zero means absence', async () => {
    const f = fixture();
    expect((await (await f.read()).json() as any).originCount).toBeNull();
    await f.status(0);
    const zero = await (await f.read()).json() as any;
    expect(zero.originCount).toBe(0); expect(zero.coverage).toMatchObject({ healthy: true, complete: true, watermark: end });
    await f.status(1, false);
    const unknown = await (await f.read()).json() as any;
    expect(unknown.originCount).toBeNull(); expect(unknown.coverage.complete).toBe(false);
  });
  it('deduplicates origin receipts, preserves scope and discloses missing sequences', async () => {
    const f = fixture(); await f.pair(1); await f.status(2);
    const good = await (await f.read()).json() as any; expect(good.originCount).toBe(1);
    const foreign = await (await f.read(readerSecret, randomUUID())).json() as any; expect(foreign.receipts).toHaveLength(0); expect(foreign.originCount).toBeNull();
    await f.pair(4); await f.status(5);
    const gap = await (await f.read()).json() as any; expect(gap.originCount).toBeNull(); expect(gap.coverage.gaps.length).toBeGreaterThan(0);
    expect(JSON.stringify(gap)).not.toContain(ingestSecret);
  });
  it('rejects future, stale and foreign checkpoints and does not infer coverage from old watermarks', async () => {
    const f = fixture(); await f.status(0, true, start);
    expect((await (await f.read()).json() as any).coverage.complete).toBe(false);
    await f.status(1);
    expect((await f.status(0)).status).toBe(409);
    expect((await f.status(2, true, '2026-11-04T01:00:00.000Z')).status).toBe(403);
    expect((await f.app.request('https://wrong.example.test/receipts')).status).toBe(421);
    expect((await f.read('wrong')).status).toBe(401);
  });
});
