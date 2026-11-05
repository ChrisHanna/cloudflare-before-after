import { describe, expect, it } from 'vitest';
import { createServer } from 'vite';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { startControlServer } from '../apps/control-server/src/server.js';
import { t38Bindings } from './t38-at11-14-bindings.js';
import { createStorefrontWorker } from '../apps/storefront-worker/src/worker.js';
import { SYNTHETIC_IMAGE_BASE64 } from '../packages/demo-core/src/infrastructure.js';
import { installedBrowser } from './browser-transport-fixtures.js';
import { atRecord } from '../packages/demo-core/src/t38-at11-14-record.js';

describe('T38 AT-11 actual React -> loopback proxy -> control API -> CLI', () => {
  it('uses keyboard controls, retains runner evidence and preserves blocked-frame fallback', async () => {
    const started = performance.now(); const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 't38-ui-')); const f = await t38Bindings(root);
    const control = await startControlServer({ projectRoot: root, port: 0, demo: { mode: 'fixture', dispatch: f.dispatch, loadConfig: () => f.config, credentials: () => f.credentials } });
    const vite = await createServer({ root: resolve('apps/command-center'), cacheDir: join(root, 'vite-cache'), configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: control.origin, changeOrigin: true, headers: { origin: control.origin } } } } });
    const browser = await installedBrowser();
    try {
      await vite.listen(); const address = vite.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Loopback address missing');
      const origin = `http://127.0.0.1:${address.port}`; const context = await browser.newContext();
      try {
        const login = await fetch(`${control.origin}/api/bootstrap/redeem`, { method: 'POST', headers: { origin: control.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: control.control.issueBootstrap() }) });
        expect(login.status).toBe(200); const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!; const equals = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
        let manualViews = 0;
        await context.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin === origin) return route.continue();
          const env = f.config.environments.find(e => e.origin === url.origin);
          if (env && url.pathname === '/') {
            manualViews++; const response = await createStorefrontWorker(f.bindings.get(env.role)!).request(url.href);
            expect(response.headers.get('content-security-policy')).toContain('frame-ancestors http://127.0.0.1:8787');
            return route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
          }
          if (url.origin === 'https://imagedelivery.net') return route.fulfill({ contentType: 'image/png', body: Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64') });
          return route.abort();
        });
        const page = await context.newPage(); await page.goto(origin);
        await page.getByRole('combobox', { name: 'Scenario', exact: true }).waitFor();
        for (const role of ['Before', 'After']) {
          const panel = page.getByRole('article', { name: `${role} storefront`, exact: true });
          await panel.getByText(`https://${role.toLowerCase()}.example.test`, { exact: true }).waitFor();
          expect(await panel.innerText()).toContain(`https://${role.toLowerCase()}.example.test`); expect(await panel.innerText()).toContain(f.config.environments[0].releaseDigest);
        }
        expect(await page.getByRole('complementary', { name: 'Expected proof', exact: true }).innerText()).toContain('Proof criteria');
        await page.getByRole('button', { name: 'Dry run', exact: true }).focus(); await page.keyboard.press('Enter');
        await page.getByText('Local plan valid. No network calls. Not verified.', { exact: true }).waitFor(); expect(f.calls).toHaveLength(0);
        await page.getByLabel('Allow bounded demo traffic to this lab').focus(); await page.keyboard.press('Space');
        const created = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Start scenario', exact: true }).focus(); await page.keyboard.press('Enter');
        const id = (await (await created).json()).run.id;
        await page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true }).waitFor();
        expect(await page.getByRole('table', { name: 'Scripted HTTP observations' }).locator('tbody tr').count()).toBe(4);
        const jobResponse = await context.request.get(`${origin}/api/runs/${id}`); const job = (await jobResponse.json()).run;
        expect(await page.locator('body').innerText()).toContain(job.actualRunId);
        const actualEntries = f.receipts.filter(r => r.runId === job.actualRunId && r.stage === 'entry');
        expect(actualEntries).toHaveLength(3);
        for (const role of ['before', 'after']) {
          const entries = actualEntries.filter(r => r.targetRole === role);
          expect(job.evidence.roles.find((r: any) => r.role === role).originReceived).toBe(new Set(entries.map(r => r.requestId)).size);
          for (const receipt of entries) expect(job.artifacts.some((a: any) => a.source === 'origin' && a.payload.id === receipt.id)).toBe(true);
        }
        expect(job.result.report.mode).toBe('fixture');
        const count = f.calls.length; await page.getByRole('button', { name: 'Refresh local view' }).click();
        await page.getByRole('link', { name: 'Open captured comparison report ↗' }).waitFor(); expect(f.calls).toHaveLength(count);
        expect(await page.locator('body').innerText()).not.toContain(f.canary);
        await page.getByLabel('Allow manual storefront view traffic').check(); await page.getByRole('button', { name: 'Load inline views' }).click();
        await page.locator('iframe').first().waitFor(); expect(await page.locator('iframe').count()).toBe(2);
        await page.getByRole('button', { name: 'Use paired tabs' }).click(); expect(await page.locator('iframe').count()).toBe(0);
        const link = page.getByRole('link', { name: 'Open Before in tab ↗' }); expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
        const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]); await popup.waitForLoadState('domcontentloaded'); expect(popup.url()).toBe(f.config.environments[0].origin + '/');
        expect(await popup.locator('img').evaluate(async image => { await (image as HTMLImageElement).decode(); return (image as HTMLImageElement).naturalWidth; })).toBeGreaterThan(0);
        await popup.close();
        expect(manualViews).toBeGreaterThan(0); expect(f.calls).toHaveLength(count);
        const record = atRecord({ id: 'AT-11A', releaseDigest: job.result.report.result.releaseDigest, result: job.result.report.result, artifacts: job.artifacts, requestsUsed: count, durationMs: performance.now() - started, checks: [{ name: 'Browser shows the actual runner run ID and four observations', passed: (await page.locator('body').innerText()).includes(job.actualRunId) }, { name: 'Manual paired tabs do not restart scripted traffic', passed: f.calls.length === count }] }); console.info(JSON.stringify(record)); expect(record.outcome).toBe('unavailable');
      } finally { await context.close(); }
    } finally { await browser.close(); await vite.close(); await control.close(); await f.dispose(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
