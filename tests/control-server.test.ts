import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { startControlServer } from '../apps/control-server/src/server.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
describe('control-server physical loopback listener', () => {
  it('binds only127.0.0.1 and carries secure local cookies without logging bearer secrets', async () => {
    const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
    const root = mkdtempSync(join(scratch, 'control-http-')); const f = demoLabFixture(root);
    const staticRoot = join(root, 'apps/command-center/dist'); mkdirSync(staticRoot, { recursive: true }); writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><p>Fixture local control page</p>');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = await startControlServer({ projectRoot: root, port: 0, demo: { mode: 'fixture', dispatch: f.dispatch, loadConfig: () => f.config, credentials: () => f.credentials } });
    cleanups.push(async () => { await server.close(); rmSync(root, { recursive: true, force: true }); log.mockRestore(); });
    expect(server.address.host).toBe('127.0.0.1'); expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await fetch(`${server.origin}/api/catalog`)).status).toBe(401);
    const bootstrap = server.control.issueBootstrap();
    const redeemed = await fetch(`${server.origin}/api/bootstrap/redeem`, { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: bootstrap }) });
    expect(redeemed.status).toBe(200); const cookie = redeemed.headers.getSetCookie().find(c => c.startsWith(`${server.control.cookieName}=`))!.split(';')[0]!;
    const session = await (await fetch(`${server.origin}/api/session`, { headers: { cookie, origin: server.origin } })).json() as any;
    const plan = await fetch(`${server.origin}/api/plans`, { method: 'POST', headers: { cookie, origin: server.origin, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ command: 'waf-custom' }) });
    expect((await plan.json() as any).plan.networkCalls).toBe(0); expect(f.calls).toEqual([]);
    const page = await fetch(`${server.origin}/`); expect(page.status).toBe(200); expect(page.headers.get('content-security-policy')).toContain('frame-src'); expect(page.headers.get('content-security-policy')).toContain('https://before.example.test');
    expect((await fetch(`${server.origin}/`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const badHost = await new Promise<number | undefined>((done, reject) => {
      const request = httpRequest(`${server.origin}/api/catalog`, { headers: { cookie, Host: 'evil.example' } }, response => { response.resume(); done(response.statusCode); });
      request.once('error', reject); request.end();
    });
    expect(badHost).toBe(403);
    expect(log).not.toHaveBeenCalled();
  });
});
