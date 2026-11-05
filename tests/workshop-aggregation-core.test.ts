import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '../scenarios/catalog.js';
import { runWorkshopAggregate, runSequenceSlot, type AggregateOptions, type SequenceDriver } from '../packages/demo-core/src/workshop-aggregation.js';
import { BudgetLedger, limitsFor } from '../packages/demo-core/src/budget.js';
import { runWafCustom } from '../packages/demo-core/src/waf-custom.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { InterviewTimeline } from '../packages/demo-core/src/interview-timeline.js';
import { evaluateDeployment } from '../packages/demo-core/src/deployment-verification-core.js';
import type { DoctorReport } from '../packages/demo-core/src/doctor.js';
import { TestClock } from './fixtures/clock.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { captureFor, meteredDriver, digest, deploymentFixture, time, end } from './workshop-core-fixtures.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'aggregation-core-')); roots.push(value); return value; }
const drivers = () => Object.fromEntries(CATALOG.map(m => [m.id, meteredDriver(m.id)])) as AggregateOptions['drivers'];
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe('aggregate-runner core', () => {
  it('attempts all eleven in fixed catalog order without changing setup', async () => {
    const order: string[] = [];
    const result = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: drivers(), onItem: i => { order.push(i.scenarioId); } });
    expect(order).toEqual(CATALOG.map(m => m.id)); expect(result.items).toHaveLength(11);
    expect(result.requestsUsed).toBe(11); expect(result.allRequiredVerified).toBe(true); expect(result.cleanRehearsal).toBe(false);
  });
  it('runs doctor, deployment, catalog and a concrete nested interview in order', async () => {
    const clock = new TestClock(); const order: string[] = []; const f = deploymentFixture();
    const p = runWorkshopAggregate({ command: 'rehearsal', mode: 'fixture', clock, drivers: drivers(),
      onItem: i => { order.push(i.scenarioId); },
      doctor: { limits: {}, run: async ({ parent, signal }) => {
        order.push('doctor'); (await parent.acquire(signal))();
        const report: DoctorReport = { schemaVersion: 1, mode: 'fixture', scope: 'catalog', observedAt: time, labId: f.config.labId, accountId: f.config.accountId, zoneId: f.config.zoneId, checks: [{ id: 'fixture-input', state: 'passed', detail: 'Synthetic doctor fixture', correctiveAction: '' }], catalog: CATALOG.map(m => ({ id: m.id, product: m.product, implemented: true, state: 'available', reason: 'Synthetic fixture' })), observedOwnedResources: [], preflightReady: true, claims: { deploymentVerified: false, interviewVerified: false, workshopVerified: false, mitigationVerified: false }, requestsUsed: 1, durationMs: 0 };
        return report;
      } },
      deploymentCheck: { limits: {}, minimumRequests: 1, run: async ({ parent, signal }) => {
        order.push('deployment'); (await parent.acquire(signal))();
        const report = evaluateDeployment({ mode: 'fixture', expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, observedAt: end, startedAt: time, beforeObservedAt: time, afterObservedAt: end }); report.requestsUsed = 1; return report;
      } },
      interviewCheck: { minimumRequests: 4, run: async (context, captures) => {
        order.push('interview'); expect(captures).toHaveLength(11);
        return new InterviewTimeline({ mode: 'fixture', parent: context.parent, signal: context.signal, clock,
          storefronts: { run: async ({ parent, signal }) => { (await parent.acquire(signal))(); return { mode: 'fixture', deploymentVerified: true }; } },
          drivers: { 'waf-sqli': meteredDriver('waf-sqli'), 'rate-limit': meteredDriver('rate-limit'), 'waiting-room': meteredDriver('waiting-room') }, analyticsInput: () => [] }).run();
      } },
    });
    const flush = async () => { for (let i = 0; i < 400; i++) await Promise.resolve(); };
    await flush(); for (const ms of [45000, 60000, 60000, 75000, 60000]) { clock.advance(ms); await flush(); }
    const r = await p; expect(order).toEqual(['doctor', 'deployment', ...CATALOG.map(m => m.id), 'interview']);
    expect(r.requestsUsed).toBe(17); expect(r.interview?.durationMs).toBe(300000);
    expect(r.interview?.stages.at(-1)?.outcome).toBe('inconclusive'); expect(r.cleanRehearsal).toBe(false);
  });
  it('keeps unavailable, contrary, missing and intentional skipped outcomes', async () => {
    const d = drivers(); delete d.bot; d['waf-xss'] = meteredDriver('waf-xss', 'failed'); d.turnstile = meteredDriver('turnstile', 'inconclusive'); d.access = meteredDriver('access', 'skipped');
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: d });
    expect(r.items.find(i => i.scenarioId === 'bot')?.outcome).toBe('unavailable');
    expect(r.items.find(i => i.scenarioId === 'waf-xss')?.outcome).toBe('failed'); expect(r.items).toHaveLength(11); expect(r.exitCode).toBe(1);
  });
  it('runs doctor before rehearsal and blocks every item after failed doctor', async () => {
    const called = vi.fn(); const r = await runWorkshopAggregate({ command: 'rehearsal', mode: 'fixture', drivers: { 'waf-custom': { run: called } }, doctor: { limits: {}, run: async () => { throw new Error('secret-canary'); } } });
    expect(called).not.toHaveBeenCalled(); expect(r.items).toHaveLength(11); expect(r.items.every(i => i.outcome === 'unavailable')).toBe(true); expect(r.cleanRehearsal).toBe(false); expect(JSON.stringify(r)).not.toContain('secret-canary');
  });
  it('shares budgets across scenarios and leaves unfittable work skipped', async () => {
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: drivers(), limits: { requests: 4 } });
    expect(r.requestsUsed).toBe(4); expect(r.items.slice(4).every(i => i.outcome === 'skipped')).toBe(true); expect(r.exitCode).toBe(1);
  });
  it('isolates bad evidence, budget bypass, cooldowns and cleanup failures', async () => {
    const d = drivers();
    d.bot = { nextEligibleAt: 100, run: vi.fn() };
    d.turnstile = { minimumRequests: 0, run: async () => captureFor('turnstile') };
    d.access = { minimumRequests: 0, run: async ({ parent }) => { (await parent.acquire())(); const c = captureFor('access'); c.report.result.cleanup = 'incomplete'; return c; } };
    d['api-shield'] = { minimumRequests: 0, run: async ({ parent }) => { (await parent.acquire())(); const c = captureFor('api-shield'); c.artifacts[0]!.payload = { ...c.artifacts[0]!.payload, secret: 'private' } as never; return c; } };
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', clock: new TestClock(), drivers: d });
    expect(r.items.find(i => i.scenarioId === 'bot')?.reason).toContain('cooldown');
    for (const id of ['turnstile', 'access', 'api-shield']) expect(r.items.find(i => i.scenarioId === id)?.outcome).toBe('inconclusive');
  });
  it('keeps saved evidence separate and never saves fixture successes as fallback', async () => {
    const path = root(); const store = new ReportStore(path, join(path, '.evidence')); const c = captureFor('waf-sqli', 'live'); store.save(c.report, c.artifacts);
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: {}, store, savedRunIds: { 'waf-sqli': c.report.result.runId }, currentRevisions: { 'waf-sqli': { releaseDigest: digest, observedConfigDigest: digest } } });
    expect(r.items[0]).toMatchObject({ outcome: 'unavailable', fallback: { label: 'SAVED EVIDENCE', historicalOnly: false } }); expect(r.allRequiredVerified).toBe(false);
    const save = vi.spyOn(store, 'save'); await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: drivers(), store }); expect(save).not.toHaveBeenCalled();
    const historical = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: {}, store, savedRunIds: { 'waf-sqli': c.report.result.runId } });
    expect(historical.items[0]!.fallback?.historicalOnly).toBe(true);
  });
  it('keeps cancelled contradictions and stops later scenario dispatch', async () => {
    const abort = new AbortController(); const d = drivers();
    d['waf-sqli'] = { minimumRequests: 0, run: async ({ parent }) => { (await parent.acquire())(); abort.abort(); return captureFor('waf-sqli', 'fixture', 'failed'); } };
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: d, signal: abort.signal });
    expect(r.items[0]!.outcome).toBe('failed'); expect(r.items[0]!.capture?.report.result.contradictions).toHaveLength(1); expect(r.requestsUsed).toBe(1); expect(r.exitCode).toBe(130); expect(r.items.slice(1).every(i => i.outcome === 'skipped')).toBe(true);
  });
  it('fences hanging adapters at their slot end while retaining cleanup reserve', async () => {
    const clock = new TestClock(); const parent = new BudgetLedger({ scope: 'all', clock }); let context: Parameters<SequenceDriver['run']>[0] | undefined;
    try {
      const p = runSequenceSlot(parent, limitsFor('scenario', { maxRuntimeMs: 2000, cleanupMs: 500 }), async c => { context = c; await new Promise(() => {}); });
      await tick(); clock.advance(1500); expect(context!.signal.aborted).toBe(true); expect(context!.parent.signal.aborted).toBe(false);
      clock.advance(500); expect(await p).toEqual({ state: 'timeout' }); await expect(context!.parent.acquire()).rejects.toThrow();
    } finally { parent.stop(); }
  });
  it('runs the existing concrete WAF runner through the shared parent budget', async () => {
    const path = root(); const f = demoLabFixture(path); const observedOwnedResources = new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
    const r = await runWorkshopAggregate({ command: 'all', mode: 'fixture', drivers: { 'waf-custom': { minimumRequests: 12, run: context => runWafCustom({ ...context, projectRoot: path, config: f.config, credentials: f.credentials, mode: 'fixture', observedOwnedResources, dispatch: f.dispatch }) } } });
    const item = r.items.find(i => i.scenarioId === 'waf-custom')!;
    expect(item.outcome).toBe('verified'); expect(item.capture!.report.result.requestsUsed).toBe(r.requestsUsed); expect(r.requestsUsed).toBeGreaterThan(10);
    expect(f.calls.every(c => c.method === 'GET' || c.url.endsWith('/graphql'))).toBe(true);
  });
});
