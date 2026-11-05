import { describe, expect, it, vi } from 'vitest';
import { readStorefront, type ReadbackOptions } from '../packages/demo-core/src/storefront-readback.js';

const expected = { role: 'after' as const, releaseDigest: 'a'.repeat(64) };
const ok = (headers: Record<string, string> = {}, body = 'Synthetic launch shirt') => new Response(body, { status: 200, headers: { 'x-lab-role': 'after', 'x-lab-release': expected.releaseDigest, 'x-lab-services': 'd1,r2,images-reference,container-completed', ...headers } });
const fast = () => ({ sleep: vi.fn(async () => {}), delayMs: () => 1 });
const run = (dispatch: (url: string, init: RequestInit) => Promise<Response>, options: ReadbackOptions = fast(), signal = new AbortController().signal) => readStorefront(dispatch, 'https://after.example.test', expected, signal, options);

describe('final storefront readback', () => {
  it('passes on the first exact response without waiting', async () => {
    const dispatch = vi.fn(async (_url: string, _init: RequestInit) => ok()); const options = fast();
    await run(dispatch, options); expect(dispatch).toHaveBeenCalledTimes(1); expect(options.sleep).not.toHaveBeenCalled();
    expect(dispatch.mock.calls[0]![0]).toBe('https://after.example.test/catalog');
  });
  it.each([['a cold-start 503', () => new Response('Container unavailable', { status: 503 })], ['a 429', () => new Response(null, { status: 429 })], ['a network error', () => { throw new TypeError('fetch failed'); }]])('retries %s and then passes', async (_name, first) => {
    let n = 0; const dispatch = vi.fn(async () => (++n === 1 ? first() : ok())); const options = fast();
    await run(dispatch, options); expect(dispatch).toHaveBeenCalledTimes(2); expect(options.sleep).toHaveBeenCalledTimes(1);
  });
  it('gives up after the bounded number of attempts', async () => {
    const dispatch = vi.fn(async () => new Response('Container unavailable', { status: 503 })); const options = fast();
    await expect(run(dispatch, options)).rejects.toThrow('Deployed storefront readback failed');
    expect(dispatch).toHaveBeenCalledTimes(3); expect(options.sleep).toHaveBeenCalledTimes(2);
  });
  it.each([
    ['a different release', () => ok({ 'x-lab-release': 'b'.repeat(64) })],
    ['a different role', () => ok({ 'x-lab-role': 'before' })],
    ['no completed Container marker', () => ok({ 'x-lab-services': 'd1,r2,images-reference' })],
    ['a body without the synthetic marker', () => ok({}, 'Unrelated page')],
    ['a deterministic 404', () => new Response('missing', { status: 404 })],
  ])('fails fast on %s', async (_name, response) => {
    const dispatch = vi.fn(async () => response()); const options = fast();
    await expect(run(dispatch, options)).rejects.toThrow('Deployed storefront readback failed');
    expect(dispatch).toHaveBeenCalledTimes(1); expect(options.sleep).not.toHaveBeenCalled();
  });
  it('treats an attempt timeout as transient and still stops at the attempt cap', async () => {
    const dispatch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))));
    await expect(run(dispatch, { ...fast(), attempts: 2, attemptTimeoutMs: 20 })).rejects.toThrow('Deployed storefront readback failed');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it('stops immediately when the caller aborts', async () => {
    const controller = new AbortController(); const dispatch = vi.fn(async () => { controller.abort(new Error('operator stop')); throw new TypeError('fetch failed'); }); const options = fast();
    await expect(run(dispatch, options, controller.signal)).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(1); expect(options.sleep).not.toHaveBeenCalled();
  });
});
