import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Browser } from '@playwright/test';
import { BrowserTransport, type BrowserTransportOptions } from '../packages/demo-core/src/browser-transport.js';
import { WaitingRoomStateMachine, navigateWaitingRoomShopper, runWaitingRoom } from '../packages/demo-core/src/waiting-room.js';
import { BrowserFrameSchema, validateBrowserFrame } from '../apps/command-center/src/workshop-views.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { browserOptions, installedBrowser, waitingRoomFixture } from './browser-transport-fixtures.js';

const transports: BrowserTransport[] = []; const optionsUsed: BrowserTransportOptions[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(transports.splice(0).map(t => t.close())); optionsUsed.splice(0).forEach(o => o.ledger.stop()); });
async function create(options = browserOptions()) {
  optionsUsed.push(options); const transport = (await BrowserTransport.create(options))!; transports.push(transport); return transport;
}
function page(privateText: string, publicText = 'Synthetic launch shirt') {
  return `<style>input,[data-private] {visibility:visible!important} [data-private]::before {content:'${privateText}'!important}</style><main style="width:600px;height:300px"><h1 data-demo-public>${publicText}</h1><p data-private style="visibility:visible!important">${privateText}</p><input value="${privateText}"><textarea>${privateText}</textarea><div contenteditable>${privateText}</div><canvas></canvas><script>window.privateText='${privateText}'</script></main>`;
}
function receipt(options: BrowserTransportOptions, requestId: string, role: 'before' | 'after' = 'after'): Receipt {
  return { schemaVersion: 1, id: randomUUID(), runId: options.correlation.runId, requestId, scenarioId: 'waiting-room', targetRole: role, producerId: 'fixture-container', sequence: 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' };
}
const selectors = { queue: '[data-queue]', storefront: '[data-storefront]' };
describe('remaining room: actual offline Chromium pixels and owned contexts', () => {
  it('masks private pixels before capture; binds scope, expiry, size and rate without probes', async () => {
    const o = browserOptions(); o.navigationPaths = ['/launch']; o.framePublicText = ['Synthetic launch shirt', 'Synthetic shopper'];
    o.fixture = async r => ({ status: 200, contentType: 'text/html', headers: { 'set-cookie': 'private=cookie-canary; Path=/; Secure; HttpOnly', 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }, body: page(r.sessionId === 'session-1' ? 'PRIVATE-AAAA' : 'PRIVATE-BBBB', r.sessionId === 'session-3' ? 'Synthetic shopper' : 'Synthetic launch shirt') });
    const t = await create(o); const a = await t.open('after'); const b = await t.open('after'); const c = await t.open('after');
    for (const id of [a, b, c]) await t.navigate(id, 'https://after.example.test/launch');
    const used = o.ledger.snapshot.requestsUsed;
    const frameA = await t.captureFrame(t.frameScope(a), 'main');
    await expect(t.captureFrame(t.frameScope(a), 'main')).rejects.toThrow('rate limit');
    const frameB = await t.captureFrame(t.frameScope(b), 'main');
    const frameC = await t.captureFrame(t.frameScope(c), 'main');
    expect(frameA.frame).toBe(frameB.frame); // Changed private text cannot change delivered pixels.
    expect(frameA.frame).not.toBe(frameC.frame); // Actual public page text is visible, not a blank/synthetic image.
    expect(BrowserFrameSchema.parse(frameA)).toEqual(frameA);
    expect(validateBrowserFrame(frameA, t.frameScope(a), 'fixture')).toEqual(frameA);
    expect(JSON.stringify(frameA)).not.toMatch(/PRIVATE|cookie-canary|<main|<script/);
    expect(Buffer.from(frameA.frame.slice(22), 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(frameA.frame.length).toBeLessThanOrEqual(262166);
    expect(t.latestFrame(t.frameScope(a))).toEqual(frameA);
    for (const scope of [{ ...t.frameScope(a), ownerId: randomUUID() }, { ...t.frameScope(a), runId: randomUUID() }, { ...t.frameScope(a), releaseDigest: 'b'.repeat(64) }]) {
      expect(() => t.latestFrame(scope)).toThrow('Foreign');
      expect(() => validateBrowserFrame(frameA, scope, 'fixture')).toThrow('Foreign');
    }
    expect(() => validateBrowserFrame(frameA, t.frameScope(b), 'fixture')).toThrow('Foreign');
    expect(() => validateBrowserFrame(frameA, t.frameScope(a), 'fixture', Date.parse(frameA.expiresAt))).toThrow('Stale');
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    expect(() => t.latestFrame(t.frameScope(a))).toThrow('Stale'); vi.restoreAllMocks();
    expect(o.ledger.snapshot.requestsUsed).toBe(used);
    await t.close(); expect(() => t.latestFrame(t.frameScope(a))).toThrow();
  });
  it('fails closed on unsafe public text, private ancestors and absent capture contracts', async () => {
    const o = browserOptions(); o.framePublicText = ['Synthetic launch shirt'];
    o.fixture = async r => ({ status: 200, contentType: 'text/html', body: r.sessionId === 'session-1' ? page('secret', 'token=secret') : '<main><div data-private><h1 data-demo-public>Synthetic launch shirt</h1></div></main>' });
    const t = await create(o); const a = await t.open('after'); const b = await t.open('after');
    await t.navigate(a, 'https://after.example.test/launch'); await t.navigate(b, 'https://after.example.test/launch');
    await expect(t.captureFrame(t.frameScope(a), 'main')).rejects.toThrow('privacy');
    await expect(t.captureFrame(t.frameScope(b), 'main')).rejects.toThrow('privacy');
    await expect(t.captureFrame(t.frameScope(a), 'body')).rejects.toThrow('Qualified');
    expect(() => t.latestFrame(t.frameScope(a))).toThrow('absent');
    expect(o.ledger.snapshot.requestsUsed).toBe(2);
  });
  it('navigates the admitted shopper in the same context and jar; denies routes and redirects', async () => {
    const o = browserOptions(); o.navigationPaths = ['/launch', '/shop', '/redirect']; o.followRedirects = true;
    let actualBrowser!: Browser;
    o.launch = async () => { actualBrowser = await installedBrowser(); return actualBrowser; };
    const receipts: Receipt[] = []; const calls: string[] = [];
    o.fixture = async r => {
      calls.push(r.url);
      if (r.url.endsWith('/redirect')) return { status: 302, contentType: 'text/html', headers: { location: '/private' }, body: '' };
      if (r.requestId) receipts.push(receipt(o, r.requestId));
      return { status: 200, contentType: 'text/html', headers: r.url.endsWith('/launch') ? { 'set-cookie': '__cfwaitingroom=private-jar; Path=/; Secure; HttpOnly' } : {}, body: '<main data-storefront>Shopper</main><img src="https://external.invalid/blocked">' };
    };
    const t = await create(o); const id = await t.open('after'); const scope = t.frameScope(id);
    await expect(t.navigateAdmitted(scope, '/shop')).rejects.toThrow('Admitted');
    await t.navigate(id, 'https://after.example.test/launch'); const context = actualBrowser.contexts()[0]!; const ownedPage = context.pages()[0]!;
    const firstCookies = await context.cookies(); const first = await t.inspect(id, selectors);
    await t.confirmAdmission(id, selectors.storefront, receipts.filter(r => r.requestId === first.requestId));
    for (const path of ['/private', '/shop?probe=1', '//external.invalid/shop', '/shop/../private']) await expect(t.navigateAdmitted(scope, path)).rejects.toThrow('allowlisted');
    const machine = new WaitingRoomStateMachine(o.correlation.runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) });
    machine.register(id, 'after'); machine.observe({ ...first, sessionId: id, cookieContinuity: true, receipts });
    const result = await navigateWaitingRoomShopper({ transport: t, machine, scope, path: '/shop', selectors, signal: new AbortController().signal, receipts: async requestId => receipts.filter(r => r.requestId === requestId) });
    expect(result.sessions[0]!.state).toBe('admitted'); expect(result.sessions[0]!.transitions.filter(v => v.to === 'admitted')).toHaveLength(2);
    expect(actualBrowser.contexts()).toHaveLength(1); expect(actualBrowser.contexts()[0]).toBe(context); expect(context.pages()[0]).toBe(ownedPage);
    expect((await context.cookies()).every(c => firstCookies.some(firstCookie => firstCookie.name === c.name && firstCookie.value === c.value))).toBe(true);
    expect(await t.continuity(id)).toBe(true);
    await expect(t.navigateAdmitted(scope, '/redirect')).rejects.toThrow('navigation failed');
    expect(calls).toEqual(['https://after.example.test/launch', 'https://after.example.test/shop', 'https://after.example.test/redirect']);
    expect(o.ledger.snapshot.requestsUsed).toBe(3);
    expect(JSON.stringify(result)).not.toContain('private-jar');
  });
  it('keeps CSP and frame denial headers; blocks browser-driven route escapes', async () => {
    const o = browserOptions(); o.navigationPaths = ['/launch'];
    let actualBrowser!: Browser; o.launch = async () => { actualBrowser = await installedBrowser(); return actualBrowser; };
    const calls: string[] = [];
    o.fixture = async r => { calls.push(r.url); return { status: 200, contentType: 'text/html', headers: { 'content-security-policy': "frame-ancestors 'none'", 'x-frame-options': 'DENY' }, body: '<main data-storefront>Shop</main>' }; };
    const t = await create(o); const id = await t.open('after');
    const responsePromise = new Promise<Record<string, string>>(resolve => { actualBrowser.contexts()[0]!.pages()[0]!.once('response', r => { void r.allHeaders().then(resolve); }); });
    await t.navigate(id, 'https://after.example.test/launch');
    const headers = await responsePromise;
    expect(headers['content-security-policy']).toBe("frame-ancestors 'none'"); expect(headers['x-frame-options']).toBe('DENY');
    const p = actualBrowser.contexts()[0]!.pages()[0]!;
    const denied = p.waitForEvent('requestfailed', { timeout: 2000 });
    await p.evaluate(() => { location.href = '/private'; });
    await denied;
    expect(calls).toEqual(['https://after.example.test/launch']); expect(o.ledger.snapshot.requestsUsed).toBe(1);
  }, 10000);
  it('does not replace a failed frame with a text fallback or a readiness claim', async () => {
    const f = waitingRoomFixture(); const t = await create(f.config); const onFrame = vi.fn(); const onPreview = vi.fn();
    const machine = new WaitingRoomStateMachine(f.config.correlation.runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) });
    const result = await runWaitingRoom({ transport: t, ledger: f.config.ledger, machine, beforeOrigin: 'https://before.example.test', afterOrigin: 'https://after.example.test', selectors, plan: { path: '/launch', productId: 'shirt', expectedTransitionMs: 20, perNavigationRequests: 1, refreshes: 1, telemetryRequests: 4, interview: false }, receipts: async id => f.receipts.filter(r => r.requestId === id), onFrame, onPreview });
    expect(onFrame).not.toHaveBeenCalled(); expect(onPreview).not.toHaveBeenCalled();
    expect(result.fixtureAssertionsPassed).toBe(true); expect(result.liveReadiness).toBe(false); expect(f.config.ledger.snapshot.requestsUsed).toBe(5);
  });
  it('uses the documented JSON queue signal with injected offline provider I/O, never selector assertions', async () => {
    const o = browserOptions(); o.mode = 'live'; o.headed = false; o.config.liveOptIn = true;
    o.observedOwnedResources = new Set(o.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
    let json = false;
    const io = vi.fn(async () => new Response(json ? JSON.stringify({ cfWaitingRoom: { inWaitingRoom: true } }) : '<main data-queue>Waiting</main>', { status: 200, headers: { 'content-type': json ? 'application/json' : 'text/html', 'set-cookie': '__cfwaitingroom=private-queue; Path=/; Secure; HttpOnly' } }));
    vi.stubGlobal('fetch', io);
    const t = await create(o); const id = await t.open('after'); await t.navigate(id, 'https://after.example.test/launch');
    const absent = await t.inspect(id, selectors);
    expect(absent.queue).toBe(false); expect(absent.queueDetection.source).toBe('unqualified');
    const policy = { mode: 'live' as const, state: 'observed' as const, matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) };
    const forged = new WaitingRoomStateMachine(o.correlation.runId, 'live', policy); forged.register(id, 'after');
    forged.observe({ ...absent, queue: true, queueCookiePresent: true, sessionId: id, cookieContinuity: true, receipts: [] });
    expect(forged.result().sessions[0]!.state).toBe('unknown'); expect(forged.result().missingProof.join(' ')).toContain('Unqualified queue');
    json = true; await t.navigate(id, 'https://after.example.test/launch'); const observed = await t.inspect(id, selectors);
    expect(observed.queueDetection.source).toBe('cloudflare-json-response');
    const machine = new WaitingRoomStateMachine(o.correlation.runId, 'live', policy); machine.register(id, 'after', t.frameScope(id));
    const other = await t.open('after'); machine.register(other, 'after', t.frameScope(other));
    machine.observe({ ...observed, queueObservation: observed, sessionId: 'session-2', cookieContinuity: true, receipts: [] });
    expect(machine.result().sessions[1]!.state).toBe('unknown');
    machine.observe({ ...observed, queueObservation: observed, sessionId: id, queue: false, storefront: true, cookieContinuity: true, receipts: [] });
    expect(machine.result().sessions[0]!.state).toBe('unknown');
    const foreign = new WaitingRoomStateMachine(o.correlation.runId, 'live', policy); foreign.register(id, 'after', { ...t.frameScope(id), ownerId: randomUUID() });
    foreign.observe({ ...observed, queueObservation: observed, cookieContinuity: true, receipts: [] });
    expect(foreign.result().sessions[0]!.state).toBe('unknown');
    machine.observe({ ...observed, queueObservation: observed, sessionId: id, cookieContinuity: true, receipts: [] });
    expect(machine.result().sessions[0]!.state).toBe('queued'); expect(machine.result().liveReadiness).toBe(false);
    expect(io).toHaveBeenCalledTimes(2); expect(o.ledger.snapshot.requestsUsed).toBe(2);
  });
});
