import { z } from 'zod';
import { ReceiptSchema } from '../../../packages/contracts/src/schemas.js';
import { ProducerIdentity, deriveIngestSecret, matchesSecret } from './registry.js';

/** Fixed server configuration only. No request-derived origin or wildcard hosts. */
export function telemetryOrigin(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.port || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) || url.hostname.includes('*')) throw new Error('Invalid telemetry origin');
  return url;
}
export function requestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000);
}
export async function boundedText(response: Response | Request, cap: number): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return '';
  let size = 0; let text = ''; const decoder = new TextDecoder();
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > cap) { await reader.cancel(); throw new Error('Runtime body exceeds cap'); } text += decoder.decode(part.value, { stream: true }); } return text + decoder.decode(); }
  finally { reader.releaseLock(); }
}
export async function telemetryAck(origin: string, path: '/registry' | '/producer-status', secret: string, value: unknown, signal?: AbortSignal): Promise<void> {
  if (!['/registry', '/producer-status'].includes(path) || secret.length < 24) throw new Error('Invalid telemetry request');
  const target = new URL(path, telemetryOrigin(origin));
  const response = await fetch(target, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(value), signal: requestSignal(signal) });
  await response.body?.cancel();
  if (response.status !== 204 || response.redirected) throw new RuntimeHttpError(response.status);
}
export class RuntimeHttpError extends Error { constructor(readonly status: number) { super('Runtime HTTP rejection'); } }
export const ProducerCheckpoint = z.strictObject({ producerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), targetRole: ProducerIdentity.shape.role, scenarioId: ProducerIdentity.shape.scenarioId, runId: ProducerIdentity.shape.runId, lastAttemptedSequence: z.number().int().nonnegative(), healthy: z.boolean(), watermark: z.iso.datetime() });
export function checkpointFor(value: unknown, identity: z.infer<typeof ProducerIdentity>) {
  const checkpoint = ProducerCheckpoint.parse(value);
  if (checkpoint.producerId !== identity.producerId || checkpoint.targetRole !== identity.role || checkpoint.scenarioId !== identity.scenarioId || checkpoint.runId !== identity.runId) throw new Error('Foreign producer checkpoint');
  return checkpoint;
}
export interface ReceiptRelayEnv { TELEMETRY_ORIGIN: string; ROLE: 'before' | 'after'; RELEASE_DIGEST: string; INGEST_ROOT_SECRET: string }
/** SDK runtime handler params are server-derived and persisted by the SDK, never caller headers. */
export async function relayReceipt(request: Request, env: ReceiptRelayEnv, params: unknown): Promise<Response> {
  try {
    const origin = telemetryOrigin(env.TELEMETRY_ORIGIN); const url = new URL(request.url);
    if (request.method !== 'POST' || url.href !== `${origin.origin}/ingest` || url.username || url.password || url.port || url.search || url.hash) return new Response(null, { status: 403 });
    const identity = ProducerIdentity.parse(params);
    if (identity.role !== env.ROLE || identity.releaseDigest !== env.RELEASE_DIGEST) return new Response(null, { status: 403 });
    const secret = await deriveIngestSecret(identity, env.INGEST_ROOT_SECRET);
    if (!(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${secret}`))) return new Response(null, { status: 401 });
    const receipt = ReceiptSchema.parse(JSON.parse(await boundedText(request, 8192)));
    if (receipt.targetRole !== identity.role || receipt.scenarioId !== identity.scenarioId || receipt.runId !== identity.runId || receipt.producerId !== identity.producerId || receipt.releaseDigest !== identity.releaseDigest) return new Response(null, { status: 403 });
    const response = await fetch(`${origin.origin}/ingest`, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(receipt), signal: requestSignal(request.signal) });
    await response.body?.cancel();
    if (response.status !== 204 || response.redirected || response.headers.get('x-receipt-id') !== receipt.id) return new Response(null, { status: 503 });
    return new Response(null, { status: 204, headers: { 'x-receipt-id': receipt.id } });
  } catch { return new Response(null, { status: 503 }); }
}
