import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { policyViews } from '../packages/demo-core/src/policy-view.js';
import { PolicyViewSchema } from '../packages/contracts/src/schemas.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { controlFixture } from './fixtures/control.js';
const body = (command = 'waf-custom') => ({ command, idempotencyKey: randomUUID(), liveOptIn: true, ...(command === 'doctor' ? { scope: 'core-waf' } : {}) });
async function run(f: ReturnType<typeof controlFixture>, command?: string) { const result = await (await f.request('/api/runs', 'POST', body(command))).json() as any; return f.wait(result.run.id); }
describe('policy-panels', () => {
  it('covers all eleven products with desired-only labels, exact target paths, relevant unknown settings and inspection steps', async () => {
    const f = controlFixture(); try {
      await f.login(); const catalog = await (await f.request('/api/catalog')).json() as any;
      expect(catalog.policies).toHaveLength(11); expect(f.calls).toHaveLength(0);
      for (const raw of catalog.policies) { const policy = PolicyViewSchema.parse(raw); expect(policy.observed.state).toBe('unknown'); expect(policy.readinessBlocked).toBe(true); expect(policy.mitigationVerified).toBe(false); expect(policy.observed.enabled).toBeNull(); expect(policy.inspection.navigation.length).toBeGreaterThan(2); expect(policy.targets.map(t => t.hostname)).toEqual(['before.example.test', 'after.example.test']); }
      const p = (id: string) => catalog.policies.find((p: any) => p.scenarioId === id);
      expect(p('turnstile').settings.map((s: any) => s.name)).toContain('Verification mode');
      expect(p('waiting-room').settings.map((s: any) => s.name)).toContain('Capacity');
      expect(p('access').settings.map((s: any) => s.name)).toContain('Audience');
      expect(p('api-shield').settings.map((s: any) => s.name)).toContain('Client certificate required');
      expect(p('ddos-evidence').settings.map((s: any) => s.name)).toContain('Window start');
      expect(p('turnstile').targets[1].paths).toEqual(['/register']); expect(p('access').targets[1].paths).toEqual(['/admin']);
    } finally { await f.cleanup(); }
  });
  it('allows only fixed official product selectors, with no credential or external URL injection', async () => {
    const f = controlFixture(); try {
      const policies = policyViews(f.config);
      for (const policy of policies) { const url = new URL(policy.inspection.url); expect(['dash.cloudflare.com', 'one.dash.cloudflare.com']).toContain(url.hostname); expect(url.username + url.password).toBe(''); expect(policy.inspection.accountId).toBe(f.config.accountId); expect(policy.inspection.zoneId).toBe(f.config.zoneId); }
      for (const url of ['https://dash.cloudflare.com.evil.test/', 'https://secret@dash.cloudflare.com/', 'https://dash.cloudflare.com/?token=secret', 'https://dash.cloudflare.com/?to=https://evil.test', 'https://one.dash.cloudflare.com/?token=secret', 'javascript:alert(1)']) expect(PolicyViewSchema.safeParse({ ...policies[0], inspection: { ...policies[0]!.inspection, url } }).success).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('renders actual captured rule identity, enabled action/order/expression and digest without qualifying fixture or saved data', async () => {
    const f = controlFixture(); try {
      await f.login(); const job = await run(f); const policy = job.policies.find((p: any) => p.scenarioId === 'waf-custom');
      expect(policy.observed).toMatchObject({ state: 'fixture', resourceId: 'c'.repeat(32), rulesetId: 'a'.repeat(32), enabled: true, action: 'block', order: 1, priority: null, mode: 'fixture' });
      expect(policy.observed.digest).toMatch(/^[a-f0-9]{64}$/); expect(policy.observed.expression).toContain('after.example.test'); expect(policy.readinessBlocked).toBe(true);
      const capture = { runId: job.actualRunId, artifacts: job.artifacts.map((a: any) => ({ ...a, mode: 'live' })), historical: true };
      const saved = policyViews(f.config, capture).find(p => p.scenarioId === 'waf-custom')!; expect(saved.observed.state).toBe('saved'); expect(saved.readinessBlocked).toBe(true);
      const live = policyViews(f.config, { ...capture, historical: false }, Date.parse(policy.observed.observedAt)).find(p => p.scenarioId === 'waf-custom')!; expect(live.observed.state).toBe('last-checked'); expect(live.mitigationVerified).toBe(false);
      const missingOrder = capture.artifacts.map((a: any) => { if (a.source !== 'configuration') return a; const { order: _order, ...payload } = a.payload; return { ...a, payload }; });
      expect(policyViews(f.config, { ...capture, artifacts: missingOrder, historical: false }, Date.parse(policy.observed.observedAt)).find(p => p.scenarioId === 'waf-custom')!.readinessBlocked).toBe(true);
      expect(policyViews(f.config, { ...capture, historical: false }, Date.parse(policy.observed.observedAt) + 61000).find(p => p.scenarioId === 'waf-custom')!.observed.state).toBe('stale');
      expect(policyViews(f.config, { ...capture, historical: false, readbackComplete: false }).find(p => p.scenarioId === 'waf-custom')!.observed.state).toBe('unknown');
    } finally { await f.cleanup(); }
  });
  it('blocks hostname, action, enabled, reference, version or order drift and rejects foreign run metadata', async () => {
    const f = controlFixture(); try {
      await f.login(); const job = await run(f); const original = job.artifacts.find((a: any) => a.source === 'configuration');
      for (const patch of [{ expression: '(http.host eq "before.example.test")' }, { enabled: false }, { action: 'log' }, { ref: 'foreign-lab' }, { rulesetVersion: 'new-version' }, { order: 2 }]) {
        const changed = { ...original, id: randomUUID(), payload: { ...original.payload, ...patch } };
        const p = policyViews(f.config, { runId: job.actualRunId, artifacts: [original, changed], historical: false }).find(p => p.scenarioId === 'waf-custom')!;
        expect(p.observed.state).toBe('mismatch'); expect(p.readinessBlocked).toBe(true); expect(p.mismatches.length).toBeGreaterThan(0); expect(job.result.report.result.outcome).toBe('verified');
      }
      const foreign = policyViews(f.config, { runId: randomUUID(), artifacts: job.artifacts, historical: false }).find(p => p.scenarioId === 'waf-custom')!; expect(foreign.observed.state).toBe('unknown');
    } finally { await f.cleanup(); }
  });
  it('publishes bad live-readback facts before stopping a real adapter and blocks cached readiness without new probes', async () => {
    let mismatch = false;
    const f = controlFixture({ execute: (args, deps) => runDemoCli(args, { ...deps, dispatch: async (url, init) => {
      const response = await deps.dispatch!(url, init);
      if (!mismatch || !url.endsWith('/entrypoint')) return response;
      const data = await response.json() as any; data.result.rules[0].expression = '(http.host eq "before.example.test")'; return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    } }) });
    try {
      await f.login(); expect((await run(f, 'doctor')).result.report.preflightReady).toBe(true); mismatch = true;
      const job = await run(f); expect(job.result.report.result.outcome).toBe('failed'); expect(job.observations).toHaveLength(0);
      const policy = job.policies.find((p: any) => p.scenarioId === 'waf-custom'); expect(policy.observed.state).toBe('mismatch'); expect(policy.observed.expression).toContain('before.example.test');
      const count = f.calls.length; const readiness = await (await f.request('/api/readiness')).json() as any;
      expect(readiness.policyReadinessBlocked).toBe(true); expect(readiness.currentPreflightReady).toBe(false);
      await f.request('/api/catalog'); await f.request(`/api/runs/${job.id}`); expect(f.calls.length).toBe(count);
    } finally { await f.cleanup(); }
  });
});
