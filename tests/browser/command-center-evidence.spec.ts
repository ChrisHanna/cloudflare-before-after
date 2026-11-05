import { test, expect, type BrowserContext } from '@playwright/test';
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
function fixtureOrigin(baseURL?: string) {
  const url = new URL(baseURL ?? 'http://127.0.0.1:4173');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('HTTP loopback fixture baseURL required');
  return url.origin;
}
test.beforeAll(async ({ browser, baseURL }) => {
  const origin = fixtureOrigin(baseURL);
  const context = await browser.newContext(); const page = await context.newPage();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.goto(origin); await page.getByRole('button', { name: 'Connect browser', exact: true }).click();
  await page.locator('details[aria-label="Local run history"] > summary').click();
  await expect(page.getByRole('combobox', { name: 'Recent runs', exact: true })).toBeVisible(); cookies = await context.cookies(); await context.close();
});
test.beforeEach(async ({ page, baseURL }) => {
  const origin = fixtureOrigin(baseURL);
  await page.context().route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await page.context().addCookies(cookies); await page.goto('/');
  await page.locator('details[aria-label="Local run history"] > summary').click();
  await page.locator('details > summary').filter({ hasText: /^Policy inspection$/ }).click();
  await page.locator('details > summary').filter({ hasText: /^Evidence counts & sources$/ }).click();
  await expect(page.getByRole('combobox', { name: 'Recent runs', exact: true })).toBeVisible();
  const journals = await (await page.request.get('/api/journal-runs')).json();
  expect(journals.runs).toHaveLength(1);
  await page.getByRole('combobox', { name: 'Recent runs', exact: true }).selectOption(journals.runs[0].id);
  await expect(page.getByText('CLI-owned · read-only. Stop rights remain with its owner.', { exact: true })).toBeVisible();
});
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: 'wait' }); });
test('shows actual CLI capture IDs and origin/action counts without taking stop rights', async ({ page }) => {
  const journals = await (await page.request.get('/api/journal-runs')).json(); const id = journals.runs[0].actualRunId;
  const run = (await (await page.request.get(`/api/journal-runs/${id}`)).json()).run;
  expect(run.result.report.result.runId).toBe(id);
  const before = page.getByRole('article', { name: 'Before evidence counts', exact: true });
  const after = page.getByRole('article', { name: 'After evidence counts', exact: true });
  await expect(before.locator('[data-count="Requests"]')).toHaveText('2');
  await expect(before.locator('[data-count="Origin received"]')).toHaveText('2');
  await expect(after.locator('[data-count="Origin received"]')).toHaveText('1');
  await expect(after.locator('[data-count="Origin absent"]')).toHaveText('1');
  await expect(after.locator('[data-count="Edge events"]')).toHaveText('1');
  await expect(after.locator('[data-count="Rule IDs"]')).toHaveText('1');
  await expect(before.locator('[data-count="Edge events"]')).toHaveText('Unknown');
  await expect(after).toContainText('sampling unknown'); await expect(after).toContainText('block'); await expect(after).toContainText('c'.repeat(32));
  await expect(page.getByRole('button', { name: 'Stop run', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Run evidence', exact: true })).toContainText(id);
  await after.locator('summary').click(); const link = after.getByRole('link').first(); await expect(link).toHaveAttribute('href', new RegExp(`/api/journal-runs/${id}/evidence/`));
  let starts = 0; page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/runs')) starts++; });
  await page.getByRole('button', { name: 'Refresh local view' }).click();
  await page.reload(); await page.locator('details > summary').filter({ hasText: /^Evidence counts & sources$/ }).click();
  await expect(page.getByRole('region', { name: 'Run evidence', exact: true })).toBeVisible(); expect(starts).toBe(0);
});
test('policy-panels show captured versus desired state, unknown product settings and safe manual inspection', async ({ page }) => {
  const panel = page.getByRole('region', { name: 'Policy inspection', exact: true });
  await expect(panel).toContainText('Desired · unverified'); await expect(panel).toContainText('Captured After readback');
  await expect(panel).toContainText('fixture'); await expect(panel).toContainText('block'); await expect(panel).toContainText('after.example.test');
  await expect(panel).toContainText('Affected policy readiness blocked'); await expect(panel).toContainText('Other Before policies: Unknown');
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('waiting-room');
  await expect(panel).toContainText('Waiting Room'); await expect(panel).toContainText('Session duration'); await expect(panel).toContainText('Capacity');
  await expect(panel).toContainText('Authorized readback unavailable');
  const link = panel.getByRole('link', { name: 'Inspect in Cloudflare ↗' }); await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.context().route('https://dash.cloudflare.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><h1>Fixture inspection target, not a real Cloudflare login</h1>' }));
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]); await popup.waitForLoadState('domcontentloaded');
  const url = new URL(popup.url()); expect(url.origin).toBe('https://dash.cloudflare.com'); expect([...url.searchParams.keys()]).toEqual(['to']); expect(url.username + url.password).toBe(''); await popup.close();
  await expect(page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true })).toBeVisible();
});
for (const module of ['waf-sqli', 'waf-xss'] as const) test(`waf-signatures: ${module} uses the shared bounded UI runner and labels its custom rule`, async ({ page }) => {
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption(module);
  await page.getByLabel('Allow bounded demo traffic to this lab').check();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Start scenario', exact: true }).click(); const job = (await (await created).json()).run;
  await expect(page.getByText(job.id, { exact: true })).toBeVisible();
  await expect(page.getByText('FIXTURE evidence — not a live Cloudflare result', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Scripted HTTP observations', exact: true }).locator('tbody tr')).toHaveCount(4);
  const panel = page.getByRole('region', { name: 'Policy inspection', exact: true }); await expect(panel).toContainText('Custom WAF rules; not managed detection');
  await expect(panel).toContainText((module === 'waf-sqli' ? 'd' : 'e').repeat(32));
  await page.locator('details > summary').filter({ hasText: /^Evidence counts & sources$/ }).click();
  await expect(page.getByRole('article', { name: 'After evidence counts', exact: true }).locator('[data-count="Origin absent"]')).toHaveText('1');
});
test('rate-limit shows reconciled admitted/mitigated signals, actual key settings and cooldown without reset controls', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('rate-limit'); await page.getByLabel('Allow bounded demo traffic to this lab').check();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Start scenario', exact: true }).click(); const job = (await (await created).json()).run;
  await expect(page.getByText(job.id, { exact: true })).toBeVisible(); const summary = page.getByRole('region', { name: 'Rate signal counts', exact: true });
  await expect(summary).toContainText('Admitted: 3 · Mitigated: 1 · Unknown: 0'); await expect(summary).toContainText('Cooldown until:'); await expect(summary).toContainText('No counter reset was sent.');
  const panel = page.getByRole('region', { name: 'Policy inspection', exact: true }); await expect(panel).toContainText('cf.colo.id + ip.src'); await expect(panel).toContainText('Counting window seconds');
  await page.locator('details > summary').filter({ hasText: /^Evidence counts & sources$/ }).click();
  const after = page.getByRole('article', { name: 'After evidence counts', exact: true }); await expect(after.locator('[data-count="Requests"]')).toHaveText('5'); await expect(after.locator('[data-count="Origin received"]')).toHaveText('4'); await expect(after.locator('[data-count="Origin absent"]')).toHaveText('1');
});
test('bot-policy exposes the declared client and actual score/action without calling custom enforcement native detection', async ({ page }) => {
  await page.getByRole('combobox', { name: 'Scenario', exact: true }).selectOption('bot'); await page.getByLabel('Allow bounded demo traffic to this lab').check();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/runs'));
  await page.getByRole('button', { name: 'Start scenario', exact: true }).click(); const job = (await (await created).json()).run;
  await expect(page.getByText(job.id, { exact: true })).toBeVisible(); const summary = page.getByRole('region', { name: 'Bot observations', exact: true });
  await expect(summary).toContainText('CloudflareLabBot/1.0'); await expect(summary).toContainText('Score: 5 · Action: block · Classification: automated'); await expect(summary).toContainText('No fingerprint evasion or assumed blocking.');
  await expect(page.getByRole('region', { name: 'Policy inspection', exact: true })).toContainText('Custom WAF rule using Bot Management score');
});
test('renders stale and sampled source states without replacing unknown with zero', async ({ page }) => {
  await page.route('**/api/journal-runs/*', async route => {
    const response = await route.fetch(); const body = await response.json();
    if (body.run?.evidence) for (const role of body.run.evidence.roles) {
      for (const source of role.sources) source.state = 'stale';
      if (role.role === 'after') { role.sources[2].state = 'sampled'; role.sources[2].sampling = 'sampled'; }
    }
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh local view' }).click();
  const before = page.getByRole('article', { name: 'Before evidence counts', exact: true }); const after = page.getByRole('article', { name: 'After evidence counts', exact: true });
  await expect(before).toContainText('stale'); await expect(after).toContainText('sampling sampled');
  await expect(before.locator('[data-count="Edge events"]')).toHaveText('Unknown');
  await expect(after.locator('[data-count="Origin absent"]')).toHaveText('1');
});
