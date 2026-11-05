import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { TEST_SECRET, TEST_SITEKEY, TEST_TOKEN } from '../apps/storefront-worker/src/turnstile.js';

const siteverify = (body: object, status = 200) => vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
function fixture(role: 'before' | 'after', options: { dispatch?: ReturnType<typeof siteverify>; configured?: boolean } = {}) {
  const origin = `https://${role}.example.test`; const secret = 'register-page-synthetic-secret-value'; const dispatch = options.dispatch ?? siteverify({ success: true, hostname: 'example.com', metadata: { result_with_testing_key: true } });
  const env = { role, origin, releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret: secret, internalSecret: secret, labId: 'synthetic-lab',
    image: { id: 'synthetic-shirt', role, labId: 'synthetic-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'b'.repeat(64) },
    db: { prepare() { throw new Error('PRIVATE_D1_CANARY'); } }, bucket: {}, containers: {},
    ...(options.configured === false ? {} : { turnstile: { config: { mode: role === 'before' ? 'disabled' : 'test', sitekey: role === 'before' ? null : TEST_SITEKEY, hostname: `${role}.example.test`, action: 'register' }, ...(role === 'after' ? { secret: TEST_SECRET } : {}), dispatch } }),
  } as unknown as StorefrontBindings;
  const app = createStorefrontWorker(env);
  return { origin, dispatch, get: (path: string) => app.request(`${origin}${path}`), submit: (token?: string) => app.request(`${origin}/register/check`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(token === undefined ? {} : { 'cf-turnstile-response': token }) }), app };
}
describe('public registration check', () => {
  it('shows Before as a plain baseline form with no widget', async () => {
    const f = fixture('before'); const response = await f.get('/register'); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('Before baseline only — no verification'); expect(html).toContain('<form method="post" action="/register/check">');
    expect(html).toContain('href="/assets/register.css"'); expect(html).not.toContain('cf-turnstile'); expect(html).not.toContain('challenges.cloudflare.com');
    expect(response.headers.get('content-security-policy')).not.toContain('script-src'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('shows After with the documented test widget and no secret', async () => {
    const f = fixture('after'); const response = await f.get('/register'); const html = await response.text();
    expect(html).toContain('TEST MODE — not production enforcement'); expect(html).toContain(`data-sitekey="${TEST_SITEKEY}"`); expect(html).toContain('https://challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).not.toContain(TEST_SECRET); expect(html).not.toMatch(/\sstyle=|<style|<script(?![^>]*challenges\.cloudflare\.com)/);
    const csp = response.headers.get('content-security-policy')!; expect(csp).toContain('script-src https://challenges.cloudflare.com'); expect(csp).toContain("form-action 'self'"); expect(csp).toContain("style-src 'self'");
  });
  it('serves a self-contained stylesheet', async () => {
    const response = await fixture('after').get('/assets/register.css'); const css = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get('content-type')).toContain('text/css'); expect(css).toContain('.role-badge'); expect(css).not.toMatch(/@import|url\(/);
  });
  it('accepts every Before submission without calling Siteverify or storage', async () => {
    const f = fixture('before'); const response = await f.submit(); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('Accepted'); expect(html).toContain('no application-side verification'); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects a missing After token before any remote call and says it is not an edge block', async () => {
    const f = fixture('after'); const response = await f.submit(); const html = await response.text();
    expect(response.status).toBe(403); expect(html).toContain('Rejected'); expect(html).toContain('not by a Cloudflare edge rule'); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('accepts the documented test token after one server-side Siteverify call and never echoes it', async () => {
    const f = fixture('after'); const response = await f.submit(TEST_TOKEN); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('verified on the server with Siteverify'); expect(f.dispatch).toHaveBeenCalledTimes(1);
    const init = f.dispatch.mock.calls[0]![1]!; const body = String(init.body);
    expect(f.dispatch.mock.calls[0]![0]).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify'); expect(init.redirect).toBe('manual');
    expect(body).toContain(`secret=${TEST_SECRET}`); expect(body).toContain('response=XXXX.DUMMY.TOKEN.XXXX');
    for (const value of [TEST_TOKEN, TEST_SECRET, 'PRIVATE_D1_CANARY']) expect(html).not.toContain(value);
  });
  it('accepts a test-mode response only when Cloudflare flags it as a testing-key result', async () => {
    const f = fixture('after', { dispatch: siteverify({ success: true, hostname: 'dummy-key-pass' }) }); const response = await f.submit(TEST_TOKEN);
    expect(response.status).toBe(403); expect(await response.text()).toContain('did not verify for this hostname');
  });
  it('rejects a token Siteverify does not accept and reports an unreachable verifier as unavailable', async () => {
    const rejected = fixture('after', { dispatch: siteverify({ success: false, 'error-codes': ['invalid-input-response'] }) }); const a = await rejected.submit('not-a-valid-token');
    expect(a.status).toBe(403); expect(await a.text()).toContain('did not verify for this hostname'); expect(rejected.dispatch).toHaveBeenCalledTimes(1);
    const down = fixture('after', { dispatch: siteverify({}, 500) }); const b = await down.submit(TEST_TOKEN);
    expect(b.status).toBe(503); expect(await b.text()).toContain('no decision was made');
  });
  it('rejects oversized tokens and wrong content types without a remote call', async () => {
    const f = fixture('after'); expect((await f.submit('x'.repeat(3000))).status).toBe(403);
    const json = await f.app.request(`${f.origin}/register/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'cf-turnstile-response': TEST_TOKEN }) });
    expect(json.status).toBe(403); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('explains when Turnstile is not configured instead of returning raw JSON', async () => {
    const f = fixture('after', { configured: false }); const page = await f.get('/register'); const check = await f.submit(TEST_TOKEN);
    expect(page.status).toBe(503); expect(page.headers.get('content-type')).toContain('text/html'); expect(await page.text()).toContain('Not enabled in this deployment'); expect(check.status).toBe(503);
  });
  it('leaves the authorized runner registration path closed to anonymous callers', async () => {
    const f = fixture('after'); const response = await f.app.request(`${f.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(401);
  });
});
