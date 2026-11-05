import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { z } from 'zod';
import { ImageDeliveryReadbackSchema, type ImageDeliveryReadback } from '../../contracts/src/public-variant-proof.js';
import { Digest, Id, Role, ScenarioId } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { GuardedClient } from './transport.js';
import { LabConfigSchema } from './config.js';
import { selectedImageVariantId } from './image-variant-selection.js';
import type { TrustedCollectorsOptions, TrustedRead } from './trusted-collectors.js';

export const TRUSTED_IMAGE_LIMITS = Object.freeze({ encodedBytes: 32768, pixels: 65536, dimension: 512, decodedBytes: 262144, timeoutMs: 5000 });
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
/** Small, non-animated PNG subset. Check dimensions/inflate bounds BEFORE any
 * browser decoder sees bytes. Unsupported formats are not a successful load. */
export function inspectBoundedPng(bytes: Uint8Array): { width: number; height: number; encodedDigest: string } {
  const b = Buffer.from(bytes); const cap = TRUSTED_IMAGE_LIMITS;
  if (b.length > cap.encodedBytes || b.length < 57 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Unsupported or oversized PNG');
  let offset = 8; let width = 0; let height = 0; let channels = 0; let ended = false; let idatEnded = false;
  const data: Buffer[] = [];
  while (offset < b.length) {
    if (offset + 12 > b.length) throw new Error('Truncated PNG chunk');
    const length = b.readUInt32BE(offset); const end = offset + length + 12;
    if (end > b.length) throw new Error('Truncated PNG body');
    const type = b.subarray(offset + 4, offset + 8).toString('ascii'); const body = b.subarray(offset + 8, end - 4);
    if (crc32(b.subarray(offset + 4, end - 4)) !== b.readUInt32BE(end - 4)) throw new Error('PNG checksum mismatch');
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG header missing');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) throw new Error('Duplicate or malformed PNG header');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      if (!width || !height || width > cap.dimension || height > cap.dimension || width * height > cap.pixels || body[8] !== 8 || ![2, 6].includes(body[9]!) || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new Error('PNG decode bounds or format unsupported');
      channels = body[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      if (idatEnded) throw new Error('Noncontiguous PNG data');
      data.push(body);
    } else if (type === 'IEND') {
      if (length !== 0 || end !== b.length || !data.length) throw new Error('Malformed PNG end');
      ended = true;
    } else {
      // Reject animation, profiles, transparency tables, scripts and arbitrary
      // ancillary payloads instead of passing unbounded work to Chromium.
      throw new Error('PNG chunk unsupported');
    }
    if (data.length && type !== 'IDAT') idatEnded = true;
    offset = end;
  }
  if (!ended) throw new Error('PNG end missing');
  const row = width * channels + 1; const expected = row * height;
  const decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected });
  if (decoded.length !== expected || width * height * 4 > cap.decodedBytes) throw new Error('PNG decoded size mismatch');
  for (let i = 0; i < height; i++) if (decoded[i * row]! > 4) throw new Error('PNG row filter unsupported');
  return { width, height, encodedDigest: sha(b) };
}
/** Build content-bound facts only from the actual guarded target and returned bytes. */
export function observedImageDelivery(target: string, bytes: Uint8Array): ImageDeliveryReadback {
  const url = new URL(target); const parts = url.pathname.split('/');
  if (url.username || url.password || url.search || url.hash || parts.length !== 4 || parts[0] !== '') throw new Error('Unsupported actual image delivery tuple');
  return ImageDeliveryReadbackSchema.parse({ deliveryOrigin: url.origin, accountHash: parts[1], resourceId: parts[2], variant: parts[3], encodedDigest: inspectBoundedPng(bytes).encodedDigest });
}
export interface TrustedImageRequest {
  role: 'before' | 'after'; runId: string; scenarioId: z.infer<typeof ScenarioId>; requestId: string;
  releaseDigest: string; resourceId: string;
  /** Immutable delivery tuple from the owned asset inventory, not arbitrary URL input. */
  deliveryAccount: string; variant: string;
}
export interface TrustedImageReadback {
  role: 'before' | 'after'; runId: string; requestId: string; scenarioId: z.infer<typeof ScenarioId>;
  releaseDigest: string; resourceId: string; variant: string; source: 'observed-browser';
  delivery: ImageDeliveryReadback;
  width: number; height: number; bodyBytes: number; encodedDigest: string; pixelDigest: string;
  /** Delivery is observed. Application use/release binding still needs receipts. */
  applicationJoin: 'unknown';
}
async function boundedBytes(response: Response, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Image body missing');
  const parts: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
      size += part.value.byteLength;
      if (size > TRUSTED_IMAGE_LIMITS.encodedBytes) { await reader.cancel(); throw new Error('Image encoded byte cap'); }
      parts.push(part.value);
    }
    return Buffer.concat(parts);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function installedChromium(): string {
  const preferred = chromium.executablePath(); if (existsSync(preferred)) return preferred;
  // Read only the installed browser cache. Never install or inspect profiles.
  const cache = join(homedir(), '.cache', 'ms-playwright');
  const versions = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().slice(0, 16);
  for (const version of versions) {
    const path = join(cache, version, 'chrome-linux64', 'chrome');
    if (existsSync(path)) return path;
  }
  throw new Error('Installed Chromium unavailable');
}
export async function collectTrustedImage(options: TrustedCollectorsOptions, input: TrustedImageRequest, signal?: AbortSignal): Promise<TrustedRead<TrustedImageReadback>> {
  const config = LabConfigSchema.parse(options.config); Role.parse(input.role); Id.parse(input.runId); Id.parse(input.requestId); ScenarioId.parse(input.scenarioId); Digest.parse(input.releaseDigest);
  const env = config.environments.find(e => e.role === input.role)!;
  const segment = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
  for (const value of [input.resourceId, input.deliveryAccount, input.variant]) segment.parse(value);
  if (!env.imageIds.includes(input.resourceId) || input.releaseDigest !== env.releaseDigest) throw new Error('Foreign image ownership or release');
  if (config.imageVariant && input.variant !== selectedImageVariantId(config.labId, config.imageVariant)) throw new Error('Image decode variant differs from the explicit public selection');
  z.enum(['live', 'fixture']).parse(options.mode);
  const result = (state: TrustedRead<TrustedImageReadback>['state'], value: TrustedImageReadback | null, gaps: string[], permission: TrustedRead<TrustedImageReadback>['permission'] = 'unknown'): TrustedRead<TrustedImageReadback> => ({ state, value, gaps, permission, entitlement: 'unknown', mode: options.mode, observedAt: new Date((options.now ?? Date.now)()).toISOString() });
  const url = `https://imagedelivery.net/${input.deliveryAccount}/${input.resourceId}/${input.variant}`;
  let bytes: Buffer | null = null; let delivery: ImageDeliveryReadback | null = null; let denied = false;
  const client = new GuardedClient(config, options.ledger, { observedOwnedResources: options.observedOwnedResources, redactor: new Redactor(Object.values(options.credentials)), dispatch: async (target, init) => {
    if (!options.dispatch || target !== url) throw new Error('Image transport denied by default');
    const response = await options.dispatch(target, init);
    if ([401, 403].includes(response.status)) denied = true;
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0] !== 'image/png') { await response.body?.cancel(); return new Response(null, { status: response.status }); }
    bytes = await boundedBytes(response, init.signal!);
    delivery = observedImageDelivery(target, bytes);
    // The binary is consumed within GuardedClient's acquired permit. Never
    // round-trip binary through its text/excerpt/redaction interface.
    return new Response(null, { status: 200 });
  } });
  const deadline = AbortSignal.timeout(TRUSTED_IMAGE_LIMITS.timeoutMs); const work = new AbortController();
  const cancelWork = options.ledger.clock.schedule(Math.max(0, options.ledger.workDeadline - options.ledger.clock.now()), () => work.abort());
  const effective = AbortSignal.any([options.ledger.signal, deadline, work.signal, ...(signal ? [signal] : [])]);
  try {
    const response = await client.request({ kind: 'image', url, retries: 0 }, effective);
    if (denied) return result('unknown', null, ['Image read denied'], 'denied');
    if (response.status !== 200 || bytes === null || delivery === null) return result('unsupported', null, ['Image response is not a supported bounded PNG']);
    const actualDelivery = delivery as ImageDeliveryReadback;
    const body = bytes as Buffer; const meta = inspectBoundedPng(body); effective.throwIfAborted();
    // A real local browser decodes and reads pixels. No remote browser I/O,
    // browser credentials, caller-provided decoder, or asserted success flag.
    options.ledger.openSession();
    const browser = await chromium.launch({ executablePath: installedChromium(), headless: true, timeout: TRUSTED_IMAGE_LIMITS.timeoutMs,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) } });
    const abort = () => { void browser.close().catch(() => {}); };
    effective.addEventListener('abort', abort, { once: true });
    try {
      effective.throwIfAborted();
      const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      await context.route('**/*', route => route.abort());
      await context.routeWebSocket('**/*', socket => socket.close());
      const page = await context.newPage();
      const pixels = await page.evaluate(async ({ base64, width, height }) => {
        const image = new Image(); image.src = `data:image/png;base64,${base64}`; await image.decode();
        if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('Image dimensions changed');
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(image, 0, 0);
        return Array.from(ctx.getImageData(0, 0, width, height).data);
      }, { base64: body.toString('base64'), width: meta.width, height: meta.height });
      effective.throwIfAborted();
      if (pixels.length !== meta.width * meta.height * 4) throw new Error('Image readback size mismatch');
      return result('observed', { role: input.role, runId: input.runId, requestId: input.requestId, scenarioId: input.scenarioId, releaseDigest: input.releaseDigest,
        resourceId: actualDelivery.resourceId, variant: actualDelivery.variant, delivery: actualDelivery, source: 'observed-browser', width: meta.width, height: meta.height, bodyBytes: body.length,
        encodedDigest: actualDelivery.encodedDigest, pixelDigest: sha(Uint8Array.from(pixels)), applicationJoin: 'unknown' }, ['Image decode does not attest application release or service use'], 'granted');
    } finally { effective.removeEventListener('abort', abort); await browser.close(); }
  } catch { return result('unknown', null, ['Image read/decode failed, stopped, or exceeded bounds']); }
  finally { cancelWork(); }
}
