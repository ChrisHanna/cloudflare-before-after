import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { CATALOG } from '../../scenarios/catalog.js';
import { installedBrowser } from '../browser-transport-fixtures.js';
import { WaitingRoomStateMachine, type WaitingRoomResult } from '../../packages/demo-core/src/waiting-room.js';
import { BrowserPreviewSchema, InterviewViewSchema, ScopedReadinessSchema, WaitingRoomViewSchema, observedCounts, safePreviewText } from '../../apps/command-center/src/workshop-views.js';

let vite: ViteDevServer; let browser: Browser; let origin: string;
const contexts: BrowserContext[] = [];
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('Owned KIROCREW_SCRATCH required');
  vite = await createServer({ root: resolve('apps/command-center'), cacheDir: resolve(process.env.KIROCREW_SCRATCH, 'waiting-room-ui-vite-cache'), configFile: false, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await vite.listen(); const address = vite.httpServer!.address();
  if (!address || typeof address === 'string') throw new Error('Loopback address missing');
  origin = `http://127.0.0.1:${address.port}`; browser = await installedBrowser();
}, 30000);
afterEach(async () => { await Promise.all(contexts.splice(0).map(context => context.close())); });
afterAll(async () => { await browser?.close(); await vite?.close(); });
function room() {
  const runId = randomUUID(); const machine = new WaitingRoomStateMachine(runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) });
  for (const [id, role] of [['session-1', 'before'], ['session-2', 'after'], ['session-3', 'after']] as const) machine.register(id, role);
  let tick = Date.now() - 2000;
  function observe(id: string, queued: boolean) {
    const requestId = randomUUID(); const at = new Date(tick += 10).toISOString(); const role = id === 'session-1' ? 'before' as const : 'after' as const;
    machine.observe({ sessionId: id, requestId, observedAt: at, queue: queued, storefront: !queued, queueCookiePresent: true, cookieContinuity: true, receipts: queued ? [] : [{ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waiting-room', targetRole: role, producerId: 'fixture-container', sequence: 1, observedAt: at, rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' }] });
  }
  observe('session-1', false); observe('session-2', false); observe('session-3', true); observe('session-2', false);
  return { runId, machine, observe };
}
async function mount(command = 'waiting-room') {
  const f = room();
  const job = { id: randomUUID(), command, ownership: 'control', readOnly: false, historical: false, status: 'running', phase: 'protected', actualRunId: f.runId, createdAt: new Date().toISOString(), finishedAt: null, exitCode: null, error: null, eventSequence: 1, truncated: false, reportId: null, result: null, observations: [], waitingRoom: f.machine.result(), interview: null as unknown };
  const state = { job, previewCalls: 0, starts: 0, advances: 0, stops: 0, failPreview: false, wrongPreview: false, previewText: '<img src=x onerror=alert(1)>\ncookie=private-canary', ready: null as unknown };
  const context = await browser.newContext(); contexts.push(context);
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { await route.abort(); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    let body: unknown = {};
    if (url.pathname === '/api/session') body = { authenticated: true, csrfToken: 'a'.repeat(64), expiresAt: Date.now() + 60000 };
    else if (url.pathname === '/api/catalog') body = { schemaVersion: 1, mode: 'fixture', configured: true, policies: [], targets: [{ role: 'before', origin: 'https://before.example.test', releaseDigest: 'a'.repeat(64) }, { role: 'after', origin: 'https://after.example.test', releaseDigest: 'a'.repeat(64) }], scenarios: CATALOG.map(m => ({ ...m, implemented: true })), aggregates: { interview: true, all: true, rehearsal: true } };
    else if (url.pathname === '/api/readiness') body = { report: null, freshness: 'unavailable', automaticallyRefreshed: false, currentPreflightReady: false, scoped: state.ready };
    else if (url.pathname === '/api/journal-runs') body = { runs: [], truncated: false };
    else if (url.pathname === '/api/runs') {
      if (route.request().method() === 'POST') { state.starts++; body = { run: job }; }
      else body = { activeRunId: job.status === 'running' ? job.id : null, runs: [job] };
    } else if (url.pathname.endsWith('/events')) {
      await route.fulfill({ contentType: 'text/event-stream', body: ': fixture snapshot only\n\n' }); return;
    } else if (url.pathname.endsWith('/preview')) {
      state.previewCalls++;
      if (state.failPreview) { await route.fulfill({ status: 404, json: { error: 'Preview unavailable' } }); return; }
      body = { sessionId: state.wrongPreview ? 'session-8' : url.pathname.split('/').at(-2), mode: 'fixture', kind: 'text', frame: null, text: state.previewText, observedAt: new Date(Date.now() - 30000).toISOString() };
    } else if (url.pathname.endsWith('/advance')) { state.advances++; await new Promise(resolve => setTimeout(resolve, 100)); body = { accepted: true }; }
    else if (url.pathname.endsWith('/stop')) { state.stops++; job.status = 'cancelled'; body = { stopped: true }; }
    else body = { run: job };
    await route.fulfill({ json: body });
  });
  const page = await context.newPage(); await page.goto(origin);
  await page.getByRole('heading', { name: 'Cloudflare Command Center' }).waitFor();
  await page.getByRole('region', { name: command === 'interview' ? 'Interview agenda' : 'Waiting Room sessions', exact: true }).waitFor();
  return { ...f, state, page };
}
const text = (page: Page) => page.locator('body').innerText();
describe('waiting-room-ui and guided components in actual offline Chromium', () => {
  it('shows distinct queued Q and continuing admitted A from actual runner records', async () => {
    const { page, state } = await mount();
    const panel = page.getByRole('region', { name: 'Waiting Room sessions', exact: true });
    expect(await panel.locator('[data-session-count="queued"]').innerText()).toBe('1');
    expect(await panel.locator('[data-session-count="admitted"]').innerText()).toBe('2');
    expect(await panel.getByRole('article', { name: 'session-3 after session' }).innerText()).toContain('Observed state: queued');
    const admitted = panel.getByRole('article', { name: 'session-2 after session' });
    await admitted.locator('summary').click(); expect(await admitted.locator('li').count()).toBe(2);
    expect(await admitted.innerText()).toContain('Wait estimate: Unavailable'); expect(await admitted.innerText()).toContain('Cookie continuity: preserved');
    expect(await panel.innerText()).toContain('Runner outcome: inconclusive'); expect(state.previewCalls).toBe(0); expect(state.starts).toBe(0);
  });
  it('keeps the same Q card when admission arrives; no hidden scenario restart', async () => {
    const { page, state, observe, machine } = await mount();
    const q = page.getByRole('article', { name: 'session-3 after session' }); await q.locator('summary').click();
    observe('session-3', false); state.job.waitingRoom = machine.result(); state.job.eventSequence++;
    await page.getByRole('button', { name: 'Refresh local view' }).click();
    await page.getByText('Observed state:', { exact: false }).first().waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="session-3 after session"] strong')?.textContent === 'admitted');
    expect(await q.innerText()).toContain('queued → admitted'); expect(await q.locator('details').getAttribute('open')).not.toBeNull();
    expect(state.job.waitingRoom.fixtureAssertionsPassed).toBe(true); expect(await text(page)).not.toContain('Workshop verifiedPassed'); expect(state.starts).toBe(0);
  });
  it('loads one bounded text preview using keyboard; masks cookies and never executes markup', async () => {
    const { page, state } = await mount(); const button = page.getByRole('button', { name: 'Inspect session-3 preview' });
    await button.focus(); await page.keyboard.press('Enter');
    const preview = page.getByRole('region', { name: 'session-3 captured preview' }); await preview.waitFor();
    expect(await preview.innerText()).toContain('FIXTURE'); expect(await preview.innerText()).toContain('Stale capture'); expect(await preview.innerText()).toContain('<img src=x onerror=alert(1)>');
    expect(await preview.locator('img').count()).toBe(0); expect(await text(page)).not.toContain('private-canary');
    await page.getByRole('button', { name: 'Inspect session-2 preview' }).click(); await page.getByRole('region', { name: 'session-2 captured preview' }).waitFor();
    expect(await page.getByRole('region', { name: 'session-3 captured preview' }).count()).toBe(0);
    await page.getByRole('button', { name: 'Clear captured preview' }).click(); expect(await page.locator('pre').count()).toBe(0);
    expect(state.previewCalls).toBe(2); expect(state.starts).toBe(0);
  });
  it('handles unavailable and wrong-session previews without false proof', async () => {
    const { page, state } = await mount(); state.failPreview = true;
    await page.getByRole('button', { name: 'Inspect session-3 preview' }).click(); await page.getByText('Preview unavailable. Inspect the runner-owned browser window.').waitFor();
    state.failPreview = false; state.wrongPreview = true;
    await page.getByRole('button', { name: 'Inspect session-2 preview' }).click();
    await page.waitForTimeout(100); expect(await page.locator('pre').count()).toBe(0);
    expect(await text(page)).toContain('Runner outcome: inconclusive');
  });
  it('labels historical sessions and blocks preview reads; stops owned traffic', async () => {
    const { page, state } = await mount(); state.job.historical = true;
    await page.getByRole('button', { name: 'Refresh local view' }).click();
    await page.getByText('SAVED EVIDENCE — historical session records, not live').waitFor();
    expect(await page.getByRole('button', { name: 'Inspect session-3 preview' }).isDisabled()).toBe(true);
    await page.getByRole('button', { name: 'Stop run', exact: true }).click();
    await page.getByText('Cancelled · observations retained').waitFor(); expect(state.stops).toBe(1); expect(state.previewCalls).toBe(0);
  });
  it('shows fixed interview slots and serializes keyboard advance; preserves failed stage fallback', async () => {
    const { page, state } = await mount('interview');
    state.job.interview = InterviewViewSchema.parse({ mode: 'fixture', observedAt: new Date().toISOString(), stageIndex: 3, elapsedMs: 180000, requestsUsed: 40, state: 'running', stageOutcome: 'inconclusive', purpose: 'Keep shoppers moving', action: 'Inspect queued sessions', talkingPoints: ['Admitted shoppers can shop'], question: 'Where is the queue?', missingProof: ['No live admission proof'], fallback: { capturedAt: '2026-11-01T00:00:00Z', eligible: false } });
    await page.getByRole('button', { name: 'Refresh local view' }).click(); const advance = page.getByRole('button', { name: 'Advance interview stage' }); await advance.waitFor();
    expect(await text(page)).toContain('165–240 seconds'); expect(await text(page)).toContain('Remaining at snapshot: 60 seconds');
    await advance.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Enter');
    await page.waitForTimeout(300); expect(state.advances).toBe(1);
    expect(await text(page)).toContain('SAVED EVIDENCE — not live stage success'); expect(state.starts).toBe(0);
    state.job.readOnly = true; await page.getByRole('button', { name: 'Refresh local view' }).click();
    await page.waitForFunction(() => (document.querySelector('[aria-label="Interview agenda"] button') as HTMLButtonElement)?.disabled);
    expect(await advance.isDisabled()).toBe(true);
  });
  it('blocks scoped fixture readiness while keeping missing data unknown', async () => {
    const { page, state } = await mount(); const panel = page.getByRole('region', { name: 'Scoped readiness claims' });
    expect(await panel.innerText()).toContain('Unknown');
    state.ready = ScopedReadinessSchema.parse({ mode: 'fixture', observedAt: new Date().toISOString(), historical: false, includedModules: ['core-waf'], excludedModules: [{ id: 'waiting-room', reason: 'Entitlement unknown' }], claims: { coreDeployed: true, deploymentVerified: true, interviewVerified: true, workshopVerified: true, fallbackAvailable: true }, blockers: [{ claim: 'workshopVerified', reason: 'No genuine DDoS evidence' }] });
    await page.getByRole('button', { name: 'Refresh local view' }).click(); await page.getByText('No genuine DDoS evidence').waitFor();
    expect(await panel.locator('dd').allTextContents()).toEqual(['Blocked', 'Blocked', 'Blocked', 'BlockedNo genuine DDoS evidence', 'Blocked']);
    expect(await panel.innerText()).toContain('Entitlement unknown');
    state.ready = { ...ScopedReadinessSchema.parse(state.ready), mode: 'live', observedAt: new Date(Date.now() - 120000).toISOString(), blockers: [] };
    await page.getByRole('button', { name: 'Refresh local view' }).click(); await page.getByText('Stale readback', { exact: false }).waitFor();
    expect(await panel.locator('dd').allTextContents()).toEqual(['Blocked', 'Blocked', 'Blocked', 'Blocked', 'Passed']);
  });
  it('keeps closed-session history, flags bad counts, and clears old-run previews', async () => {
    const { page, state, machine } = await mount();
    await page.getByRole('button', { name: 'Inspect session-3 preview' }).click();
    await page.getByRole('region', { name: 'session-3 captured preview' }).waitFor();
    machine.close(); state.job.waitingRoom = { ...machine.result(), counts: { queued: 8, admitted: 0, unknown: 0 } };
    await page.getByRole('button', { name: 'Refresh local view' }).click();
    await page.getByText('Runner counts differ from session records. Readiness is unproven.').waitFor();
    const q = page.getByRole('article', { name: 'session-3 after session' });
    expect(await q.innerText()).toContain('Browser state: closed'); expect(await q.innerText()).toContain('Observed state: queued');
    state.job.id = randomUUID(); await page.getByRole('button', { name: 'Refresh local view' }).click();
    await page.waitForFunction(() => document.querySelectorAll('pre').length === 0);
    expect(state.starts).toBe(0);
  });
  it('rejects duplicate sessions, unbounded previews and raw cookie fields at the UI boundary', () => {
    const result = room().machine.result(); expect(WaitingRoomViewSchema.parse(result)).toEqual(result);
    expect(observedCounts(result)).toEqual({ queued: 1, admitted: 2, unknown: 0 });
    expect(() => WaitingRoomViewSchema.parse({ ...result, sessions: [...result.sessions, result.sessions[0]] })).toThrow();
    expect(() => WaitingRoomViewSchema.parse({ ...result, cookie: 'SECRET' })).toThrow();
    const preview = { sessionId: 'session-1', mode: 'fixture', observedAt: new Date().toISOString(), kind: 'text', frame: null, text: '界'.repeat(2000) };
    expect(() => BrowserPreviewSchema.parse(preview)).toThrow('Preview byte cap');
    expect(() => BrowserPreviewSchema.parse({ ...preview, text: 'safe', cookie: 'SECRET' })).toThrow();
    expect(safePreviewText('token=SECRET\nprivate@example.test')).not.toMatch(/SECRET|private@example.test/);
    const mismatch: WaitingRoomResult = { ...result, counts: { queued: 8, admitted: 0, unknown: 0 } };
    expect(observedCounts(mismatch).queued).toBe(1);
  });
});
