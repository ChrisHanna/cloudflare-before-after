import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
const fixtureURL = new URL(process.env.LAB_UI_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4173');
if (fixtureURL.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(fixtureURL.hostname) || fixtureURL.username || fixtureURL.password) throw new Error('HTTP loopback fixture origin required');
const origin = fixtureURL.origin;
const evidence = resolve(import.meta.dirname, '../../.kiro/workflow-evidence/command-center-ui-2026-11-05');
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
const blocked = new WeakMap<BrowserContext, string[]>();
async function loopbackOnly(context: BrowserContext) {
  const attempts: string[] = []; blocked.set(context, attempts);
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    attempts.push(route.request().url()); return route.abort('blockedbyclient');
  });
}
async function noRun(page: Page) {
  await page.route('**/api/runs', route => route.request().method() === 'GET' ? route.fulfill({ json: { activeRunId: null, runs: [] } }) : route.fallback());
  await page.route('**/api/journal-runs', route => route.fulfill({ json: { runs: [], truncated: false } }));
}
async function capture(page: Page, name: string) {
  mkdirSync(evidence, { recursive: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });
}
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' }); await loopbackOnly(context);
  const page = await context.newPage(); await page.goto(origin);
  await page.getByRole('button', { name: 'Connect browser', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toBeVisible();
  cookies = await context.cookies(); expect(cookies.every(cookie => cookie.httpOnly && cookie.sameSite === 'Strict')).toBe(true);
  expect(blocked.get(context)).toEqual([]); await context.close();
});
test.beforeEach(async ({ context }) => { await loopbackOnly(context); await context.addCookies(cookies); });
test.afterEach(async ({ page, context }) => { await page.unrouteAll({ behavior: 'wait' }); expect(blocked.get(context), 'unexpected non-loopback browser requests').toEqual([]); });
for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  const size = `${viewport.width}x${viewport.height}`;
  test(`fixture visuals, consent and local synthetic storefront ${size}`, async ({ page, context }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await noRun(page); let starts = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/runs')) starts++; });
    await page.goto('/');
    await expect(page.getByText('FIXTURE · no live Cloudflare proof', { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Presenter notes', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Run comparison', exact: true })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Run evidence', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Run result', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use paired tabs', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
    await capture(page, `command-center-empty-${size}.png`);
    const advanced = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Advanced limits$/ }) });
    await expect(advanced).not.toHaveAttribute('open');
    const history = page.locator('details[aria-label="Local run history"]');
    await expect(history).not.toHaveAttribute('open');
    const link = page.getByRole('link', { name: 'Open Before in tab ↗', exact: true });
    await expect(link).toHaveAttribute('aria-disabled', 'true'); await expect(link).not.toHaveAttribute('href'); await link.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('Allow manual view traffic');
    expect(context.pages()).toHaveLength(1); await expect(page.locator('iframe')).toHaveCount(0); expect(starts).toBe(0);
    // Consent never opens tabs or frames by itself. Revoking restores the paired-tab default.
    await page.getByLabel('Allow manual storefront view traffic').check();
    await expect(link).toHaveAttribute('href', 'https://before.example.test');
    expect(context.pages()).toHaveLength(1); await expect(page.locator('iframe')).toHaveCount(0);
    await page.getByLabel('Allow manual storefront view traffic').uncheck();
    await expect(link).not.toHaveAttribute('href');
    await expect(page.getByRole('button', { name: 'Use paired tabs', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Start scenario', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Start scenario', exact: true })).toBeDisabled();
    await page.unroute('**/api/runs'); await page.unroute('**/api/journal-runs');
    await page.getByLabel('Allow bounded demo traffic to this lab').check();
    const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
    await page.getByRole('button', { name: 'Start scenario', exact: true }).click();
    expect((await created).status()).toBe(202);
    await expect(page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true })).toBeVisible();
    const strip = page.getByRole('region', { name: 'Run comparison', exact: true });
    await expect(strip.getByLabel('Verdict', { exact: true })).toContainText('Fixture');
    await expect(page.getByRole('article', { name: 'Before run summary', exact: true })).toContainText('HTTP 200');
    await expect(page.getByRole('article', { name: 'After run summary', exact: true })).toContainText('HTTP 403');
    await expect(page.getByRole('article', { name: 'After run summary', exact: true })).toContainText('c'.repeat(32));
    await strip.scrollIntoViewIfNeeded(); await capture(page, `command-center-result-${size}.png`);
    await page.getByText('Architecture & service readback', { exact: true }).click();
    const architecture = page.locator('details.architecture');
    await expect(architecture.getByRole('img', { name: 'Declared paired storefront architecture', exact: true })).toBeVisible();
    await expect(architecture).toContainText('Health unknown');
    await architecture.scrollIntoViewIfNeeded(); await capture(page, `command-center-architecture-${size}.png`);
    expect(starts).toBe(1); expect(context.pages()).toHaveLength(1);
    expect(await page.evaluate(() => document.cookie)).toBe('');
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    expect(await page.locator('img').count()).toBe(0);
    // Deliberately test-local HTML. Not runtime output, not deployed, no external assets or images.
    await page.route(`${origin}/synthetic-storefront`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Synthetic storefront · local only</title><style>:root{color-scheme:dark;font:16px system-ui;background:#10191f;color:#edf3f5}*{box-sizing:border-box}body{margin:0;padding:24px}main{max-width:900px;margin:auto}header{border-bottom:1px solid #3a515e;padding-bottom:24px}small{color:#ffa45c}h1{font-size:clamp(28px,5vw,44px)}article{margin-top:24px;padding:24px;background:#18252d;border:1px solid #3a515e;border-radius:16px}svg{width:100%;height:160px}p{line-height:1.6}a{color:#ffa45c}</style><main><header><small>LOCAL SYNTHETIC FIXTURE · NOT DEPLOYED</small><h1>Paired storefront</h1><p>Before / After workshop view</p></header><article><svg viewBox="0 0 300 160" role="img" aria-label="Synthetic shop illustration"><rect x="55" y="45" width="190" height="100" rx="8" fill="#20313b" stroke="#77d4c2"/><path d="M40 45h220l-25-30H65z" fill="#ffa45c"/><rect x="135" y="80" width="30" height="65" fill="#10191f"/></svg><h2>Catalog view</h2><p>Test-local layout only. No product, price, health or security claim.</p><p>Ray ID: unknown · Release: unknown · Origin receipts: unknown</p><a href="/">Return to local Command Center</a></article></main></html>` }));
    await page.goto('/synthetic-storefront'); await expect(page.getByRole('heading', { name: 'Paired storefront', exact: true })).toBeVisible();
    await capture(page, `synthetic-storefront-${size}.png`);
  });
}
test('captured phases, cleanup unknown, stale evidence and absent sources stay truthful', async ({ page }) => {
  await page.route('**/api/runs', route => route.fulfill({ json: { activeRunId: null, runs: [] } }));
  await page.route('**/api/journal-runs/*', async route => {
    const response = await route.fetch(); const body = await response.json();
    if (body.run) {
      body.run.status = 'cancelled'; body.run.phase = 'protected'; body.run.result = null; body.run.reportId = null;
      body.run.evidence = null; body.run.observations = [];
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto('/'); const phases = page.getByRole('region', { name: 'Run phases', exact: true });
  await expect(phases).toContainText('Protected');
  await expect(phases.locator('li').filter({ hasText: 'Protected' })).toContainText('Observed phase');
  await expect(phases.locator('li').filter({ hasText: 'Cleanup' })).toContainText('Not observed');
  const strip = page.getByRole('region', { name: 'Run comparison', exact: true });
  await expect(strip).toContainText('Verdict unknown'); await expect(strip).toContainText('Unknown / unavailable');
  await expect(strip.locator('dt').filter({ hasText: 'HTTP status' })).toHaveCount(2);
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await phases.scrollIntoViewIfNeeded();
    await capture(page, `command-center-phase-${viewport.width}x${viewport.height}.png`);
  }
  await page.unroute('**/api/journal-runs/*');
  await page.route('**/api/journal-runs/*', async route => {
    const response = await route.fetch(); const body = await response.json();
    if (body.run) {
      body.run.result.report.result.cleanup = 'incomplete';
      for (const observation of body.run.observations) observation.observedAt = '2020-01-01T00:00:00.000Z';
      for (const role of body.run.evidence.roles) {
        role.originReceived = null;
        for (const source of role.sources) { source.state = 'stale'; source.observedAt = '2020-01-01T00:00:00.000Z'; }
      }
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh local view', exact: true }).click();
  await expect(phases.locator('li').filter({ hasText: 'Cleanup' })).toContainText('incomplete');
  await expect(strip).toContainText('Stale'); await expect(strip).toContainText('stale');
  await expect(strip).toContainText('Unknown');
});
test('scenario readiness never equates adapter support or WAF scope with Waiting Room deployment', async ({ page }) => {
  await noRun(page); await page.goto('/');
  const scenario = page.getByRole('combobox', { name: 'Scenario', exact: true });
  await expect(scenario.locator('option[value="waf-custom"]')).toContainText('Deployment unknown · fixture');
  await scenario.selectOption('waiting-room'); await expect(page.getByText('Waiting Room needs its own queue and admission proof.', { exact: false })).toBeVisible();
  await expect(page.locator('.scenario-state')).toHaveText('Deployment unknown · fixture');
  // Synthetic projection tests positive and negative deployment labels; never a network readback.
  await page.route('**/api/catalog', async route => {
    const response = await route.fetch(); const body = await response.json(); body.mode = 'live';
    for (const policy of body.policies) if (policy.scenarioId === 'waf-custom' || policy.scenarioId === 'waiting-room') {
      Object.assign(policy.observed, { state: 'last-checked', mode: 'live', observedAt: new Date().toISOString(), enabled: policy.scenarioId === 'waf-custom' }); policy.readinessBlocked = false;
    }
    body.scenarios.find((item: { id: string }) => item.id === 'analytics').implemented = false;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/readiness', route => route.fulfill({ json: { report: null, freshness: 'last-checked', automaticallyRefreshed: false, currentPreflightReady: false, scoped: { mode: 'live', observedAt: new Date().toISOString(), historical: false, includedModules: ['waf-custom'], excludedModules: [], claims: { coreDeployed: true, deploymentVerified: false, interviewVerified: false, workshopVerified: false, fallbackAvailable: false }, blockers: [] } } }));
  await page.getByRole('button', { name: 'Refresh local view', exact: true }).click();
  await expect(scenario.locator('option[value="waf-custom"]')).toContainText('Deployed · last checked');
  await expect(scenario.locator('option[value="waiting-room"]')).toContainText('Not deployed · policy disabled');
  await expect(scenario.locator('option[value="analytics"]')).toContainText('Unavailable · adapter');
  await page.unroute('**/api/readiness');
  await page.route('**/api/readiness', route => route.fulfill({ json: { report: null, freshness: 'historical', automaticallyRefreshed: false, currentPreflightReady: false, scoped: { mode: 'live', observedAt: '2020-01-01T00:00:00.000Z', historical: true, includedModules: ['waf-custom'], excludedModules: [], claims: { coreDeployed: true, deploymentVerified: true, interviewVerified: false, workshopVerified: false, fallbackAvailable: false }, blockers: [] } } }));
  await page.getByRole('button', { name: 'Refresh local view', exact: true }).click();
  await expect(scenario.locator('option[value="waf-custom"]')).toContainText('Deployment unknown');
});
test('CSRF and presenter gates remain enforced by the local fixture server', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: 'waf-custom', liveOptIn: true, limits: { requests: 30, concurrency: 2, maxRuntimeSeconds: 60 } }) })).status);
  expect(status).toBe(403);
  await page.context().clearCookies(); await page.reload();
  await expect(page.getByRole('button', { name: 'Connect browser', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start scenario', exact: true })).toHaveCount(0);
});
