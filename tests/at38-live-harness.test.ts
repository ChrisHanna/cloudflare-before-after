import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createT38Plan, executeT38Plan, t38PlanDigest, t38SourceDigest, type T38Authorization } from '../packages/demo-core/src/t38-at11-14-harness.js';
import { controlFixture } from './fixtures/control.js';
const sourceRoot = '/mnt/c/users/NotAPC/Desktop/cloudflare_before_after';
const step = { command: 'waf-custom' as const, requests: 30, maxRuntimeSeconds: 60 };
const authorize = (plan: ReturnType<typeof createT38Plan>): T38Authorization => ({ liveOptIn: true, approvedDigest: t38PlanDigest(plan), confirmation: `RUN AT11-14 ${t38PlanDigest(plan)}` });
describe('T38 exact-plan harness executes real CLI only past its local gate', () => {
  it.each(['absent', 'no-opt-in', 'wrong-digest', 'wrong-confirmation', 'expired', 'future', 'config-drift', 'source-drift'] as const)('zero credential/transport/browser calls on %s', async fault => {
    const f = controlFixture(); const credentials = vi.fn(() => f.credentials); const dispatch = vi.fn(f.dispatch); const launch = vi.fn(async () => { throw new Error('Forbidden browser'); });
    const now = Date.now(); const plan = createT38Plan(f.root, f.config, 'live', [step], now, sourceRoot); const authorization = authorize(plan); const config = structuredClone(f.config);
    if (fault === 'no-opt-in') authorization.liveOptIn = false;
    if (fault === 'wrong-digest') authorization.approvedDigest = '0'.repeat(64);
    if (fault === 'wrong-confirmation') authorization.confirmation = 'yes';
    if (fault === 'config-drift') config.environments[0].releaseDigest = 'f'.repeat(64);
    if (fault === 'source-drift') { plan.sourceDigest = '0'.repeat(64); Object.assign(authorization, authorize(plan)); }
    try {
      const result = await executeT38Plan({ plan, config, ...(fault === 'absent' ? {} : { authorization }), sourceRoot, now: fault === 'expired' ? now + 900001 : fault === 'future' ? now - 1 : now, dependencies: { projectRoot: f.root, credentials, dispatch, workshop: { browser: { launch } } } });
      expect(result.status).toBe('blocked'); expect(result.steps).toEqual([]); expect(result.acceptancePassed).toBe(false);
      expect(credentials).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
      expect(existsSync(`${f.config.evidenceDirectory}/runs`)).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('authorized fixture orchestration calls actual CLI, collectors and immutable report storage', async () => {
    const f = controlFixture(); const now = Date.now(); const plan = createT38Plan(f.root, f.config, 'fixture', [step, step], now, sourceRoot);
    try {
      const result = await executeT38Plan({ plan, config: f.config, authorization: authorize(plan), sourceRoot, now, dependencies: { projectRoot: f.root, credentials: () => f.credentials, dispatch: f.dispatch } });
      expect(result.status).toBe('incomplete'); expect(result.acceptancePassed).toBe(false); expect(result.steps).toHaveLength(2);
      expect(new Set(result.steps.map(s => s.runId)).size).toBe(2);
      for (const step of result.steps) { expect(step.exitCode).toBe(0); expect(step.mode).toBe('fixture'); expect(step.requestsUsed).toBeGreaterThan(0); expect(step.outcome).toBe('verified'); expect(existsSync(step.reportPath!)).toBe(true); }
      for (const secret of Object.values(f.credentials)) expect(JSON.stringify(result)).not.toContain(secret);
      expect(f.calls.length).toBe(result.steps.reduce((n, s) => n + s.requestsUsed!, 0));
      expect(plan.sourceDigest).toBe(t38SourceDigest(sourceRoot));
    } finally { await f.cleanup(); }
  });
  it('stops at missing evidence instead of promoting a fixture or running later steps', async () => {
    const f = controlFixture(); const plan = createT38Plan(f.root, f.config, 'fixture', [step, step], Date.now(), sourceRoot);
    try {
      const result = await executeT38Plan({ plan, config: f.config, authorization: authorize(plan), sourceRoot, dependencies: { projectRoot: f.root, credentials: () => f.credentials, dispatch: async (url, init) => new URL(url).pathname.endsWith('/graphql') ? Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: [] }] } } }) : f.dispatch(url, init) } });
      expect(result.steps).toHaveLength(1); expect(result.steps[0]!.exitCode).toBe(1); expect(result.steps[0]!.outcome).toBe('inconclusive'); expect(result.acceptancePassed).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('rejects arbitrary commands, excessive caps and unknown plan fields', async () => {
    const f = controlFixture();
    try {
      expect(() => createT38Plan(f.root, f.config, 'live', Array(4).fill({ ...step, requests: 100 }), Date.now(), sourceRoot)).toThrow('aggregate caps');
      expect(() => createT38Plan(f.root, f.config, 'live', [{ ...step, command: 'lab apply' as 'waf-custom' }], Date.now(), sourceRoot)).toThrow();
      const plan = createT38Plan(f.root, f.config, 'live', [step], Date.now(), sourceRoot);
      const result = await executeT38Plan({ plan: { ...plan, repair: true }, config: f.config, authorization: authorize(plan), sourceRoot, dependencies: { projectRoot: f.root } });
      expect(result.status).toBe('blocked'); expect(result.steps).toEqual([]);
    } finally { await f.cleanup(); }
  });
});
