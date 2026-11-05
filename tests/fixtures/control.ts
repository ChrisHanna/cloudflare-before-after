import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createControlApp, type ControlAppOptions } from '../../apps/control-server/src/app.js';
import { demoLabFixture } from './demo-lab.js';
export function controlFixture(options: Partial<ControlAppOptions> = {}) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'control-')); const lab = demoLabFixture(root);
  const origin = 'http://127.0.0.1:8787';
  const control = createControlApp({ projectRoot: root, origin, demo: { mode: 'fixture', dispatch: lab.dispatch, loadConfig: () => lab.config, credentials: () => lab.credentials }, ...options });
  let cookie = ''; let csrf = '';
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => control.app.request(`${origin}${path}`, { method, headers: { host: new URL(origin).host, origin, ...(cookie ? { cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json', 'x-csrf-token': csrf } : {}), ...extra }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async () => {
    const bootstrap = control.issueBootstrap(); const response = await request('/api/bootstrap/redeem', 'POST', { token: bootstrap });
    if (response.status !== 200) throw new Error('Fixture login failed');
    cookie = response.headers.getSetCookie().find(c => c.startsWith(`${control.cookieName}=`))!.split(';')[0]!;
    const session = await request('/api/session'); csrf = (await session.json() as { csrfToken: string }).csrfToken;
    return { bootstrap, cookie, csrf, response };
  };
  const wait = async (id: string) => {
    // Real Chromium startup can exceed one second under suite concurrency.
    // This bounds only test observation, never production run/traffic limits.
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) { const value = await (await request(`/api/runs/${id}`)).json() as any; if (value.run?.status !== 'running') return value.run; await new Promise(resolve => setTimeout(resolve, 5)); }
    throw new Error('Fixture job did not finish');
  };
  return { root, ...lab, control, origin, request, login, wait, async cleanup() { await control.close(); rmSync(root, { recursive: true, force: true }); } };
}
