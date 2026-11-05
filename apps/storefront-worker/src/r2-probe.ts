import { z } from 'zod';
import { Digest } from '../../../packages/contracts/src/schemas.js';
import { R2ProbeRowSchema, R2_PROBE_MARKER, r2ProbeKey, type R2WriteReadReceipt } from '../../../packages/contracts/src/r2-probe.js';
import { contentDigest, type ObjectBucket } from './assets.js';
const Metadata = z.object({ key: z.string().min(1).max(512), version: z.string().min(1).max(128), etag: z.string().min(1).max(128),
  size: z.number().int().min(0).max(2048), customMetadata: z.strictObject({ owner: z.string().max(512), digest: Digest }) });
type Outcome = Pick<R2WriteReadReceipt, 'probeId' | 'write' | 'read' | 'cleanup' | 'contentDigest'>;
async function boundedText(value: unknown, signal?: AbortSignal): Promise<string> {
  const body: ReadableStream<Uint8Array> | undefined = value && typeof value === 'object' ? Reflect.get(value, 'body') : undefined;
  if (!body || typeof body.getReader !== 'function') throw new Error('R2 body stream unavailable');
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let length = 0; let finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) { signal?.throwIfAborted(); const part = await reader.read(); signal?.throwIfAborted(); if (part.done) { finished = true; break; }
      length += part.value.byteLength; if (length > 2048) throw new Error('R2 probe body exceeds cap'); chunks.push(part.value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } finally {
    signal?.removeEventListener('abort', abort);
    // Cancellation closes a standard stream synchronously, but its underlying
    // cancel hook may never settle. It must not gate ownership-checked cleanup.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function discard(value: unknown): void {
  try { const body = value && typeof value === 'object' ? Reflect.get(value, 'body') : null; if (body && !body.locked) void body.cancel().catch(() => {}); } catch { /* No response details escape. */ }
}
/** Only server-generated scoped keys and fixed marker bytes, never caller content. */
export async function runR2WriteRead(bucket: ObjectBucket, input: { role: 'before' | 'after'; runId: string; requestId: string; signal?: AbortSignal }, probeId = crypto.randomUUID()): Promise<Outcome> {
  const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId,
    request_id: input.requestId, probe_id: probeId, marker: R2_PROBE_MARKER });
  const key = r2ProbeKey(row); const text = JSON.stringify(row); const digest = await contentDigest(text);
  const outcome: Outcome = { probeId, write: 'unknown', read: 'unknown', cleanup: 'unknown', contentDigest: null };
  let created: z.infer<typeof Metadata> | null = null; let current: unknown;
  const matches = (value: z.infer<typeof Metadata>) => value.key === key && value.size === new TextEncoder().encode(text).byteLength
    && value.customMetadata.owner === key && value.customMetadata.digest === digest;
  const sameVersion = (value: z.infer<typeof Metadata>) => created !== null && matches(value) && value.version === created.version && value.etag === created.etag;
  try {
    // Workers-types documents conditional PUT => object or null. A null/failed
    // response cannot prove new-object ownership and never permits cleanup.
    input.signal?.throwIfAborted();
    const result = Metadata.parse(await bucket.put(key, text, { customMetadata: { owner: key, digest }, onlyIf: { etagDoesNotMatch: '*' } }));
    if (!matches(result)) throw new Error('R2 create identity mismatch');
    created = result; outcome.write = 'observed';
    current = await bucket.get(key); const read = Metadata.parse(current);
    if (!sameVersion(read)) throw new Error('R2 read ownership or version mismatch');
    const actualText = await boundedText(current, input.signal); const actual = R2ProbeRowSchema.parse(JSON.parse(actualText));
    if (JSON.stringify(actual) !== text || actualText !== text) throw new Error('R2 marker read differs');
    outcome.contentDigest = await contentDigest(actualText); outcome.read = 'observed';
  } catch { /* Unknown data/ownership must not become an observed operation. */ }
  finally {
    discard(current);
    if (created && bucket.head) try {
      const latest = Metadata.parse(await bucket.head(key));
      if (!sameVersion(latest)) throw new Error('R2 object changed before cleanup');
      // Binding DELETE has no conditional option. This key is unexposed until
      // this server-owned operation finishes; out-of-band writers are outside
      // this probe's guarantees, not independently proven storage isolation.
      await bucket.delete(key);
      if (await bucket.head(key) === null) outcome.cleanup = 'observed';
    } catch { /* Version mismatch, failed delete or missing absence stays unknown. */ }
  }
  return outcome;
}
