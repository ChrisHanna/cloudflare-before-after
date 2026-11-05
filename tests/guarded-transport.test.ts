import { describe, expect, it, vi } from 'vitest';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { TestClock } from './fixtures/clock.js';
import { labConfig } from './fixtures/lab.js';
function client(dispatch: (url: string, init: RequestInit) => Promise<Response>, overrides = {}) {
  const config = labConfig(); config.liveOptIn = true;
  const clock = new TestClock(); const ledger = new BudgetLedger({ clock, limits: overrides });
  const c = new GuardedClient(config, ledger, { dispatch, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)) });
  return { c, ledger, clock };
}
const url = 'https://before.example.test/catalog';
describe('guarded-transport', () => {
  it('counts exact dispatches and returns only bounded sanitized observations', async () => {
    const dispatch = vi.fn(async (_url: string, _init: RequestInit) => new Response('canary-private-value', { headers: { 'cf-ray': 'abcdef0123456789-IAD', 'set-cookie': 'secret' } }));
    const { c, ledger } = client(dispatch);
    const r = await c.request({ url, kind: 'before', headers: { 'cf-access-client-secret': 'canary-private-value' } });
    expect(r).toMatchObject({ status: 200, excerpt: '[REDACTED]', rayId: 'abcdef0123456789-IAD' });
    expect(r).not.toHaveProperty('headers');
    expect(ledger.snapshot.requestsUsed).toBe(1);
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' }); ledger.stop();
  });
  it('rejects unsafe role/headers/methods before dispatch', async () => {
    const dispatch = vi.fn(async () => new Response('ok')); const { c, ledger } = client(dispatch);
    for (const plan of [
      { url: 'https://after.example.test/', kind: 'before' as const },
      { url, kind: 'before' as const, headers: { Host: 'evil' } },
      { url: 'https://api.cloudflare.com/client/v4/zones', kind: 'cloudflare' as const, method: 'POST' as const },
      { url, kind: 'before' as const, retries: 4 },
    ]) await expect(c.request(plan)).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled(); ledger.stop();
  });
  it('counts redirects only after explicit authorization and refuses escape', async () => {
    let n = 0;
    const { c, ledger } = client(async () => ++n === 1 ? new Response(null, { status: 307, headers: { location: '/next' } }) : new Response('ok'));
    await expect(c.request({ url, kind: 'before', followRedirects: true })).resolves.toMatchObject({ status: 200 });
    expect(ledger.snapshot.requestsUsed).toBe(2); ledger.stop();
    for (const location of ['/next', 'https://evil.test']) {
      const dispatch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
      const { c, ledger } = client(dispatch);
      await expect(c.request({ url, kind: 'before' })).rejects.toThrow();
      expect(dispatch).toHaveBeenCalledTimes(1); ledger.stop();
    }
  });
  it('charges retries/backoff and telemetry against the same allowance', async () => {
    let n = 0; const dispatch = vi.fn(async () => ++n === 1 ? new Response(null, { status: 429, headers: { 'retry-after': '0' } }) : new Response('ok'));
    const { c, ledger, clock } = client(dispatch, { requests: 4, cleanupRequests: 1 });
    const pending = c.request({ url, kind: 'before', retries: 1 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1)); clock.advance(0);
    await pending;
    await c.request({ url: 'https://receipts.example.test/receipts', kind: 'telemetry' });
    await expect(c.request({ url, kind: 'before' })).rejects.toThrow();
    expect(dispatch).toHaveBeenCalledTimes(3); expect(ledger.snapshot.requestsUsed).toBe(3); ledger.stop();
  });
  it('aborts in-flight traffic at the work deadline and cancels oversized bodies', async () => {
    const { c, ledger, clock } = client(async (_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private-error-secret')), { once: true })));
    const promise = c.request({ url, kind: 'before' });
    const rejected = expect(promise).rejects.toThrow('Guarded request failed');
    await Promise.resolve(); clock.advance(59000); await rejected;
    expect(ledger.snapshot.activeRequests).toBe(0); ledger.stop();
    const next = client(async () => new Response('x'.repeat(65537)));
    await expect(next.c.request({ url, kind: 'before' })).rejects.toThrow(); next.ledger.stop();
  });
});
