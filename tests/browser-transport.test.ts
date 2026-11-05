import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTransport } from '../packages/demo-core/src/browser-transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { Redactor } from '../packages/contracts/src/redaction.js';
import { browserOptions } from './browser-transport-fixtures.js';
import { TestClock } from './fixtures/clock.js';

const owned: BrowserTransport[] = []; const ledgers: BudgetLedger[] = [];
afterEach(async () => { await Promise.all(owned.splice(0).map(t => t.close())); ledgers.splice(0).forEach(l => l.stop()); });
async function create(options = browserOptions()) { ledgers.push(options.ledger); const t = (await BrowserTransport.create(options))!; owned.push(t); return t; }
describe('browser-transport: actual offline Chromium contexts', () => {
  it('does not construct or launch a browser in dry-run', async () => {
    const launch = vi.fn(); const options = browserOptions(); ledgers.push(options.ledger);
    expect(await BrowserTransport.create({ ...options, mode: 'dry-run', launch })).toBeNull(); expect(launch).not.toHaveBeenCalled();
  });
  it('fails live mode before launch without opt-in and verified inventory', async () => {
    const launch = vi.fn(); const options = browserOptions(); ledgers.push(options.ledger);
    await expect(BrowserTransport.create({ ...options, mode: 'live', launch })).rejects.toThrow('opt-in'); expect(launch).not.toHaveBeenCalled();
  });
  it('charges documents, images and refreshes; preview/cache reads issue no requests', async () => {
    const options = browserOptions();
    options.fixture = async r => r.url.endsWith('/pixel') ? { status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' } : { status: 200, contentType: 'text/html', body: '<main data-view>hello</main><img src="/pixel">' };
    const t = await create(options); const id = await t.open('before');
    await t.navigate(id, 'https://before.example.test/launch'); expect(options.ledger.snapshot.requestsUsed).toBe(2);
    await t.preview(id, '[data-view]'); await t.preview(id, '[data-view]'); expect(options.ledger.snapshot.requestsUsed).toBe(2);
    // Routing disables HTTP cache: even repeated assets must spend permits.
    await t.refresh(id); expect(options.ledger.snapshot.requestsUsed).toBe(4);
    expect(options.ledger.snapshot.activeRequests).toBe(0);
  });
  it('keeps independent jars; redacts cookies, secrets and personal fields from previews', async () => {
    const options = browserOptions();
    options.fixture = async () => ({ status: 200, contentType: 'text/html', headers: { 'set-cookie': '__cfwaitingroom=cookie-canary; Path=/; Secure' }, body: '<main>cookie-canary secret-canary test@example.com token=token-canary<span data-private>private-canary</span><input value="input-canary"></main>' });
    const t = await create(options); const a = await t.open('after'); const b = await t.open('after');
    await t.navigate(a, 'https://after.example.test/launch'); expect(await t.continuity(a)).toBe(true);
    const preview = await t.preview(a, 'main', new Redactor(['secret-canary']));
    expect(JSON.stringify(preview)).not.toMatch(/cookie-canary|secret-canary|test@example.com|token-canary|private-canary|input-canary/);
    expect(preview.frame).toBeNull(); expect(preview.mode).toBe('fixture');
    await expect(t.preview(a, 'body')).rejects.toThrow('Unqualified');
    expect(await t.continuity(b)).toBe(true); expect(t.sessions.map(s => s.sessionId)).toEqual(['session-1', 'session-2']);
    expect(Object.keys(t)).not.toContain('context');
  });
  it('blocks unapproved subrequests and redirects without forwarding credentials', async () => {
    const options = browserOptions(); const urls: string[] = [];
    options.fixture = async r => { urls.push(r.url); return r.url.endsWith('/redirect') ? { status: 302, contentType: 'text/html', headers: { location: 'https://evil.example/steal' }, body: '' } : { status: 200, contentType: 'text/html', body: '<main>safe</main><img src="https://evil.example/pixel"><img src="https://after.example.test/pixel">' }; };
    const t = await create(options); const id = await t.open('before');
    await t.navigate(id, 'https://before.example.test/launch'); expect(urls).toEqual(['https://before.example.test/launch']);
    await expect(t.navigate(id, 'https://before.example.test/redirect')).rejects.toThrow();
    expect(urls).toHaveLength(2); expect(options.ledger.snapshot.requestsUsed).toBe(2);
    await expect(t.navigate(id, 'https://after.example.test/launch')).rejects.toThrow('allowlisted');
    await expect(t.navigate(id, 'https://before.example.test/?token=secret')).rejects.toThrow('Credentials');
  });
  it('charges every allowed redirect and strips correlation from image origins', async () => {
    const options = browserOptions(); options.followRedirects = true;
    const calls: { url: string; requestId: string | null }[] = [];
    options.fixture = async r => { calls.push(r); return r.url.endsWith('/redirect') ? { status: 302, contentType: 'text/html', headers: { location: '/launch' }, body: '' } : { status: 200, contentType: 'text/html', body: r.url.endsWith('/launch') ? '<main>safe</main><img src="https://imagedelivery.net/asset">' : '' }; };
    const t = await create(options); const id = await t.open('before');
    await t.navigate(id, 'https://before.example.test/redirect'); expect(calls).toHaveLength(3); expect(options.ledger.snapshot.requestsUsed).toBe(3);
    expect(calls[0]!.requestId).not.toBe(calls[1]!.requestId); expect(calls[2]!.requestId).toBeNull();
  });
  it('enforces session/request caps and closes only its owned contexts', async () => {
    const options = browserOptions(new BudgetLedger({ limits: { sessions: 1, requests: 1, cleanupRequests: 0 } }));
    const t = await create(options); const id = await t.open('before'); await expect(t.open('after')).rejects.toThrow('session allowance');
    await t.navigate(id, 'https://before.example.test/launch'); await expect(t.refresh(id)).rejects.toThrow();
    expect(options.ledger.snapshot.requestsUsed).toBe(1); await t.close(); await t.close(); expect(t.sessions[0]!.state).toBe('closed');
  });
  it('cancels pending navigation and prevents further dispatch', async () => {
    const options = browserOptions(); let started!: () => void;
    const requested = new Promise<void>(resolve => { started = resolve; });
    options.fixture = async () => { started(); await new Promise(resolve => setTimeout(resolve, 100)); return { status: 200, contentType: 'text/html', body: '<main>late</main>' }; };
    const t = await create(options); const id = await t.open('before');
    const nav = t.navigate(id, 'https://before.example.test/launch'); const rejected = expect(nav).rejects.toThrow();
    await requested; options.ledger.stop('presenter stop'); await rejected; await t.close();
    await expect(t.open('after')).rejects.toThrow('closed'); expect(options.ledger.snapshot.activeRequests).toBe(0);
  });
  it('enforces the work deadline and closes its contexts before cleanup reserve', async () => {
    const clock = new TestClock(); const options = browserOptions(new BudgetLedger({ clock }));
    const t = await create(options); await t.open('before');
    clock.advance(options.ledger.workDeadline); await t.close();
    expect(t.stopped).toBe(true); expect(t.sessions[0]!.state).toBe('closed');
    await expect(t.open('after')).rejects.toThrow('closed'); expect(options.ledger.snapshot.requestsUsed).toBe(0);
  });
  it('shares the concurrency semaphore across subrequests', async () => {
    const options = browserOptions(new BudgetLedger({ limits: { concurrency: 1, cleanupRequests: 0 } }));
    let active = 0; let peak = 0;
    options.fixture = async r => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; return { status: 200, contentType: 'text/html', body: r.url.endsWith('/launch') ? '<img src="/one"><img src="/two">' : '' }; };
    const t = await create(options); const id = await t.open('before'); await t.navigate(id, 'https://before.example.test/launch');
    expect(peak).toBe(1); expect(options.ledger.snapshot.peakConcurrency).toBe(1); expect(options.ledger.snapshot.requestsUsed).toBe(3);
  });
  it('keeps cookies in one context, never another', async () => {
    const options = browserOptions();
    options.fixture = async r => ({ status: 200, contentType: 'text/html', headers: r.sessionId === 'session-1' ? { 'set-cookie': 'private=jar-canary; Path=/; Secure' } : {}, body: '<main id="view"></main><script>document.getElementById("view").textContent=document.cookie</script>' });
    const t = await create(options); const a = await t.open('after'); const b = await t.open('after');
    await t.navigate(a, 'https://after.example.test/launch'); await t.navigate(b, 'https://after.example.test/launch');
    expect((await t.preview(a, 'main')).text).toContain('[REDACTED]'); expect((await t.preview(b, 'main')).text).toBe('');
  });
  it('caps preview bytes and refuses fixture network fallback', async () => {
    const options = browserOptions(); options.fixture = async () => ({ status: 200, contentType: 'text/html', body: `<main>${'x'.repeat(10000)}</main>` });
    const t = await create(options); const id = await t.open('before'); await t.navigate(id, 'https://before.example.test/launch');
    expect(Buffer.byteLength((await t.preview(id, 'main')).text)).toBe(4096);
    const bad = browserOptions(); delete bad.fixture; ledgers.push(bad.ledger); await expect(BrowserTransport.create(bad)).rejects.toThrow('Fixture responder required');
  });
});
