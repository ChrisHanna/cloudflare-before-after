import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { controlFixture } from './fixtures/control.js';
import type { DemoCliDependencies } from '../packages/demo-core/src/demo-cli.js';
const fixtures: ReturnType<typeof controlFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
function fixture(options: Parameters<typeof controlFixture>[0] = {}) { const f = controlFixture(options); fixtures.push(f); return f; }
describe('control-api', () => {
  it('requires one-time authenticated bootstrap, exact host/origin and CSRF before controls', async () => {
    const f = fixture(); expect((await f.request('/api/catalog')).status).toBe(401);
    const auth = await f.login();
    expect(auth.response.headers.get('set-cookie')).toContain('HttpOnly'); expect(auth.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect((await f.request('/api/bootstrap/redeem', 'POST', { token: auth.bootstrap })).status).toBe(401);
    expect((await f.request('/api/catalog')).status).toBe(200);
    expect((await f.request('/api/catalog', 'GET', undefined, { host: 'evil.example' })).status).toBe(403);
    expect((await f.request('/api/catalog', 'GET', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await f.request('/api/catalog', 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await f.request('/api/plans', 'POST', { command: 'waf-custom' }, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await f.request('/api/plans', 'POST', { command: 'waf-custom' }, { origin: 'https://evil.example' })).status).toBe(403);
    expect(f.calls).toEqual([]);
    const response = await f.request('/api/catalog'); const data = await response.text();
    for (const secret of [auth.bootstrap, auth.cookie.split('=')[1]!, ...Object.values(f.credentials)]) expect(data).not.toContain(secret);
    expect(response.headers.has('access-control-allow-origin')).toBe(false);
  });
  it('supports matching-code terminal approval bound to the browser pending HttpOnly cookie', async () => {
    const f = fixture(); const requested = await f.request('/api/bootstrap/request', 'POST', {}); const body = await requested.json() as any;
    expect(body.pending).toBe(true); expect(body.code).toMatch(/^[A-F0-9]{8}$/);
    f.control.approvePending(body.code);
    expect((await f.request('/api/bootstrap/status')).status).toBe(401);
    const pending = requested.headers.getSetCookie().find(c => c.startsWith(`${f.control.pendingCookieName}=`))!.split(';')[0]!;
    const approved = await f.request('/api/bootstrap/status', 'GET', undefined, { cookie: pending });
    expect(approved.status).toBe(200); expect((await approved.json() as any).authenticated).toBe(true);
    expect((await f.request('/api/bootstrap/status', 'GET', undefined, { cookie: pending })).status).toBe(401);
    expect(f.calls).toEqual([]);
  });
  it('expires presenter sessions and rejects arbitrary command/path/config fields', async () => {
    let now = Date.now(); const f = fixture({ now: () => now }); await f.login();
    for (const body of [{ command: 'lab apply' }, { command: 'waf-custom', url: 'https://evil.example' }, { command: 'waf-custom', config: '/outside/file' }, { command: 'waf-custom', output: '/outside/report' }, { command: 'waf-custom', limits: { requests: 101 } }]) expect((await f.request('/api/plans', 'POST', body)).status).toBe(400);
    now += 900001; expect((await f.request('/api/catalog')).status).toBe(401); expect(f.calls).toEqual([]);
  });
  it('plans locally without credentials/network and runs the shared bounded CLI through authenticated commands', async () => {
    const f = fixture(); await f.login();
    const plan = await f.request('/api/plans', 'POST', { command: 'waf-custom' }); expect(plan.status).toBe(200); expect((await plan.json() as any).plan).toMatchObject({ kind: 'planned', networkCalls: 0 }); expect(f.calls).toEqual([]);
    const key = randomUUID(); const started = await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: key, liveOptIn: true }); expect(started.status).toBe(202); const job = (await started.json() as any).run;
    const finished = await f.wait(job.id); expect(finished.status).toBe('finished'); expect(finished.exitCode).toBe(0); expect(finished.result.report.result.outcome).toBe('verified'); expect(finished.result.report.mode).toBe('fixture');
    expect(finished.result).not.toHaveProperty('reportDirectory'); expect(f.calls).toHaveLength(22);
    const again = await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: key, liveOptIn: true }); expect((await again.json() as any).run.id).toBe(job.id); expect(f.calls).toHaveLength(22);
    const altered = await f.request('/api/runs', 'POST', { command: 'doctor', idempotencyKey: key, liveOptIn: true }); expect(altered.status).toBe(409);
    const id = finished.result.report.result.runId; const report = await f.request(`/api/reports/${id}`); expect(report.status).toBe(200); expect((await report.json() as any).artifacts.length).toBeGreaterThan(0);
    const html = await f.request(`/api/reports/${id}/html`); expect(html.headers.get('content-security-policy')).toContain('sandbox');
    expect((await f.request('/api/reports/not-a-valid-id')).status).toBe(404);
    expect((await f.request(`/api/runs/${randomUUID()}/stop`, 'POST', {})).status).toBe(404);
    expect((await f.request(`/api/runs/${job.id}/advance`, 'POST', {})).status).toBe(409);
  });
  it('enforces explicit opt-in, single ownership, idempotency and owned stop without exposing a foreign run', async () => {
    const execute = vi.fn(async (_args: readonly string[], deps: DemoCliDependencies) => {
      deps.onStarted?.({ runId: randomUUID(), stop: () => {} });
      await new Promise<void>(resolve => deps.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: 130, output: JSON.stringify({ kind: 'result', outcome: 'inconclusive' }) };
    });
    const f = fixture({ execute }); await f.login();
    expect((await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: randomUUID(), liveOptIn: false })).status).toBe(400);
    const key = randomUUID(); const first = await (await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: key, liveOptIn: true })).json() as any;
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect((await f.request('/api/runs', 'POST', { command: 'doctor', idempotencyKey: randomUUID(), liveOptIn: true })).status).toBe(409);
    expect((await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: key, liveOptIn: true })).status).toBe(202); expect(execute).toHaveBeenCalledOnce();
    expect((await f.request(`/api/runs/${first.run.id}/stop`, 'POST', {})).status).toBe(200);
    expect((await f.wait(first.run.id)).status).toBe('cancelled'); expect(f.calls).toEqual([]);
  });
  it('keeps readiness reads passive and marks cached checks without remote refresh', async () => {
    const f = fixture(); await f.login();
    expect((await (await f.request('/api/readiness')).json() as any).freshness).toBe('unavailable'); expect(f.calls).toEqual([]);
    const started = await (await f.request('/api/runs', 'POST', { command: 'doctor', scope: 'core-waf', idempotencyKey: randomUUID(), liveOptIn: true })).json() as any;
    await f.wait(started.run.id); const count = f.calls.length;
    const readiness = await (await f.request('/api/readiness')).json() as any;
    expect(readiness.report.scope).toBe('core-waf'); expect(readiness.automaticallyRefreshed).toBe(false); expect(readiness.report.claims.mitigationVerified).toBe(false); expect(f.calls).toHaveLength(count);
  });
});
