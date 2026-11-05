import { expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { ForwardActivity } from '../apps/storefront-worker/src/runtime-forward-lifecycle.js';
const canary = 'LIFECYCLE_PROVIDER_CANARY_PRIVATE';
it('actual native SDK alarm protects forwarding/body lifetime and later stops idle work', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('tests/runtime/a511-lifecycle-runner.mjs')], { cwd: resolve('.'), timeout: 60000, maxBuffer: 1024 * 1024 });
  expect(`${stdout}${stderr}`).not.toContain(canary);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ kind: 'lifecycle-repaired', cloudRequests: 0, logCanaryAbsent: true, observedVersion: 'workerd 2026-11-03' });
  expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/); expect(result.checks).toBeGreaterThanOrEqual(25);
}, 65000);
for (const ending of ['close', 'cancel', 'abort', 'error', 'cancel-error', 'unread-error'] as const) it(`activity lease releases exactly once: ${ending}`, async () => {
  const renew = vi.fn(); const activity = new ForwardActivity(renew); const abort = new AbortController(); let source!: ReadableStreamDefaultController<Uint8Array>; let cancels = 0;
  const response = await activity.forward(new Request('http://container.internal/internal/render', { signal: abort.signal }), async () => new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel() { cancels++; if (ending === 'cancel-error') throw new Error(canary); } }, { highWaterMark: 0 })));
  expect(activity.active).toBe(true); expect(renew).toHaveBeenCalledTimes(1);
  if (ending === 'cancel' || ending === 'cancel-error') await response.body!.cancel(new Error(canary));
  else if (ending === 'unread-error') { source.error(new Error(canary)); await Promise.resolve(); await Promise.resolve(); await expect(response.text()).rejects.not.toThrow(canary); }
  else {
    const result = response.text().then(value => ({ value }), error => ({ error: String(error) }));
    if (ending === 'abort') abort.abort(new Error(canary)); else if (ending === 'error') source.error(new Error(canary)); else source.close();
    expect(JSON.stringify(await result)).not.toContain(canary);
  }
  expect(activity.active).toBe(false); expect(renew).toHaveBeenCalledTimes(2);
  expect(cancels).toBe(ending === 'cancel' || ending === 'cancel-error' || ending === 'abort' ? 1 : 0);
  // A second settlement must not underflow the next lease or keep it awake.
  const next = await activity.forward(new Request('http://container.internal/internal/render'), async () => new Response('next'));
  expect(activity.active).toBe(true); await next.text(); expect(activity.active).toBe(false); expect(renew).toHaveBeenCalledTimes(4);
});
it('header rejection/initial abort release once, without raw errors or dispatch after abort', async () => {
  const renew = vi.fn(); const activity = new ForwardActivity(renew);
  await expect(activity.forward(new Request('http://container.internal/internal/render'), async () => { throw new Error(canary); })).rejects.toThrow('Runtime operation failed');
  expect(activity.active).toBe(false); expect(renew).toHaveBeenCalledTimes(2);
  const dispatch = vi.fn();
  await expect(activity.forward(new Request('http://container.internal/internal/render', { signal: AbortSignal.abort(new Error(canary)) }), dispatch)).rejects.not.toThrow(canary);
  expect(dispatch).not.toHaveBeenCalled(); expect(activity.active).toBe(false); expect(renew).toHaveBeenCalledTimes(4);
});
