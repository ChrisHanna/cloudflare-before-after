import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InterviewTimeline, INTERVIEW_STAGES, type InterviewOptions } from '../packages/demo-core/src/interview-timeline.js';
import type { AnalyticsInput } from '../packages/demo-core/src/analytics.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import { meteredDriver, time, end, digest } from './workshop-core-fixtures.js';
import { TestClock } from './fixtures/clock.js';
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function options(clock: TestClock): InterviewOptions {
  return { mode: 'fixture', clock, storefronts: { run: async ({ parent, signal }) => { (await parent.acquire(signal))(); return { mode: 'fixture', deploymentVerified: true }; } },
    drivers: { 'waf-sqli': meteredDriver('waf-sqli'), 'rate-limit': meteredDriver('rate-limit'), 'waiting-room': meteredDriver('waiting-room') },
    analyticsInput: captures => {
      const c = captures.at(-1)!; const r = c.report.result;
      const scope: AnalyticsInput['scope'] = { runId: r.runId, scenarioId: r.scenarioId, mode: c.report.mode, releaseDigest: digest, window: { start: time, end }, hosts: { before: 'before.example.test', after: 'after.example.test' } };
      return [{ scope, observations: c.artifacts.flatMap(a => 'status' in a.payload ? [a.payload] : []), artifacts: [...c.artifacts, ...(['before', 'after'] as const).map(role => makeArtifact({ id: randomUUID(), mode: c.report.mode, runId: r.runId, scenarioId: r.scenarioId, targetRole: role, requestId: null, observedAt: end, source: 'origin', payload: { healthy: true, complete: true, windowStart: time, watermark: end, producerSequence: 1, gaps: [] } }).artifact)],
        sources: (['before', 'after'] as const).flatMap(role => (['http', 'origin', 'cloudflare'] as const).map(source => ({ runId: r.runId, scenarioId: r.scenarioId, mode: c.report.mode, role, source, api: source, state: 'available', observedAt: end, window: scope.window, sampling: 'complete', complete: true, ingestionDelayMs: 0 }))) }];
    } };
}
async function finish(clock: TestClock) {
  await flush();
  for (const ms of [45000, 60000, 60000, 75000, 60000]) { clock.advance(ms); await flush(); }
}
describe('interview-scheduler core fixed deadlines', () => {
  it('uses the five approved slots and a shared 100-request parent', async () => {
    const clock = new TestClock(); const o = options(clock); const views: { id: string; remainingMs: number }[] = [];
    o.onStage = v => { views.push(v); }; const timeline = new InterviewTimeline(o); const p = timeline.run();
    await finish(clock); const r = await p;
    expect(r.stages.map(s => s.id)).toEqual(INTERVIEW_STAGES.map(s => s.id));
    expect(r.stages.map(s => s.startedMs)).toEqual([0, 45000, 105000, 165000, 240000]);
    expect(views[3]).toMatchObject({ id: 'waiting-room', remainingMs: 75000 });
    expect(r.durationMs).toBe(300000); expect(r.requestsUsed).toBe(4); expect(r.exitCode).toBe(0); expect(r.interviewVerified).toBe(false);
    expect(r.stages.at(-1)?.analytics?.label).toBe('FIXTURE');
    await expect(timeline.run()).rejects.toThrow('single-use');
  });
  it('advance changes presentation without resetting later absolute deadlines', async () => {
    const clock = new TestClock(); const timeline = new InterviewTimeline(options(clock)); const p = timeline.run();
    await flush(); clock.advance(10000); timeline.advance(); await flush();
    clock.advance(95000); await flush(); clock.advance(60000); await flush(); clock.advance(75000); await flush(); clock.advance(60000); await flush();
    const r = await p; expect(r.stages[1]!.startedMs).toBe(10000); expect(r.stages[1]!.finishedMs).toBe(105000); expect(r.requestsUsed).toBe(4); expect(r.durationMs).toBe(300000);
  });
  it('ends a hanging stage, fences late dispatch, and retains later agenda', async () => {
    const clock = new TestClock(); const o = options(clock); let stopped = false;
    o.drivers['waf-sqli'] = { run: async ({ signal }) => { signal.addEventListener('abort', () => { stopped = true; }, { once: true }); await new Promise(() => {}); throw new Error('unreachable'); } };
    o.fallbackAvailable = () => true;
    const p = new InterviewTimeline(o).run(); await finish(clock); const r = await p;
    expect(stopped).toBe(true); expect(r.stages[1]).toMatchObject({ outcome: 'inconclusive', fallbackLabel: 'SAVED EVIDENCE' }); expect(r.stages[2]!.startedMs).toBe(105000); expect(r.interviewVerified).toBe(false); expect(r.exitCode).toBe(1);
  });
  it('stops without dispatching later stages and preserves cancellation results', async () => {
    const clock = new TestClock(); const o = options(clock); const timeline = new InterviewTimeline(o); const p = timeline.run(); await flush(); timeline.stop(); await flush();
    const r = await p; expect(r.requestsUsed).toBe(1); expect(r.stages.slice(1).every(s => s.outcome === 'skipped')).toBe(true); expect(r.exitCode).toBe(130); expect(r.interviewVerified).toBe(false);
  });
  it('keeps contradictions after cancellation during a scenario', async () => {
    const clock = new TestClock(); const o = options(clock); let timeline!: InterviewTimeline;
    const original = meteredDriver('waf-sqli', 'failed');
    o.drivers['waf-sqli'] = { minimumRequests: 0, run: async context => { const r = await original.run(context); timeline.stop(); return r; } };
    timeline = new InterviewTimeline(o); const p = timeline.run(); await flush(); timeline.advance(); await flush(); const r = await p;
    expect(r.stages[1]!.outcome).toBe('failed'); expect(r.stages[1]!.capture!.report.result.contradictions).toHaveLength(1);
  });
  it('keeps exhausted budgets non-clean and never invokes hidden analytics probes', async () => {
    const clock = new TestClock(); const o = options(clock); o.limits = { requests: 2 };
    const analytics = vi.fn(o.analyticsInput); o.analyticsInput = analytics;
    const p = new InterviewTimeline(o).run(); await finish(clock); const r = await p;
    expect(r.requestsUsed).toBeLessThanOrEqual(2); expect(r.interviewVerified).toBe(false); expect(r.exitCode).toBe(1); expect(analytics).toHaveBeenCalledOnce();
    // Analytics may explain the completed WAF evidence, without passing the interview.
    expect(r.stages.at(-1)!.outcome).toBe('verified'); expect(r.stages[3]!.outcome).toBe('skipped');
  });
  it('rejects invalid scenario allocations and cooldowns before any stage traffic', async () => {
    const clock = new TestClock(); const o = options(clock);
    o.drivers['waf-sqli']!.limits = { requests: 101 }; o.drivers['rate-limit']!.nextEligibleAt = 300000;
    const waf = vi.spyOn(o.drivers['waf-sqli']!, 'run'); const rate = vi.spyOn(o.drivers['rate-limit']!, 'run');
    const p = new InterviewTimeline(o).run(); await finish(clock); const r = await p;
    expect(waf).not.toHaveBeenCalled(); expect(rate).not.toHaveBeenCalled();
    expect(r.stages[1]!.outcome).toBe('unavailable'); expect(r.stages[2]!.outcome).toBe('unavailable'); expect(r.stages).toHaveLength(5);
  });
  it('rejects a Waiting Room transition plan that cannot fit 75 seconds', async () => {
    const clock = new TestClock(); const o = options(clock); o.drivers['waiting-room']!.minimumWorkMs = 75000;
    const call = vi.spyOn(o.drivers['waiting-room']!, 'run'); const p = new InterviewTimeline(o).run(); await finish(clock); const r = await p;
    expect(call).not.toHaveBeenCalled(); expect(r.stages[3]!.outcome).toBe('unavailable'); expect(r.interviewVerified).toBe(false);
  });
});
