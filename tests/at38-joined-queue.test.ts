import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { startControlServer } from '../apps/control-server/src/server.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { deployedRuntimeConfig } from '../packages/demo-core/src/runtime-config.js';
import { validateBrowserFrame } from '../packages/contracts/src/waiting-room.js';
import { t38Bindings } from './t38-at11-14-bindings.js';
import { installedBrowser } from './browser-transport-fixtures.js';
const ROOT = '/mnt/c/users/NotAPC/Desktop/cloudflare_before_after';
describe('AT38 joined React/control/CLI/owned pages/Worker/Container/D1/R2/telemetry/report', () => {
  it('Q queues while A shops; real pixels, same-context Q admission and receipts survive reporting', async () => {
    const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'j-')); const f = await t38Bindings(root);
    const settings = { hostname: 'after.example.test', path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false as const, queue_all: false as const };
    // Model a confirmed fixture resource with explicitly reviewed execution
    // settings. Use the real runtime projection, not a hand-built run config.
    Object.assign(f.config, deployedRuntimeConfig(f.intent, f.inventory, 'c'.repeat(32), [], undefined, [{
      module: 'waiting-room', resourceId: 'a'.repeat(32), accountId: f.config.accountId, zoneId: f.config.zoneId,
      labId: f.config.labId, origin: f.config.environments[1].origin, releaseDigest: f.intent.releaseDigest,
      centralPlanDigest: 'a'.repeat(64), optionalPlanDigest: 'b'.repeat(64), operationId: 'c'.repeat(64), functionalDigest: 'd'.repeat(64),
      observedAt: new Date().toISOString(), mode: 'fixture', settings,
      execution: { queueContract: 'cloudflare-json-v1', expectedTransitionMs: 15000, perNavigationRequests: 2, refreshes: 1,
        queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]' },
    }]));
    const dispatch = async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.includes('/waiting_rooms/')) { f.calls.push({ url, method: init.method ?? 'GET' }); return Response.json({ success: true, result: { id: 'a'.repeat(32), host: settings.hostname, ...settings } }); }
      return f.dispatch(url, init);
    };
    const control = await startControlServer({ projectRoot: root, port: 0, demo: { mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch }, execute: (args, deps) => runDemoCli(args, { ...deps, onStarted: info => { f.setRoomRunId(info.runId); deps.onStarted?.(info); }, workshop: { browser: { launch: installedBrowser, fixture: f.browserFixture } } }) });
    const vite = await createServer({ root: `${ROOT}/apps/command-center`, cacheDir: join(root, 'vite-cache'), configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: control.origin, changeOrigin: true, headers: { origin: control.origin } } } } });
    const browser = await installedBrowser();
    try {
      await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Loopback missing');
      const origin = `http://127.0.0.1:${address.port}`; const context = await browser.newContext();
      try {
        const login = await fetch(`${control.origin}/api/bootstrap/redeem`, { method: 'POST', headers: { origin: control.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: control.control.issueBootstrap() }) });
        expect(login.status).toBe(200); const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!; const equals = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); await page.goto(origin);
        await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('waiting-room');
        await page.getByRole('spinbutton', { name: 'Request cap', exact: true }).fill('100');
        await page.getByLabel('Allow bounded demo traffic to this lab').check();
        const created = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Start scenario', exact: true }).focus(); await page.keyboard.press('Enter');
        const response = await created; expect(response.status()).toBe(202); const jobId = (await response.json()).run.id;
        const q = page.getByRole('article', { name: 'session-3 after session', exact: true });
        try { await q.getByText('queued', { exact: true }).waitFor({ timeout: 5000 }); }
        catch (error) {
          const state = (await (await context.request.get(`${origin}/api/runs/${jobId}`)).json()).run;
          console.info(JSON.stringify({ kind: 'fixture-failure', status: state.status, phase: state.phase, error: state.error, room: state.waitingRoom, outcome: state.result?.report?.result?.outcome, missingProof: state.result?.report?.result?.missingProof, calls: f.calls.map(c => new URL(c.url).pathname).slice(-20), receipts: f.receipts.length }));
          throw error;
        }
        expect(await q.innerText()).toContain('Queue position: Unavailable');
        const a = page.getByRole('article', { name: 'session-2 after session', exact: true });
        await a.getByText('admitted', { exact: true }).waitFor();
        const snapshot = (await (await context.request.get(`${origin}/api/runs/${jobId}`)).json()).run;
        const scope = snapshot.frameScopes.find((s: any) => s.sessionId === 'session-3'); expect(scope).toBeDefined();
        const frameUrl = `${origin}/api/runs/${jobId}/sessions/session-3/frame?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
        // The session snapshot precedes asynchronous pixel capture. Wait only
        // on the loopback cache; never issue a storefront refresh to fix it.
        await expect.poll(async () => (await context.request.get(frameUrl)).status(), { timeout: 3000, interval: 50 }).toBe(200);
        await expect.poll(() => f.visits.get('session-2'), { timeout: 3000 }).toBe(2);
        // A refresh may suppress its automatic capture under the real rate
        // guard. A presenter can retry only that explicit 409, never a failed
        // image assertion, foreign scope, missing session or storefront request.
        async function inspectSession(id: 'session-2' | 'session-3') {
          for (let attempt = 0; attempt < 3; attempt++) {
            const captured = page.waitForResponse(r => r.url().endsWith(`/${id}/capture`) && r.request().method() === 'POST');
            await page.getByRole('button', { name: `Inspect ${id} preview`, exact: true }).click();
            const response = await captured;
            if (response.status() === 409 && attempt < 2) { await new Promise(resolve => setTimeout(resolve, 1100)); continue; }
            expect(response.status()).toBe(200);
            await page.getByRole('img', { name: `${id} masked owned session`, exact: true }).waitFor({ timeout: 3000 });
            return;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1050));
        const count = f.calls.length;
        await inspectSession('session-3');
        const frameResponse = await context.request.get(frameUrl);
        expect(frameResponse.status()).toBe(200); const frame = validateBrowserFrame(await frameResponse.json(), scope, 'fixture');
        expect(frame.frame.startsWith('data:image/png;base64,')).toBe(true); expect(f.calls.length).toBe(count);
        // Capture A's current document too: its initial frame may predate the
        // runner's admitted-shopper refresh and cannot authorize a new action.
        await inspectSession('session-2');
        expect(f.calls.length).toBe(count);
        const navigation = page.waitForResponse(r => r.url().endsWith('/session-2/navigation') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Shop session-2 /catalog', exact: true }).focus(); await page.keyboard.press('Enter');
        expect((await navigation).status()).toBe(200);
        await page.getByText('Owned shopper navigation complete. Await runner receipt evidence.', { exact: true }).waitFor();
        expect(await q.innerText()).toContain('queued');
        await q.getByText('Browser state: closed', { exact: true }).waitFor({ timeout: 25000 });
        await q.getByText('admitted', { exact: true }).waitFor();
        expect(await q.getByRole('button', { name: 'Inspect session-3 preview', exact: true }).isVisible()).toBe(true);
        await q.locator('summary').click();
        const timeline = await q.locator('li').allTextContents();
        expect(timeline.some(text => text.includes('queued → navigating'))).toBe(true);
        expect(timeline.some(text => text.includes('navigating → admitted'))).toBe(true);
        expect(await q.innerText()).toContain('Cookie continuity: preserved');
        expect(await q.innerText()).toContain('Wait estimate: Unavailable');
        expect(await page.locator('[data-session-count="admitted"]').innerText()).toBe('3');
        expect(await page.locator('[data-session-count="queued"]').innerText()).toBe('0');
        const job = (await (await context.request.get(`${origin}/api/runs/${jobId}`)).json()).run;
        expect(job.result).not.toBeNull(); const room = job.waitingRoom;
        expect(room.fixtureAssertionsPassed).toBe(true); expect(room.liveReadiness).toBe(false); expect(room.mode).toBe('fixture');
        const queued = room.sessions.find((s: any) => s.sessionId === 'session-3');
        expect(queued.transitions.map((t: any) => t.to)).toEqual(['navigating', 'queued', 'navigating', 'admitted', 'closed']);
        expect(queued.cookieContinuity).toBe(true); expect(f.visits.get('session-2')).toBe(3); expect(f.visits.get('session-3')).toBe(2);
        const entries = f.receipts.filter(r => r.runId === job.actualRunId && r.stage === 'entry');
        expect(entries).toHaveLength(5);
        for (const transition of room.sessions.flatMap((s: any) => s.transitions).filter((t: any) => t.to === 'admitted')) expect(entries.some(r => r.requestId === transition.requestId)).toBe(true);
        const report = new ReportStore(root, f.config.evidenceDirectory).load(job.actualRunId);
        expect(report).toEqual(job.result.report); expect(report.waitingRoom).toEqual(room); expect(report.result.requestsUsed).toBe(f.calls.length);
        expect(report.result.outcome).not.toBe('verified'); expect(report.mode).toBe('fixture');
        const total = f.calls.length; await page.getByRole('button', { name: 'Refresh local view', exact: true }).click();
        expect(f.calls.length).toBe(total);
        expect((await context.request.get(`${origin}/api/runs/${jobId}/sessions/session-3/frame?${new URLSearchParams({ scope: JSON.stringify(scope) })}`)).status()).toBe(404);
        for (const secret of [...Object.values(f.credentials), 't38-secret-cookie']) { expect(JSON.stringify(job)).not.toContain(secret); expect(await page.locator('body').innerText()).not.toContain(secret); }
      } finally { await context.close(); }
    } finally { await browser.close(); await vite.close(); await control.close(); await f.dispose(); rmSync(root, { recursive: true, force: true }); }
  }, 45000);
});
