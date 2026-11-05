import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runWafCustom } from '../packages/demo-core/src/waf-custom.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { desiredRateLimit, inspectRateLimit, provisionRateLimit, type RateSetupApi } from '../packages/demo-core/src/rate-policy.js';
import { planRateBurst, RateCooldown } from '../packages/demo-core/src/rate-window.js';
import { limitsFor } from '../packages/demo-core/src/budget.js';
import { observeRuntimeOwnership } from '../packages/demo-core/src/ownership.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import type { SetupContext } from '../packages/demo-core/src/deployment-apply.js';
import { TestClock } from './fixtures/clock.js';
import { controlFixture } from './fixtures/control.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };
function fixture() {
  const f = controlFixture(); const clock = new TestClock(); const base = Date.now(); const now = () => base + clock.now(); const lab = demoLabFixture(f.root, undefined, now);
  const run = (dispatch = lab.dispatch) => runWafCustom({ projectRoot: f.root, config: lab.config, credentials: lab.credentials, scenarioId: 'rate-limit', mode: 'fixture', dispatch, clock, now, limits: { requests: 30 }, ownershipPreflight: { minimumRequests: 12, run: (client, signal) => observeRuntimeOwnership(lab.config, lab.credentials.reader, client, signal) } });
  return { ...f, ...lab, clock, now, run };
}
describe('rate-limit', () => {
  it('crosses the actual threshold with counted permits, matching source/rule, origin receipts and explicit admitted/mitigated totals', async () => {
    const f = fixture(); try {
      const output = await f.run(); expect(output.decision.outcome).toBe('verified'); expect(output.report.result.requestsUsed).toBe(29); expect(f.calls).toHaveLength(29);
      expect(output.report.rateLimitSummary).toMatchObject({ admitted: 3, mitigated: 1, unknown: 0, sharedKeyContamination: 'not-observed' });
      expect(output.artifacts.filter(a => a.source === 'http')).toHaveLength(10);
      expect(output.artifacts.filter(a => a.source === 'origin' && 'stage' in a.payload && a.payload.stage === 'entry')).toHaveLength(9);
      const edge = output.artifacts.find(a => a.source === 'cloudflare')!.payload as any; expect(edge).toMatchObject({ action: 'block', ruleId: 'f'.repeat(32), product: 'ratelimit' });
      const policy = output.artifacts.find(a => a.source === 'configuration')!.payload as any; expect(policy.rateLimit).toMatchObject({ period: 10, requests_per_period: 3, mitigation_timeout: 10, characteristics: ['cf.colo.id', 'ip.src'] });
      const store = new ReportStore(f.root, f.config.evidenceDirectory); store.save(output.report, output.artifacts); expect(store.loadHtml(output.report.result.runId)).toContain('Admitted: 3; mitigated: 1');
      expect(f.calls.every(call => call.method === 'GET' || call.url.endsWith('/graphql'))).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('waits for the shared-IP cooldown on a repeated run without resetting any remote state', async () => {
    const f = fixture(); try {
      expect((await f.run()).decision.outcome).toBe('verified'); const previousTargets = f.targets();
      const pending = f.run(); await flush(); f.clock.advance(20999); await flush(); expect(f.targets()).toBe(previousTargets);
      f.clock.advance(1); await flush(); const second = await pending; expect(second.decision.outcome).toBe('verified'); expect(f.targets() - previousTargets).toBe(10);
      expect(second.report.rateLimitSummary?.cooldownUntil).toBe(new Date(f.now() + 21000).toISOString()); expect(f.calls.every(c => c.method === 'GET' || c.url.endsWith('/graphql'))).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('refuses untriggerable thresholds, unsupported counting keys and undersized CLI plans without traffic', async () => {
    const f = fixture(); try {
      const settings = desiredRateLimit(f.config.labId, f.config.environments[1].origin).ratelimit;
      expect(() => planRateBurst({ ...settings, requests_per_period: 9 }, limitsFor(), 13)).toThrow();
      expect(() => planRateBurst({ ...settings, characteristics: ['http.request.headers["x-arbitrary-key"]'] }, limitsFor())).toThrow();
      expect(() => planRateBurst(settings, limitsFor('scenario', { requests: 29 }), 13)).toThrow();
      const deps = { projectRoot: f.root, mode: 'fixture' as const, loadConfig: () => f.config, credentials: () => f.credentials, dispatch: f.dispatch };
      expect((await runDemoCli(['rate-limit', '--requests', '29', '--json'], deps)).exitCode).toBe(2);
      const dry = await runDemoCli(['rate-limit', '--dry-run', '--json'], deps); expect(dry.exitCode).toBe(0); expect(JSON.parse(dry.output).networkCalls).toBe(0); expect(f.calls).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it('marks early shared-key mitigation contaminated rather than claiming the threshold was proven', async () => {
    const f = fixture(); try {
      const desired = desiredRateLimit(f.config.labId, f.config.environments[1].origin);
      for (let i = 0; i < 2; i++) await f.dispatch(`${f.config.environments[1].origin}/api`, { headers: { 'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'rate-limit', 'x-demo-run-token': f.credentials.runner, 'x-demo-test': desired.marker } });
      const result = await f.run(); expect(result.decision.outcome).toBe('inconclusive'); expect(result.report.rateLimitSummary?.sharedKeyContamination).toBe('suspected'); expect(result.report.rateLimitSummary?.mitigated).toBeNull();
    } finally { await f.cleanup(); }
  });
  it('does not attribute a generic 429 or a WAF event to the rate policy', async () => {
    const f = fixture(); try {
      const result = await f.run(async (url, init) => { const response = await f.dispatch(url, init); if (!url.endsWith('/graphql')) return response; const data = await response.json() as any; for (const event of data.data.viewer.zones[0].firewallEventsAdaptive) event.source = 'firewallrules'; return new Response(JSON.stringify(data)); });
      expect(result.decision.outcome).not.toBe('verified'); expect(result.report.rateLimitSummary?.mitigated).toBeNull();
    } finally { await f.cleanup(); }
  });
  it('stores scoped cooldown metadata and refuses a quiet time that cannot fit', async () => {
    const f = fixture(); try {
      const cooldown = new RateCooldown(f.root, f.config.evidenceDirectory, f.config.labId, f.now); cooldown.note(randomUUID(), 120000);
      const result = await f.run(); expect(result.decision.outcome).not.toBe('verified'); expect(f.targets()).toBe(0); expect(cooldown.remaining()).toBe(120000);
    } finally { await f.cleanup(); }
  });
  it('creates only the reviewed owned rate module, preserves foreign rules and rejects drift', async () => {
    const f = fixture(); try {
      const desired = desiredRateLimit(f.config.labId, f.config.environments[1].origin); let ruleSet: any = { id: 'b'.repeat(32), kind: 'zone', phase: 'http_ratelimit', version: '1', rules: [{ id: 'a'.repeat(32), ref: 'foreign', description: 'Unrelated', action: 'block', enabled: true, expression: '(http.host eq "other.example.test")', ratelimit: desired.ratelimit }] }; let writes = 0;
      const api: RateSetupApi = { entrypoint: async () => structuredClone(ruleSet), create: async () => { throw new Error('Must append'); }, append: async (_id, rule) => { writes++; ruleSet.rules.push({ id: 'f'.repeat(32), ...rule }); ruleSet.version = '2'; }, enable: async () => { throw new Error('Unexpected enable'); } };
      const state = (await inspectRateLimit(api, desired)).state;
      const context = { signal: new AbortController().signal, plan: { includedModules: ['core', 'rate-limit'] }, perform: async (_kind: string, _id: string, action: () => Promise<unknown>) => action(), observeResource: () => {} } as unknown as SetupContext;
      const result = await provisionRateLimit(api, desired, state, context); expect(result.ruleset?.rules[0]?.ref).toBe('foreign'); expect(writes).toBe(1);
      await expect(provisionRateLimit(api, desired, state, context)).rejects.toThrow('drift'); expect(writes).toBe(1);
    } finally { await f.cleanup(); }
  });
});
