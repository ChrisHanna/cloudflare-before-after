import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { collectTrustedImage, inspectBoundedPng, observedImageDelivery, TRUSTED_IMAGE_LIMITS, type TrustedImageRequest } from '../packages/demo-core/src/trusted-collectors-image.js';
import type { TrustedCollectorsOptions } from '../packages/demo-core/src/trusted-collectors.js';
import { labConfig } from './fixtures/lab.js';
import { SYNTHETIC_IMAGE_BASE64, SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.stop()); vi.restoreAllMocks(); });
function chunk(type: string, data: Buffer): Buffer {
  const kind = Buffer.from(type); let crc = 0xffffffff;
  for (const byte of Buffer.concat([kind, data])) {
    crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length); const suffix = Buffer.alloc(4); suffix.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([prefix, kind, data, suffix]);
}
function png(width = 1, height = 1, raw: Buffer = Buffer.from([0, 255, 0, 0, 255])): Buffer {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function fixture() {
  const config = labConfig(); config.liveOptIn = true;
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const input: TrustedImageRequest = { role: 'after', resourceId: 'after-image', runId: randomUUID(), requestId: randomUUID(), scenarioId: 'waf-custom', releaseDigest: 'a'.repeat(64), deliveryAccount: 'owned', variant: 'public' };
  const calls: { url: string; init: RequestInit }[] = [];
  const options: TrustedCollectorsOptions = { config, ledger, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)),
    credentials: { reader: 'offline-reader-distinct-credential', collector: 'offline-collector-distinct-credential', runner: 'offline-runner-distinct-credential' },
    dispatch: async (url, init) => { calls.push({ url, init }); return new Response(new Uint8Array(png()), { headers: { 'content-type': 'image/png' } }); } };
  return { options, input, calls };
}
describe('trusted image actual byte decode and browser readback', () => {
  it('decodes the actual immutable setup seed without weakening PNG checks', async () => {
    const f = fixture(); const bytes = Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64');
    expect(inspectBoundedPng(bytes)).toMatchObject({ width: 256, height: 256, encodedDigest: SYNTHETIC_IMAGE_DIGEST });
    const result = await collectTrustedImage({ ...f.options, dispatch: async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } }) }, f.input);
    expect(result.state).toBe('observed'); expect(result.value?.encodedDigest).toBe(SYNTHETIC_IMAGE_DIGEST);
    expect(result.value?.pixelDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.value?.applicationJoin).toBe('unknown');
  }, 15000);
  it('uses one guarded read and a real isolated local Chromium pixel readback', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    const result = await collectTrustedImage(f.options, f.input);
    expect(result.state).toBe('observed'); expect(result.mode).toBe('fixture'); expect(result.value?.source).toBe('observed-browser');
    expect(result.value?.pixelDigest).toBe(createHash('sha256').update(Buffer.from([255, 0, 0, 255])).digest('hex'));
    expect(result.value?.encodedDigest).toBe(createHash('sha256').update(png()).digest('hex'));
    expect(result.value?.applicationJoin).toBe('unknown'); expect(result.value?.width).toBe(1); expect(result.value?.height).toBe(1);
    expect(f.options.ledger.snapshot.requestsUsed).toBe(1); expect(f.options.ledger.snapshot.sessionsUsed).toBe(1); expect(f.options.ledger.snapshot.activeRequests).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url).toBe('https://imagedelivery.net/owned/after-image/public');
    const headers = new Headers(f.calls[0]!.init.headers); expect(headers.get('authorization')).toBeNull(); expect(headers.get('x-demo-run-token')).toBeNull(); expect(fetch).not.toHaveBeenCalled();
  }, 15000);
  it('derives delivery facts from the actual URL and bounded returned bytes without a browser', () => {
    const bytes = png(); const result = observedImageDelivery('https://imagedelivery.net/actual-account/actual-image/public', bytes);
    expect(result).toEqual({ deliveryOrigin: 'https://imagedelivery.net', accountHash: 'actual-account', resourceId: 'actual-image', variant: 'public', encodedDigest: createHash('sha256').update(bytes).digest('hex') });
    const changed = observedImageDelivery('https://imagedelivery.net/another-account/actual-image/public', Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64'));
    expect(changed.accountHash).toBe('another-account'); expect(changed.encodedDigest).toBe(SYNTHETIC_IMAGE_DIGEST);
    expect(changed.encodedDigest).not.toBe(result.encodedDigest);
  });
  it.each(['https://foreign.example.test/account/image/public', 'https://imagedelivery.net/account/image/public?token=hidden',
    'https://imagedelivery.net/account/image/public#hidden', 'https://user:pass@imagedelivery.net/account/image/public',
    'https://imagedelivery.net/account/image/public/extra', 'https://imagedelivery.net/account/image/%70ublic'])('rejects unsupported measured delivery target %s without a browser', target => {
    expect(() => observedImageDelivery(target, png())).toThrow();
  });
  it.each(['width', 'height', 'pixels', 'inflate', 'truncated', 'crc', 'filter', 'encoded', 'tail', 'format'])('rejects PNG %s faults before browser launch', async fault => {
    const f = fixture(); let body = png();
    if (fault === 'width') body = png(TRUSTED_IMAGE_LIMITS.dimension + 1);
    if (fault === 'height') body = png(1, TRUSTED_IMAGE_LIMITS.dimension + 1);
    if (fault === 'pixels') body = png(512, 512);
    if (fault === 'inflate') body = png(1, 1, Buffer.alloc(100000));
    if (fault === 'truncated') body = body.subarray(0, body.length - 4);
    if (fault === 'crc') body[29] = body[29]! ^ 1;
    if (fault === 'filter') body = png(1, 1, Buffer.from([5, 0, 0, 0, 255]));
    if (fault === 'encoded') body = Buffer.alloc(TRUSTED_IMAGE_LIMITS.encodedBytes + 1);
    if (fault === 'tail') body = Buffer.concat([body, Buffer.from('hidden')]);
    if (fault === 'format') body = Buffer.from('<svg onload="fetch(\"https://evil.example\")"/>');
    expect(() => inspectBoundedPng(body)).toThrow();
    const result = await collectTrustedImage({ ...f.options, dispatch: async () => new Response(new Uint8Array(body), { headers: { 'content-type': 'image/png' } }) }, f.input);
    expect(result.state).toBe('unknown'); expect(result.value).toBeNull(); expect(f.options.ledger.snapshot.sessionsUsed).toBe(0); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it('keeps unsupported content types and plain 403 separate from decode proof', async () => {
    const f = fixture();
    const unsupported = await collectTrustedImage({ ...f.options, dispatch: async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }) }, f.input);
    expect(unsupported.state).toBe('unsupported'); expect(unsupported.value).toBeNull();
    const denied = await collectTrustedImage({ ...f.options, dispatch: async () => new Response('denied', { status: 403 }) }, f.input);
    expect(denied.permission).toBe('denied'); expect(denied.entitlement).toBe('unknown'); expect(f.options.ledger.snapshot.sessionsUsed).toBe(0);
  });
  it('denies default transport, foreign assets/releases and arbitrary delivery paths', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network')); const options = { ...f.options }; delete options.dispatch;
    expect((await collectTrustedImage(options, f.input)).state).toBe('unknown'); expect(fetch).not.toHaveBeenCalled();
    for (const bad of [{ resourceId: 'before-image' }, { releaseDigest: 'f'.repeat(64) }, { variant: '../private' }, { deliveryAccount: 'https://evil.example' }]) {
      await expect(collectTrustedImage(f.options, { ...f.input, ...bad })).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });
  it('stops cancelled reads and never follows an external redirect', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    expect((await collectTrustedImage(f.options, f.input, abort.signal)).state).toBe('unknown'); expect(f.calls).toHaveLength(0);
    const redirect = await collectTrustedImage({ ...f.options, dispatch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) }, f.input);
    expect(redirect.state).toBe('unknown'); expect(redirect.value).toBeNull(); expect(f.options.ledger.snapshot.requestsUsed).toBe(1);
  });
  it('cancels a stalled image body and releases its permit', async () => {
    const f = fixture(); const abort = new AbortController(); let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ start() {}, cancel() { cancelled = true; } });
    const pending = collectTrustedImage({ ...f.options, dispatch: async () => { queueMicrotask(() => abort.abort()); return new Response(body, { headers: { 'content-type': 'image/png' } }); } }, f.input, abort.signal);
    expect((await pending).state).toBe('unknown'); expect(cancelled).toBe(true); expect(f.options.ledger.snapshot.activeRequests).toBe(0);
  });
});
