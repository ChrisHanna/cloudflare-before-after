import { test, expect, type BrowserContext } from '@playwright/test';
const fixtureURL = new URL(process.env.LAB_UI_FIXTURE_ORIGIN ?? 'http://127.0.0.1:4173');
if (fixtureURL.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(fixtureURL.hostname) || fixtureURL.username || fixtureURL.password) throw new Error('HTTP loopback fixture origin required');
const origin = fixtureURL.origin;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext(); const page = await context.newPage();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.goto(origin); await page.getByRole('button', { name: 'Connect browser', exact: true }).click();
  await expect(page.getByText('FIXTURE · no live Cloudflare proof', { exact: true })).toBeVisible();
  cookies = await context.cookies(); expect(cookies.every(c => c.httpOnly)).toBe(true); await context.close();
});
test.beforeEach(async ({ page }) => {
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.context().addCookies(cookies); await page.goto('/');
  await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toBeVisible();
});
test('shows paired metadata, declared proof and notes without automatically opening live sites', async ({ page }) => {
  await expect(page.getByRole('article', { name: 'Before storefront', exact: true })).toContainText('https://before.example.test');
  await expect(page.getByRole('article', { name: 'After storefront', exact: true })).toContainText('https://after.example.test');
  await page.getByText('Expected proof & prerequisites', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Expected proof', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Presenter notes' })).toContainText('Architecture question');
  await expect(page.getByText('Paired-tab mode. Use the tab link above.')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Use paired tabs', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('iframe')).toHaveCount(0); await expect(page.getByRole('button', { name: 'Start scenario', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await page.getByRole('button', { name: 'Refresh local view' }).focus(); await page.keyboard.press('Tab');
  await expect(page.getByRole('combobox', { name: 'Scenario', exact: true })).toBeFocused();
});
test('validates hard limits and performs local-only dry run while keeping browser prerequisites visible', async ({ page }) => {
  let starts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/runs')) starts++; });
  await page.getByText('Advanced limits', { exact: true }).click();
  await page.getByLabel('Request cap', { exact: true }).fill('101');
  await expect(page.getByRole('button', { name: 'Dry run', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('hard limits');
  await page.getByLabel('Request cap', { exact: true }).fill('30');
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByText('Local plan valid. No network calls. Not verified.', { exact: true })).toBeVisible(); expect(starts).toBe(0);
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('waiting-room');
  await expect(page.getByText('No runner session records available.', { exact: true })).toBeVisible();
  await expect(page.getByText('Preview alone never proves admission or readiness.', { exact: true })).toBeVisible();
  expect(starts).toBe(0);
  await expect(page.getByRole('button', { name: 'Start scenario', exact: true })).toBeDisabled();
  await page.getByText('Expected proof & prerequisites', { exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Expected proof', exact: true }).getByRole('heading', { name: 'Waiting Room', exact: true })).toBeVisible();
});
test('starts one bounded job despite duplicate clicks and retains the complete fixture comparison', async ({ page }, testInfo) => {
  let starts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/runs')) starts++; });
  await page.getByLabel('Allow bounded demo traffic to this lab').check();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Start scenario', exact: true }).dblclick();
  const job = (await (await created).json()).run;
  await expect(page.getByText(job.id, { exact: true })).toBeVisible();
  await expect(page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Scripted HTTP observations' }).locator('tbody tr')).toHaveCount(4);
  await expect(page.getByRole('article', { name: 'Before storefront', exact: true })).toContainText('HTTP 200');
  await expect(page.getByRole('article', { name: 'After storefront', exact: true })).toContainText('HTTP 403');
  await expect(page.getByRole('link', { name: 'Open captured comparison report ↗' })).toBeVisible(); expect(starts).toBe(1);
  await page.getByRole('button', { name: 'Refresh local view' }).click();
  await expect(page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true })).toBeVisible(); expect(starts).toBe(1);
  await page.screenshot({ path: testInfo.outputPath('command-center.png'), fullPage: true });
});
test('supports keyboard activation and owned stop without losing partial observations', async ({ page }) => {
  await page.getByLabel('Allow bounded demo traffic to this lab').focus(); await page.keyboard.press('Space');
  await expect(page.getByLabel('Allow bounded demo traffic to this lab')).toBeChecked();
  const start = page.getByRole('button', { name: 'Start scenario', exact: true });
  // focus() does not wait for a disabled control to become actionable.
  await expect(start).toBeEnabled(); await start.focus(); await expect(start).toBeFocused();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
  await page.keyboard.press('Enter'); expect((await created).status()).toBe(202);
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop run', exact: true }).click();
  await expect(page.getByText('Cancelled · observations retained', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeDisabled();
});
test('keeps frame protections and supplies paired tabs when embedding is refused', async ({ page }) => {
  let views = 0;
  await page.context().route('https://*.example.test/**', async route => { views++; await route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': "frame-ancestors 'none'" }, body: '<!doctype html><h1>Fixture storefront: frame protection kept</h1>' }); });
  await page.getByLabel('Allow manual storefront view traffic').check(); await page.getByRole('button', { name: 'Load inline views' }).click();
  await expect(page.locator('iframe')).toHaveCount(2);
  await expect(page.getByText('If this pane is blocked by frame policy, use paired tabs.')).toHaveCount(2);
  await page.getByRole('button', { name: 'Use paired tabs' }).click(); await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByText('Paired-tab mode. Use the tab link above.')).toHaveCount(2);
  const link = page.getByRole('link', { name: 'Open Before in tab ↗' }); await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]); await popup.waitForLoadState('domcontentloaded'); expect(popup.url()).toBe('https://before.example.test/'); await popup.close();
  expect(views).toBeGreaterThan(0);
});
test('shows the shared Images dependency as declared read-only without starting traffic', async ({ page }) => {
  let starts = 0; let targets = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/runs')) starts++; });
  await page.context().route('https://*.example.test/**', async route => { targets++; await route.abort(); });
  // UI-only fixture: server projection and live dependency checks have separate tests.
  await page.route('**/api/catalog', async route => {
    const response = await route.fetch(); const catalog = await response.json();
    await route.fulfill({ response, json: { ...catalog, imageVariant: {
      source: 'existing-public-readonly', id: 'public', readOnly: true, declared: true, liveVerified: false,
      options: { fit: 'scale-down', width: 1366, height: 768, metadata: 'none' }, neverRequireSignedURLs: false,
    } } });
  });
  const refresh = async () => {
    const received = page.waitForResponse(response => response.url().endsWith('/api/catalog') && response.request().method() === 'GET');
    await page.getByRole('button', { name: 'Refresh local view' }).click();
    expect(await (await received).finished()).toBeNull();
  };
  await refresh();
  await page.getByText('Images dependency', { exact: true }).click();
  const panel = page.getByRole('region', { name: 'Images variant declaration' });
  await expect(panel).toContainText('Shared · read-only'); await expect(panel).toContainText('Not owned by this lab');
  await expect(panel).toContainText('Declared configuration only. Not a live readback.');
  await expect(panel.locator('p.hostname')).toHaveText('public');
  await refresh();
  await expect(panel).toContainText('Shared · read-only');
  await expect(page.locator('iframe')).toHaveCount(0); expect(starts).toBe(0); expect(targets).toBe(0);
  await page.unrouteAll({ behavior: 'wait' });
});
test('keeps text status and usable layout with narrow view and reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await expect(page.getByRole('heading', { name: 'Cloudflare Command Center', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry run', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
