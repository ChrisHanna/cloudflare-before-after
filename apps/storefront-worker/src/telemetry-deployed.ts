import { z } from 'zod';
import { Id, Role, ScenarioId, ReceiptSchema, Time, Digest } from '../../../packages/contracts/src/schemas.js';
import { createTelemetryApp } from './telemetry.js';
import { contentDigest } from './assets.js';
import type { Database } from './d1.js';
import { ProducerIdentity, deriveIngestSecret, matchesSecret, registerProducer, registeredProducers } from './registry.js';
interface Env {
  ORIGIN: string; RELEASE_DIGEST: string; DB_BEFORE: Database; DB_AFTER: Database; COLLECTOR_SECRET: string;
  REGISTRY_SECRET_BEFORE: string; REGISTRY_SECRET_AFTER: string;
  INGEST_ROOT_SECRET_BEFORE: string; INGEST_ROOT_SECRET_AFTER: string;
}
async function boundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader(); if (!reader) throw new Error('Body required');
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 4096) { await reader.cancel(); throw new Error('Body exceeds cap'); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url); if (url.origin !== env.ORIGIN) return new Response('Wrong telemetry host', { status: 421 });
      const body = request.method === 'POST' ? await boundedBody(request) : undefined;
      const input: unknown = body === undefined ? null : JSON.parse(body);
      const object = z.object({ targetRole: Role.optional(), role: Role.optional(), runId: Id, scenarioId: ScenarioId }).parse(input ?? { targetRole: url.searchParams.get('role'), runId: url.searchParams.get('runId'), scenarioId: url.searchParams.get('scenarioId') });
      const role = Role.parse(object.targetRole ?? object.role);
      const db = role === 'before' ? env.DB_BEFORE : env.DB_AFTER;
      const registrySecret = role === 'before' ? env.REGISTRY_SECRET_BEFORE : env.REGISTRY_SECRET_AFTER;
      const root = role === 'before' ? env.INGEST_ROOT_SECRET_BEFORE : env.INGEST_ROOT_SECRET_AFTER;
      if (url.pathname === '/registry') {
        if (request.method !== 'POST' || !(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${registrySecret}`))) return new Response('Producer registry authorization required', { status: 401 });
        const identity = ProducerIdentity.parse(input); if (identity.role !== role) return new Response('Foreign registration', { status: 403 });
        await registerProducer(db, identity); return new Response(null, { status: 204 });
      }
      if (!['/ingest', '/producer-status', '/receipts'].includes(url.pathname)) return new Response('Telemetry route not found', { status: 404 });
      if (url.pathname === '/receipts') {
        if (!(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${env.COLLECTOR_SECRET}`))) return new Response('Collector authorization required', { status: 401 });
      } else {
        const detail = z.object({ producerId: z.string(), releaseDigest: z.string().optional() }).parse(input);
        const identity = ProducerIdentity.parse({ producerId: detail.producerId, role, runId: object.runId, scenarioId: object.scenarioId, releaseDigest: detail.releaseDigest ?? env.RELEASE_DIGEST });
        if (!(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${await deriveIngestSecret(identity, root)}`))) return new Response('Producer authorization required', { status: 401 });
      }
      const producers = await registeredProducers(db, role, object.runId, object.scenarioId, root);
      let acceptance: { schemaVersion: 1; receiptId: string; acceptedAt: string; receiptDigest: string } | undefined;
      if (url.pathname === '/ingest') {
        const receipt = ReceiptSchema.parse(input);
        const producer = producers.find(value => value.producerId === receipt.producerId);
        if (!producer || receipt.targetRole !== role || receipt.scenarioId !== object.scenarioId || receipt.runId !== object.runId || receipt.releaseDigest !== producer.releaseDigest) return new Response('Receipt ownership mismatch', { status: 403 });
        const encoded = z.string().min(1).max(512).parse(request.headers.get('x-origin-receipt-acceptance'));
        const signature = Digest.parse(request.headers.get('x-origin-receipt-acceptance-signature'));
        const parsed = z.strictObject({ schemaVersion: z.literal(1), receiptId: Id, acceptedAt: Time, receiptDigest: Digest }).parse(JSON.parse(encoded));
        const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const bytes = new Uint8Array(signature.match(/../g)!.map(part => parseInt(part, 16)));
        if (!(await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(`origin-stage-acceptance-v1\n${encoded}`))) || parsed.receiptId !== receipt.id || parsed.receiptDigest !== await contentDigest(JSON.stringify(receipt)) || Date.parse(parsed.acceptedAt) > Date.now() + 5000) return new Response('Trusted receipt acceptance required', { status: 403 });
        acceptance = parsed;
      }
      const app = createTelemetryApp({ db, role, origin: env.ORIGIN, readerSecret: env.COLLECTOR_SECRET, producers, ...(acceptance ? { acceptance } : {}) });
      url.searchParams.delete('role');
      return await app.fetch(new Request(url, { method: request.method, headers: request.headers, ...(body !== undefined ? { body } : {}) }));
    } catch { return new Response('Telemetry unavailable; origin coverage unknown', { status: 503 }); }
  },
};
