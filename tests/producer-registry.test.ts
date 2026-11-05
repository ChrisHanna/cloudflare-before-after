import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import telemetry from '../apps/storefront-worker/src/telemetry-deployed.js';
import { deriveIngestSecret, type ProducerIdentity } from '../apps/storefront-worker/src/registry.js';
import type { Database } from '../apps/storefront-worker/src/d1.js';
import { contentDigest } from '../apps/storefront-worker/src/assets.js';
let mf: Miniflare; let before: Database; let after: Database; const previousTmp = process.env.TMPDIR;
const origin = 'https://receipts.example.test';
const beforeRoot = 'fixture-before-ingestion-root-secret'; const afterRoot = 'fixture-after-ingestion-root-secret';
const beforeRegistry = 'fixture-before-registry-auth-secret'; const afterRegistry = 'fixture-after-registry-auth-secret';
const collector = 'fixture-read-only-collector-secret';
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required'); process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("registry test"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, d1Persist: false });
  const a = await mf.getD1Database('BEFORE'); const b = await mf.getD1Database('AFTER');
  for (const db of [a, b]) for (const file of ['0002_receipts.sql', '0003_producer_registry.sql', '0006_receipt_stage_acceptance.sql']) await db.exec(readFileSync(`apps/storefront-worker/migrations/${file}`, 'utf8').replace(/\n/g, ' '));
  before = a as unknown as Database; after = b as unknown as Database;
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
function fixture() {
  const env = { ORIGIN: origin, RELEASE_DIGEST: 'a'.repeat(64), DB_BEFORE: before, DB_AFTER: after, COLLECTOR_SECRET: collector, REGISTRY_SECRET_BEFORE: beforeRegistry, REGISTRY_SECRET_AFTER: afterRegistry, INGEST_ROOT_SECRET_BEFORE: beforeRoot, INGEST_ROOT_SECRET_AFTER: afterRoot };
  const identity: ProducerIdentity = { producerId: `p-${randomUUID()}`, role: 'before', scenarioId: 'waf-custom', runId: randomUUID(), releaseDigest: env.RELEASE_DIGEST };
  const post = (path: string, input: unknown, key: string) => telemetry.fetch(new Request(`${origin}${path}`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(input) }), env);
  return { env, identity, post };
}
describe('producer-registry', () => {
  it('registers metadata only and authenticates dynamically scoped receipts', async () => {
    const f = fixture(); expect((await f.post('/registry', f.identity, beforeRegistry)).status).toBe(204);
    expect((await f.post('/registry', f.identity, beforeRegistry)).status).toBe(204);
    const ingest = await deriveIngestSecret(f.identity, beforeRoot);
    const receipt = { schemaVersion: 1, id: randomUUID(), runId: f.identity.runId, requestId: randomUUID(), scenarioId: f.identity.scenarioId, targetRole: 'before', producerId: f.identity.producerId, sequence: 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: f.identity.releaseDigest, stage: 'entry' };
    const completion = { ...receipt, id: randomUUID(), sequence: 2, stage: 'completion' };
    for (const r of [receipt, completion]) {
      const encoded = JSON.stringify({ schemaVersion: 1, receiptId: r.id, acceptedAt: new Date().toISOString(), receiptDigest: await contentDigest(JSON.stringify(r)) });
      const accepted = await telemetry.fetch(new Request(`${origin}/ingest`, { method: 'POST', headers: { authorization: `Bearer ${ingest}`, 'content-type': 'application/json', 'x-origin-receipt-acceptance': encoded, 'x-origin-receipt-acceptance-signature': createHmac('sha256', beforeRoot).update(`origin-stage-acceptance-v1\n${encoded}`).digest('hex') }, body: JSON.stringify(r) }), f.env);
      expect(accepted.status).toBe(204);
    }
    const now = new Date().toISOString();
    const status = { producerId: f.identity.producerId, targetRole: 'before', scenarioId: f.identity.scenarioId, runId: f.identity.runId, lastAttemptedSequence: 2, healthy: true, watermark: now };
    expect((await f.post('/producer-status', status, ingest)).status).toBe(204);
    const query = new URLSearchParams({ role: 'before', runId: f.identity.runId, scenarioId: f.identity.scenarioId, start: receipt.observedAt, end: now });
    const result = await telemetry.fetch(new Request(`${origin}/receipts?${query}`, { headers: { authorization: `Bearer ${collector}` } }), f.env);
    const body = await result.json() as any; expect(body.originCount).toBe(1); expect(body.coverage.complete).toBe(true);
    expect(JSON.stringify(body)).not.toContain(ingest);
    const stored = await before.prepare('SELECT * FROM producer_registry WHERE producer_id=?').bind(f.identity.producerId).first();
    expect(JSON.stringify(stored)).not.toContain(beforeRoot); expect(JSON.stringify(stored)).not.toContain(ingest);
  });
  it('rejects foreign registration and cannot forge the other environment credential', async () => {
    const f = fixture();
    expect((await f.post('/registry', f.identity, afterRegistry)).status).toBe(401);
    expect((await f.post('/registry', f.identity, beforeRegistry)).status).toBe(204);
    const original = await deriveIngestSecret(f.identity, beforeRoot);
    const foreign = { ...f.identity, role: 'after' as const };
    expect(await deriveIngestSecret(foreign, afterRoot)).not.toBe(original);
    const receipt = { schemaVersion: 1, id: randomUUID(), runId: foreign.runId, requestId: randomUUID(), scenarioId: foreign.scenarioId, targetRole: 'after', producerId: foreign.producerId, sequence: 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: foreign.releaseDigest, stage: 'entry' };
    expect((await f.post('/ingest', receipt, original)).status).toBe(401);
    expect(await after.prepare('SELECT * FROM origin_receipts WHERE receipt_id=?').bind(receipt.id).first()).toBeNull();
  });
});
