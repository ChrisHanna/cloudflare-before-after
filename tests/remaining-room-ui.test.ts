import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import type { Browser, BrowserContext } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserTransport, type BrowserFrame, type BrowserFrameScope } from '../packages/demo-core/src/browser-transport.js';
import { WaitingRoomStateMachine, navigateWaitingRoomShopper } from '../packages/demo-core/src/waiting-room.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { JobSchema } from '../apps/command-center/src/api.js';
import { browserOptions, installedBrowser } from './browser-transport-fixtures.js';

let vite: ViteDevServer; let browser: Browser; let origin: string;
const contexts: BrowserContext[] = []; const transports: BrowserTransport[] = []; const stops: (() => void)[] = [];
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WaitingRoomPanel} from '/src/WaitingRoomPanel.tsx';
const root=createRoot(document.getElementById('root'));
async function render(){const state=await (await fetch('/fixture-state')).json();root.render(React.createElement(React.Fragment,null,React.createElement('button',{onClick:render},'Reload records'),React.createElement(WaitingRoomPanel,{...state,loadPreview:async(sessionId,signal)=>(await fetch('/fixture-frame?session='+sessionId,{signal})).json(),navigateShopper:async(scope,path,signal)=>{const response=await fetch('/fixture-nav',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scope,path}),signal});if(!response.ok)throw Error('Denied');await render();}})));} render();`;
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('Short owned scratch required');
  vite = await createServer({ root: resolve('apps/command-center'), cacheDir: resolve(process.env.KIROCREW_SCRATCH, 'room-ui-vite'), configFile: false, logLevel: 'error', plugins: [{ name: 'offline-room-entry', resolveId(id) { return id === '/room-entry.tsx' ? '\0room-entry.tsx' : null; }, load(id) { return id === '\0room-entry.tsx' ? entry : null; } }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Exact loopback origin required');
  origin = `http://127.0.0.1:${address.port}`; browser = await installedBrowser();
}, 30000);
afterEach(async () => { await Promise.all(contexts.splice(0).map(c => c.close())); await Promise.all(transports.splice(0).map(t => t.close())); stops.splice(0).forEach(stop => stop()); });
afterAll(async () => { await browser?.close(); await vite?.close(); });
async function mount() {
  const o = browserOptions(); stops.push(() => o.ledger.stop()); o.navigationPaths = ['/launch', '/shop']; o.framePublicText = ['Synthetic shopper', 'Synthetic queue'];
  o.previewSelectors = ['main']; const receipts: Receipt[] = []; let admitQ = false;
  o.fixture = async r => {
    const queue = r.sessionId === 'session-3' && !admitQ;
    if (!queue && r.requestId) receipts.push({ schemaVersion: 1, id: randomUUID(), runId: o.correlation.runId, requestId: r.requestId, scenarioId: 'waiting-room', targetRole: r.sessionId === 'session-1' ? 'before' : 'after', producerId: 'fixture-container', sequence: receipts.length + 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' });
    return { status: 200, contentType: 'text/html', headers: { 'set-cookie': '__cfwaitingroom=private-canary; Path=/; Secure; HttpOnly' }, body: `<main ${queue ? 'data-queue' : 'data-storefront'} style="width:600px;height:200px"><h1 data-demo-public>${queue ? 'Synthetic queue' : 'Synthetic shopper'}</h1><input value="private-canary"><div data-private>PRIVATE-CANARY</div></main>` };
  };
  const transport = (await BrowserTransport.create(o))!; transports.push(transport);
  const machine = new WaitingRoomStateMachine(o.correlation.runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) });
  const selectors = { queue: '[data-queue]', storefront: '[data-storefront]' };
  async function visit(id: string) {
    await transport.navigate(id, `https://${id === 'session-1' ? 'before' : 'after'}.example.test/launch`);
    const view = await transport.inspect(id, selectors); const linked = receipts.filter(r => r.requestId === view.requestId);
    machine.observe({ ...view, cookieContinuity: await transport.continuity(id), receipts: linked });
    if (!view.queue) await transport.confirmAdmission(id, selectors.storefront, linked);
  }
  for (const role of ['before', 'after', 'after'] as const) { const id = await transport.open(role); machine.register(id, role); await visit(id); }
  await navigateWaitingRoomShopper({ transport, machine, scope: transport.frameScope('session-2'), path: '/shop', selectors, signal: new AbortController().signal, receipts: async id => receipts.filter(r => r.requestId === id) });
  const frame = await transport.captureFrame(transport.frameScope('session-3'), 'main');
  const state = { runId: o.correlation.runId, result: machine.result(), historical: false, frameScopes: transport.sessions.map(s => transport.frameScope(s.sessionId)), navigationPaths: ['/shop'] };
  let nextPreview: BrowserFrame = frame; let previewCalls = 0; let navigations = 0; let external = 0;
  const context = await browser.newContext({ serviceWorkers: 'block' }); contexts.push(context); await context.routeWebSocket('**/*', socket => socket.close());
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external++; await route.abort(); return; }
    if (url.pathname === '/room-harness') { await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script type="module" src="/room-entry.tsx"></script>' }); return; }
    if (url.pathname === '/fixture-state') { state.result = machine.result(); await route.fulfill({ json: state }); return; }
    if (url.pathname === '/fixture-frame') { previewCalls++; await route.fulfill({ json: nextPreview }); return; }
    if (url.pathname === '/fixture-nav') {
      navigations++; const body = route.request().postDataJSON() as { scope: BrowserFrameScope; path: string };
      try { await navigateWaitingRoomShopper({ transport, machine, scope: body.scope, path: body.path, selectors, signal: new AbortController().signal, receipts: async id => receipts.filter(r => r.requestId === id) }); await route.fulfill({ json: { ok: true } }); }
      catch { await route.fulfill({ status: 403, json: { error: 'Denied' } }); }
      return;
    }
    await route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(3000); await page.goto(`${origin}/room-harness`);
  await page.getByRole('heading', { name: 'Waiting Room sessions', exact: true }).waitFor();
  return { page, state, o, frame, transport, machine, setPreview(value: BrowserFrame) { nextPreview = value; }, stats: () => ({ previewCalls, navigations, external }), async admit() { admitQ = true; await visit('session-3'); } };
}
describe('remaining room: actual local Chromium frame UI', () => {
  it('shows actual masked pixels, queued Q and shopping A; keyboard navigation uses the owned session', async () => {
    const f = await mount(); const { page } = f; const requests = f.o.ledger.snapshot.requestsUsed;
    const job = { id: randomUUID(), actualRunId: f.state.runId, waitingRoom: f.state.result, frameScopes: f.state.frameScopes, navigationPaths: ['/shop'], ownership: 'control', readOnly: false, historical: false, command: 'waiting-room', status: 'running', phase: 'protected', createdAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null, eventSequence: 1, truncated: false, reportId: null };
    expect(JobSchema.parse(job).frameScopes).toEqual(f.state.frameScopes);
    expect(JobSchema.safeParse({ ...job, actualRunId: randomUUID() }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, frameScopes: [...f.state.frameScopes, f.state.frameScopes[0]] }).success).toBe(false);
    expect(JobSchema.safeParse({ ...job, navigationPaths: ['//external.invalid/shop'] }).success).toBe(false);
    expect(await page.locator('[data-session-count="queued"]').innerText()).toBe('1');
    expect(await page.getByRole('article', { name: 'session-2 after session' }).innerText()).toContain('admitted');
    const inspect = page.getByRole('button', { name: 'Inspect session-3 preview' }); await inspect.focus(); await page.keyboard.press('Enter');
    const image = page.getByRole('img', { name: 'session-3 masked owned session' }); await image.waitFor();
    expect(await image.getAttribute('src')).toBe(f.frame.frame);
    expect(await image.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    expect(await page.locator('body').innerText()).not.toContain('private-canary');
    expect(await page.locator('body').innerText()).toContain('Preview alone never proves admission');
    expect(f.o.ledger.snapshot.requestsUsed).toBe(requests); expect(f.stats()).toEqual({ previewCalls: 1, navigations: 0, external: 0 });
    const shop = page.getByRole('button', { name: 'Shop session-2 /shop', exact: true }); await shop.focus(); await page.keyboard.press('Enter');
    await page.getByText('Owned shopper navigation complete. Await runner receipt evidence.').waitFor();
    expect(f.stats().navigations).toBe(1); expect(f.o.ledger.snapshot.requestsUsed).toBe(requests + 1);
    expect(await page.locator('img').count()).toBe(0);
    expect(f.machine.result().sessions.find(s => s.sessionId === 'session-2')!.transitions.filter(t => t.to === 'admitted')).toHaveLength(3);
    await f.admit(); await page.getByRole('button', { name: 'Reload records', exact: true }).click();
    const q = page.getByRole('article', { name: 'session-3 after session' }); await q.locator('summary').click();
    await page.waitForFunction(() => document.querySelector('[aria-label="session-3 after session"] strong')?.textContent === 'admitted');
    expect(await q.innerText()).toContain('queued → admitted'); expect(await q.innerText()).toContain('Queue position: Unavailable');
    expect(f.machine.result().liveReadiness).toBe(false); expect(f.stats().external).toBe(0);
  }, 20000);
  it('rejects foreign and stale frames, expires pixels, and blocks historical navigation', async () => {
    const f = await mount(); const { page } = f;
    f.setPreview({ ...f.frame, runId: randomUUID() });
    await page.getByRole('button', { name: 'Inspect session-3 preview' }).click();
    await page.getByText('Preview unavailable. Inspect the runner-owned browser window.').waitFor(); expect(await page.locator('img').count()).toBe(0);
    f.setPreview({ ...f.frame, observedAt: new Date(Date.now() - 6000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() });
    await page.getByRole('button', { name: 'Inspect session-3 preview' }).click();
    await page.getByText('Preview unavailable. Inspect the runner-owned browser window.').waitFor(); expect(await page.locator('img').count()).toBe(0);
    f.setPreview({ ...f.frame, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString() });
    await page.getByRole('button', { name: 'Inspect session-3 preview' }).click(); await page.getByRole('img').waitFor();
    await page.getByText('Preview expired. Inspect the owned session again.').waitFor(); expect(await page.locator('img').count()).toBe(0);
    f.state.historical = true; await page.getByRole('button', { name: 'Reload records' }).click();
    await page.getByText('SAVED EVIDENCE — historical session records, not live').waitFor();
    expect(await page.getByRole('button', { name: 'Shop session-2 /shop' }).isDisabled()).toBe(true);
    expect(f.stats().navigations).toBe(0); expect(f.stats().external).toBe(0);
  }, 20000);
});
