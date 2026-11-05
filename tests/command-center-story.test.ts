import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { CatalogSchema, type Catalog, type Job } from '../apps/command-center/src/api.js';
import { ImpactPanel, PaneResult } from '../apps/command-center/src/ImpactPanel.js';
import { StoryPanel } from '../apps/command-center/src/StoryPanel.js';
import { TestLibrary, isReady } from '../apps/command-center/src/TestLibrary.js';
import { controlFixture } from './fixtures/control.js';
const fixtures: ReturnType<typeof controlFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
async function catalog(): Promise<Catalog> {
  const f = controlFixture(); fixtures.push(f); await f.login();
  return CatalogSchema.parse(await (await f.request('/api/catalog')).json());
}
const job = (command: string): Job => ({
  id: 'job-1', command, status: 'succeeded',
  observations: [
    ...[200, 200, 200].map(status => ({ targetRole: 'before', status })),
    ...[200, 429, 429].map(status => ({ targetRole: 'after', status })),
  ],
  evidence: { roles: [
    { role: 'before', actions: [], originReceived: 3, originAbsent: 0, edgeEvents: 0 },
    { role: 'after', actions: [{ action: 'block', product: 'rate-limit', ruleId: 'abcdef1234567890' }], originReceived: 1, originAbsent: 2, edgeEvents: 2 },
  ] },
}) as unknown as Job;
const noop = () => {};
describe('Command Center story and per-test before/after views', () => {
  it('walks any selected test through problem, before, after and limits, and lists every test in the picker', async () => {
    const c = await catalog(); const scenario = c.scenarios.find(s => s.id === 'rate-limit')!;
    const html = renderToStaticMarkup(React.createElement(StoryPanel, { catalog: c, scenario, runnable: true, busy: false, active: false, onRun: noop, onSelect: noop }));
    expect(html).toContain(scenario.product); expect(html).toContain('Problem'); expect(html).toContain('Before'); expect(html).toContain('After'); expect(html).toContain('Limits');
    expect(html).toContain(`Run the ${scenario.product} test`); expect(html).toContain('Question to ask');
    for (const s of c.scenarios) expect(html).toContain(s.product);
  });
  it('marks tests that need setup, and does not offer to run them', async () => {
    const c = await catalog(); const bot = c.scenarios.find(s => s.id === 'bot')!;
    expect(isReady('bot')).toBe(false); expect(isReady('rate-limit')).toBe(true);
    const html = renderToStaticMarkup(React.createElement(StoryPanel, { catalog: c, scenario: bot, runnable: false, busy: false, active: false, onRun: noop, onSelect: noop }));
    expect(html).toContain('Needs setup in this lab'); expect(html).toContain(`${bot.product} \u2014 needs setup`);
    expect(html).not.toContain(`Run the ${bot.product} test`);
  });
  it('shows the overview when no test is selected and disables the picker while a run is active', async () => {
    const c = await catalog();
    const idle = renderToStaticMarkup(React.createElement(StoryPanel, { catalog: c, runnable: true, busy: false, active: false, onRun: noop, onSelect: noop }));
    expect(idle).toContain('Overview'); expect(idle).toContain('Run the headline demo');
    const running = renderToStaticMarkup(React.createElement(StoryPanel, { catalog: c, runnable: true, busy: false, active: true, onRun: noop, onSelect: noop }));
    expect(running).toMatch(/<select[^>]*disabled/); expect(running).toContain('A test is running');
  });
  it('renders DDoS as an explainer that never offers to generate attack traffic', async () => {
    const c = await catalog();
    const html = renderToStaticMarkup(React.createElement(TestLibrary, { catalog: c, job: null, busy: false, active: false, selected: 'waf-custom', onRun: noop, onSelect: noop, onStop: noop }));
    expect(html).toContain('never generates attack traffic');
    expect(html).not.toContain('Run this test</button>'.replace('Run this test', 'Run DDoS'));
    const cards = c.scenarios.filter(s => s.id !== 'ddos-evidence').length;
    expect(html.match(/Read the story|Story shown above/g)?.length).toBe(cards);
    expect(html).toContain('Story shown above');
  });
  it('reports what each site did in its own pane, and never claims a block for a served site', async () => {
    expect(renderToStaticMarkup(React.createElement(PaneResult, { job: null, role: 'after' }))).toContain('No test run yet');
    const j = job('rate-limit');
    const after = renderToStaticMarkup(React.createElement(PaneResult, { job: j, role: 'after' }));
    const before = renderToStaticMarkup(React.createElement(PaneResult, { job: j, role: 'before' }));
    expect(after).toContain('Cloudflare blocked the test request'); expect(after).toContain('HTTP 429'); expect(after).toContain('2 never reached the origin');
    expect(before).toContain('Served the test request'); expect(before).not.toContain('blocked');
  });
  it('tallies the real responses each site returned in the impact panel', () => {
    const html = renderToStaticMarkup(React.createElement(ImpactPanel, { job: job('rate-limit') }));
    expect(html).toContain('3 \u00d7 200'); expect(html).toContain('2 \u00d7 429, 1 \u00d7 200');
    expect(html).toContain('Blocked at the edge'); expect(html).toContain('Served');
  });
});
