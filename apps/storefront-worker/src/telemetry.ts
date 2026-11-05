import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Digest, Id, ReceiptSchema, Role, ScenarioId, Time } from '../../../packages/contracts/src/schemas.js';
import type { Database } from './d1.js';
import { contentDigest } from './assets.js';
export const ProducerSchema = z.strictObject({ producerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), role: Role, scenarioId: ScenarioId, runId: Id, releaseDigest: Digest, ingestSecret: z.string().min(24).max(256) });
export type Producer = z.infer<typeof ProducerSchema>;
const Checkpoint = z.strictObject({ producerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), targetRole: Role, scenarioId: ScenarioId, runId: Id, lastAttemptedSequence: z.number().int().nonnegative(), healthy: z.boolean(), watermark: Time });
const Acceptance = z.strictObject({ schemaVersion: z.literal(1), receiptId: Id, acceptedAt: Time, receiptDigest: Digest });
const Query = z.strictObject({ runId: Id, scenarioId: ScenarioId, start: Time, end: Time }).refine(v => v.start <= v.end && Date.parse(v.end) - Date.parse(v.start) <= 900000, 'Invalid observation window');
async function equalSecret(value: string, expected: string): Promise<boolean> {
  if (value.length > 300 || value.length < 1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const other = await crypto.subtle.importKey('raw', new TextEncoder().encode(value), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode('telemetry');
  return crypto.subtle.verify('HMAC', other, await crypto.subtle.sign('HMAC', key, data), data);
}
export function createTelemetryApp(env: { db: Database; role: z.infer<typeof Role>; origin: string; readerSecret: string; producers: readonly Producer[]; now?: () => number; acceptance?: z.infer<typeof Acceptance> }): Hono {
  const role = Role.parse(env.role); const producers = env.producers.map(p => ProducerSchema.parse(p));
  if (new Set(producers.map(p => p.producerId)).size !== producers.length || producers.some(p => p.role !== role || p.ingestSecret === env.readerSecret) || env.readerSecret.length < 24) throw new Error('Invalid scoped telemetry credentials');
  const origin = new URL(env.origin);
  if (origin.protocol !== 'https:' || origin.origin !== env.origin || origin.username || origin.password || origin.port) throw new Error('Invalid telemetry origin');
  const now = env.now ?? Date.now;
  const app = new Hono();
  app.use('*', bodyLimit({ maxSize: 4096, onError: c => c.json({ error: 'Receipt exceeds cap' }, 413) }));
  app.use('*', async (c, next) => {
    if (new URL(c.req.url).origin !== env.origin) return c.json({ error: 'Wrong telemetry origin' }, 421);
    c.header('cache-control', 'no-store'); await next();
  });
  const allowedProducer = async (id: string, authorization: string) => {
    const producer = producers.find(p => p.producerId === id);
    return producer && await equalSecret(authorization, `Bearer ${producer.ingestSecret}`) ? producer : null;
  };
  app.post('/ingest', async c => {
    const parsed = ReceiptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid receipt' }, 400);
    const receipt = parsed.data;
    const producer = await allowedProducer(receipt.producerId, c.req.header('authorization') ?? '');
    if (!producer) return c.json({ error: 'Ingestion authorization required' }, 401);
    if (producer.role !== receipt.targetRole || producer.scenarioId !== receipt.scenarioId || producer.runId !== receipt.runId || producer.releaseDigest !== receipt.releaseDigest || Date.parse(receipt.observedAt) > now() + 5000) return c.json({ error: 'Receipt ownership or clock mismatch' }, 403);
    const payload = JSON.stringify(receipt);
    const accepted = Acceptance.safeParse(env.acceptance);
    if (!accepted.success || accepted.data.receiptId !== receipt.id || accepted.data.receiptDigest !== await contentDigest(payload) || Date.parse(accepted.data.acceptedAt) > now() + 5000) return c.json({ error: 'Trusted receipt acceptance required' }, 403);
    const existing = await env.db.prepare('SELECT payload FROM origin_receipts WHERE receipt_id=?').bind(receipt.id).first<{ payload: string }>();
    if (existing) {
      if (existing.payload !== payload) return c.json({ error: 'Receipt replay differs' }, 409);
      const timing = await env.db.prepare('SELECT payload_digest,accepted_at FROM origin_receipt_acceptance WHERE receipt_id=?').bind(receipt.id).first<{ payload_digest: string; accepted_at: string }>();
      // A legacy NULL acceptance is never backfilled by a later replay.
      if (timing && (timing.payload_digest !== accepted.data.receiptDigest || timing.accepted_at !== accepted.data.acceptedAt)) return c.json({ error: 'Receipt acceptance replay differs' }, 409);
      c.header('x-receipt-id', receipt.id); return c.body(null, 204);
    }
    try {
      const results = await env.db.batch([
        env.db.prepare('INSERT INTO origin_receipts(receipt_id,producer_id,sequence,environment,scenario_id,run_id,request_id,stage,observed_at,payload) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(receipt.id, receipt.producerId, receipt.sequence, role, receipt.scenarioId, receipt.runId, receipt.requestId, receipt.stage, receipt.observedAt, payload),
        env.db.prepare('INSERT INTO origin_receipt_acceptance(receipt_id,payload_digest,accepted_at) VALUES(?,?,?)').bind(receipt.id, accepted.data.receiptDigest, accepted.data.acceptedAt),
      ]);
      if (!Array.isArray(results) || results.length !== 2 || results.some(result => !result || result.success !== true)) throw new Error('Unverified receipt transaction');
    } catch { return c.json({ error: 'Sequence or receipt conflict' }, 409); }
    c.header('x-receipt-id', receipt.id); return c.body(null, 204);
  });
  app.post('/producer-status', async c => {
    const parsed = Checkpoint.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid producer status' }, 400);
    const checkpoint = parsed.data; const producer = await allowedProducer(checkpoint.producerId, c.req.header('authorization') ?? '');
    if (!producer) return c.json({ error: 'Producer authorization required' }, 401);
    if (checkpoint.targetRole !== role || producer.runId !== checkpoint.runId || producer.scenarioId !== checkpoint.scenarioId || Date.parse(checkpoint.watermark) > now() + 5000) return c.json({ error: 'Foreign or future checkpoint' }, 403);
    const existing = await env.db.prepare('SELECT watermark,last_attempted_sequence FROM producer_checkpoints WHERE producer_id=?').bind(producer.producerId).first<{ watermark: string; last_attempted_sequence: number }>();
    if (existing && (existing.watermark > checkpoint.watermark || existing.last_attempted_sequence > checkpoint.lastAttemptedSequence)) return c.json({ error: 'Stale checkpoint' }, 409);
    await env.db.prepare('INSERT INTO producer_checkpoints(producer_id,environment,scenario_id,run_id,last_attempted_sequence,healthy,watermark) VALUES(?,?,?,?,?,?,?) ON CONFLICT(producer_id) DO UPDATE SET last_attempted_sequence=excluded.last_attempted_sequence,healthy=excluded.healthy,watermark=excluded.watermark WHERE excluded.watermark>=watermark AND excluded.last_attempted_sequence>=last_attempted_sequence').bind(producer.producerId, role, producer.scenarioId, producer.runId, checkpoint.lastAttemptedSequence, checkpoint.healthy ? 1 : 0, checkpoint.watermark).run();
    return c.body(null, 204);
  });
  app.get('/receipts', async c => {
    if (!(await equalSecret(c.req.header('authorization') ?? '', `Bearer ${env.readerSecret}`))) return c.json({ error: 'Collector authorization required' }, 401);
    const parsed = Query.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid receipt scope' }, 400);
    const query = parsed.data;
    const result = await env.db.prepare('SELECT o.receipt_id,o.producer_id,o.sequence,o.environment,o.scenario_id,o.run_id,o.request_id,o.stage,o.observed_at,o.payload,a.accepted_at,a.payload_digest FROM origin_receipts o LEFT JOIN origin_receipt_acceptance a ON a.receipt_id=o.receipt_id WHERE o.environment=? AND o.scenario_id=? AND o.run_id=? ORDER BY o.producer_id,o.sequence LIMIT 101').bind(role, query.scenarioId, query.runId).all();
    if (!Array.isArray(result.results)) throw new Error('Unverified receipt read');
    const Row = z.strictObject({ receipt_id: Id, producer_id: ProducerSchema.shape.producerId, sequence: z.number().int().positive(), environment: Role, scenario_id: ScenarioId, run_id: Id, request_id: Id, stage: ReceiptSchema.shape.stage, observed_at: Time, payload: z.string().max(4096), accepted_at: Time.nullable(), payload_digest: Digest.nullable() });
    const timed = await Promise.all(result.results.slice(0, 100).map(async value => {
      const row = Row.parse(value); const receipt = ReceiptSchema.parse(JSON.parse(row.payload));
      const producer = relevantProducer(receipt.producerId);
      if (!producer || receipt.id !== row.receipt_id || receipt.producerId !== row.producer_id || receipt.sequence !== row.sequence || receipt.targetRole !== row.environment || receipt.scenarioId !== row.scenario_id || receipt.runId !== row.run_id || receipt.requestId !== row.request_id || receipt.stage !== row.stage || receipt.observedAt !== row.observed_at || receipt.targetRole !== role || receipt.scenarioId !== query.scenarioId || receipt.runId !== query.runId || receipt.releaseDigest !== producer.releaseDigest) throw new Error('Unverified receipt read identity');
      const trusted = row.accepted_at !== null && row.payload_digest === await contentDigest(JSON.stringify(receipt)) && Date.parse(row.accepted_at) <= now() + 5000;
      return { receipt, acceptedAt: row.accepted_at, trusted };
    }));
    function relevantProducer(id: string) { return producers.find(producer => producer.producerId === id && producer.runId === query.runId && producer.scenarioId === query.scenarioId); }
    const all = timed.map(row => row.receipt);
    const relevant = producers.filter(p => p.runId === query.runId && p.scenarioId === query.scenarioId);
    const gaps: string[] = []; let healthy = relevant.length > 0; let complete = relevant.length > 0 && result.results.length <= 100;
    let watermark: string | null = null;
    for (const p of relevant) {
      const stateRow = await env.db.prepare('SELECT last_attempted_sequence,healthy,watermark FROM producer_checkpoints WHERE producer_id=? AND environment=? AND run_id=? AND scenario_id=?').bind(p.producerId, role, query.runId, query.scenarioId).first();
      const state = stateRow === null ? null : z.strictObject({ last_attempted_sequence: z.number().int().nonnegative(), healthy: z.union([z.literal(0), z.literal(1)]), watermark: Time }).parse(stateRow);
      const receipts = all.filter(r => r.producerId === p.producerId);
      const contiguous = receipts.every((r, i) => r.sequence === i + 1);
      if (!state || !state.healthy || !contiguous || state.last_attempted_sequence !== receipts.length) { healthy = false; complete = false; gaps.push(`Producer ${p.producerId} coverage unknown`); }
      if (!state || state.watermark < query.end || Date.parse(state.watermark) > now() + 5000) complete = false;
      if (state && (watermark === null || state.watermark < watermark)) watermark = state.watermark;
    }
    if (Date.parse(query.end) > now()) complete = false;
    const groups = new Map<string, { entry?: typeof timed[number]; completion?: typeof timed[number] }>();
    const inAcceptedWindow = (row: typeof timed[number]) => row.trusted && row.acceptedAt !== null && Date.parse(row.acceptedAt) >= Date.parse(query.start) && Date.parse(row.acceptedAt) <= Date.parse(query.end);
    for (const row of timed) {
      const key = `${row.receipt.producerId}:${row.receipt.requestId}`; const group = groups.get(key) ?? {};
      if (group[row.receipt.stage] || !row.trusted) { healthy = false; complete = false; }
      group[row.receipt.stage] = row; groups.set(key, group);
    }
    for (const group of groups.values()) {
      const entry = group.entry; const completion = group.completion;
      const matching = entry?.trusted && completion?.trusted && entry.acceptedAt !== null && completion.acceptedAt !== null && entry.receipt.id !== completion.receipt.id && entry.receipt.sequence < completion.receipt.sequence && entry.receipt.targetRole === completion.receipt.targetRole && entry.receipt.scenarioId === completion.receipt.scenarioId && entry.receipt.runId === completion.receipt.runId && entry.receipt.releaseDigest === completion.receipt.releaseDigest && entry.receipt.rayId === completion.receipt.rayId && Date.parse(entry.acceptedAt) <= Date.parse(completion.acceptedAt);
      if (!matching || (entry && completion && inAcceptedWindow(entry) !== inAcceptedWindow(completion))) { healthy = false; complete = false; }
    }
    if (!healthy || !complete) { if (!gaps.length) gaps.push('Trusted complete stage timing unavailable'); }
    // Container observedAt is preserved, but never chooses the trusted window.
    const inWindow = timed.filter(inAcceptedWindow).map(row => row.receipt);
    return c.json({ schemaVersion: 1, targetRole: role, runId: query.runId, scenarioId: query.scenarioId, originCount: healthy && complete ? inWindow.filter(r => r.stage === 'entry').length : null, receipts: inWindow, coverage: { healthy, complete, windowStart: query.start, watermark, producerSequence: relevant.length === 1 && healthy ? all.length : null, gaps } });
  });
  app.notFound(c => c.json({ error: 'Telemetry route not found' }, 404));
  app.onError((_error, c) => c.json({ error: 'Telemetry query failed', originCoverage: 'unknown' }, 503));
  return app;
}
