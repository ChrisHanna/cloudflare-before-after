import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { controlFixture } from './fixtures/control.js';
import { CATALOG } from '../scenarios/catalog.js';
import { policyViews } from '../packages/demo-core/src/policy-view.js';
import { PolicyViewSchema } from '../packages/contracts/src/schemas.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { evidenceView } from '../packages/demo-core/src/evidence-view.js';
import { atRecord, AT_PREDICATES, type AtId } from '../packages/demo-core/src/t38-at11-14-record.js';
const body = (command = 'waf-custom') => ({ command, liveOptIn: true, idempotencyKey: randomUUID() });
function emit(id: 'AT-11A' | 'AT-11B' | 'AT-14A' | 'AT-14B', f: ReturnType<typeof controlFixture>, checks: { name: string; passed: boolean }[], start: number, job?: any) {
  const record = atRecord({ id, checks, releaseDigest: f.config.environments[0].releaseDigest, requestsUsed: f.calls.length, durationMs: performance.now() - start, ...(job ? { result: job.result.report.result, artifacts: job.artifacts } : {}) });
  console.info(JSON.stringify(record)); expect(record.outcome).toBe('unavailable');
}
describe('T38 AT-11/14 real control API, CLI, report and policy joins', () => {
  it('acceptance records reject empty assertions, foreign links and redact canaries', () => {
    const input = { id: 'AT-11B' as const, releaseDigest: 'a'.repeat(64), requestsUsed: 0, durationMs: 1, checks: [{ name: 'token-canary', passed: false }] };
    const failed = atRecord({ ...input, secrets: ['token-canary'] }); expect(failed.outcome).toBe('failed'); expect(JSON.stringify(failed)).not.toContain('token-canary');
    expect(() => atRecord({ ...input, checks: [] })).toThrow();
    expect(() => atRecord({ ...input, checks: [{ name: 'Missing artifact', passed: true, evidenceIds: [randomUUID()] }] })).toThrow('Unlinked');
    expect(() => atRecord({ ...input, requestsUsed: -1 })).toThrow();
  });
  it.each(Object.keys(AT_PREDICATES) as AtId[])('%s records retain every missing design predicate', id => {
    const record = atRecord({ id, releaseDigest: 'a'.repeat(64), requestsUsed: 0, durationMs: 1, checks: [{ name: 'Partial fixture observation only', passed: true }] });
    expect(record.mode).toBe('fixture'); expect(record.outcome).toBe('unavailable');
    expect(record.assertions.filter(c => !c.passed).map(c => c.name)).toEqual(AT_PREDICATES[id]);
    expect(new Set(record.assertions.map(c => c.name)).size).toBe(record.assertions.length);
  });
  it('AT-11A joins counters to real runner artifacts and refresh/replay issues no probes', async () => {
    const start = performance.now(); const f = controlFixture();
    try {
      await f.login(); const created = await f.request('/api/runs', 'POST', body()); const id = (await created.json() as any).run.id;
      const job = await f.wait(id); const report = (await (await f.request(`/api/reports/${job.actualRunId}`)).json() as any).report;
      expect(report.result.runId).toBe(job.actualRunId); expect(job.result.report).toEqual(report);
      for (const role of ['before', 'after']) {
        const entries = job.artifacts.filter((a: any) => a.source === 'origin' && a.targetRole === role && a.payload.stage === 'entry');
        const count = new Set(entries.map((a: any) => a.payload.requestId)).size;
        expect(job.evidence.roles.find((r: any) => r.role === role).originReceived).toBe(count);
      }
      const edge = job.artifacts.find((a: any) => a.source === 'cloudflare');
      expect(job.evidence.roles[1].actions).toContainEqual({ product: edge.payload.product, action: edge.payload.action, ruleId: edge.payload.ruleId, count: 1 });
      const count = f.calls.length;
      for (let i = 0; i < 2; i++) {
        await f.request(`/api/runs/${id}`); await f.request('/api/readiness');
        const replay = await f.request(`/api/runs/${id}/events?after=0`); const text = await replay.text();
        expect(text).toContain(job.actualRunId); expect(text).not.toContain(f.credentials.runner);
      }
      expect(f.calls).toHaveLength(count);
      emit('AT-11A', f, [{ name: 'UI API report run and receipt joins', passed: report.result.runId === job.actualRunId }, { name: 'Refresh and SSE replay have zero dispatch', passed: f.calls.length === count }], start, job);
    } finally { await f.cleanup(); }
  });
  it('AT-11B rejects unauthorized/CSRF/origin requests and deduplicates real starts', async () => {
    const start = performance.now(); const f = controlFixture();
    try {
      expect((await f.request('/api/runs', 'POST', body())).status).toBe(401); expect(f.calls).toHaveLength(0);
      await f.login();
      expect((await f.request('/api/runs', 'POST', body(), { origin: 'https://other.invalid' })).status).toBe(403);
      expect((await f.request('/api/runs', 'POST', body(), { 'x-csrf-token': 'wrong' })).status).toBe(403); expect(f.calls).toHaveLength(0);
      for (const command of ['waf-custom', 'waiting-room', 'rehearsal', 'interview', 'all']) {
        const r = await f.request('/api/plans', 'POST', { command }); expect(r.status).toBe(200);
        expect((await r.json() as any).plan.kind).toBe('planned');
      }
      expect(f.calls).toHaveLength(0);
      const input = body(); const responses = await Promise.all([f.request('/api/runs', 'POST', input), f.request('/api/runs', 'POST', input)]);
      const ids = await Promise.all(responses.map(async r => (await r.json() as any).run.id)); expect(ids[0]).toBe(ids[1]);
      const job = await f.wait(ids[0]); expect(job.observations).toHaveLength(4);
      const serialized = JSON.stringify(job); for (const value of Object.values(f.credentials)) expect(serialized).not.toContain(value);
      emit('AT-11B', f, [{ name: 'Authorization before dispatch', passed: true }, { name: 'Local plans and duplicate identity', passed: ids[0] === ids[1] }], start, job);
    } finally { await f.cleanup(); }
  });
  it('AT-14A validates every actual catalog panel, links, settings and desired labels', async () => {
    const start = performance.now(); const f = controlFixture();
    try {
      await f.login(); const panels = (await (await f.request('/api/catalog')).json() as any).policies.map((p: unknown) => PolicyViewSchema.parse(p));
      expect(panels.map((p: any) => p.scenarioId)).toEqual(CATALOG.map(m => m.id));
      for (const panel of panels) {
        const manifest = CATALOG.find(m => m.id === panel.scenarioId)!; expect(panel.product).toBe(manifest.product);
        expect(panel.targets.map((t: any) => t.hostname)).toEqual(['before.example.test', 'after.example.test']);
        expect(panel.desired.length).toBeGreaterThan(0); expect(panel.before).not.toBe(panel.after);
        expect(panel.observed.state).toBe('unknown'); expect(panel.observed.observedAt).toBeNull(); expect(panel.readinessBlocked).toBe(true);
        expect(panel.inspection.navigation.length).toBeGreaterThan(2); expect(panel.inspection.accountId).toBe(f.config.accountId);
        const u = new URL(panel.inspection.url); expect(['dash.cloudflare.com', 'one.dash.cloudflare.com']).toContain(u.hostname); expect(u.username + u.password).toBe('');
        expect(panel.mitigationVerified).toBe(false);
      }
      expect(f.calls).toHaveLength(0);
      emit('AT-14A', f, [{ name: 'Eleven desired panels and safe navigation', passed: panels.length === 11 }], start);
    } finally { await f.cleanup(); }
  });
  it('AT-14B blocks drift and unreadable policy without changing captured results', async () => {
    const start = performance.now(); const f = controlFixture();
    try {
      await f.login(); const id = (await (await f.request('/api/runs', 'POST', body())).json() as any).run.id; const job = await f.wait(id);
      const original = job.artifacts.find((a: any) => a.source === 'configuration');
      for (const patch of [{ enabled: false }, { action: 'log' }, { expression: '(http.host eq "before.example.test")' }]) {
        const artifacts = [original, { ...original, id: randomUUID(), payload: { ...original.payload, ...patch } }];
        const p = policyViews(f.config, { runId: job.actualRunId, historical: false, artifacts }).find(p => p.scenarioId === 'waf-custom')!;
        expect(p.observed.state).toBe('mismatch'); expect(p.readinessBlocked).toBe(true); expect(p.mitigationVerified).toBe(false);
      }
      const missing = policyViews(f.config, { runId: job.actualRunId, historical: false, artifacts: job.artifacts, readbackComplete: false }).find(p => p.scenarioId === 'waf-custom')!;
      expect(missing.observed.state).toBe('unknown'); expect(missing.readinessBlocked).toBe(true); expect(job.result.report.result.outcome).toBe('verified');
      emit('AT-14B', f, [{ name: 'Drift and unreadable state block policy readiness', passed: missing.readinessBlocked }], start, job);
    } finally { await f.cleanup(); }
  });
  it('AT-11B stop aborts an actual pending comparison and preserves earlier observations', async () => {
    let unblock!: () => void; const blocked = new Promise<void>(resolve => { unblock = resolve; }); let targets = 0;
    const f = controlFixture({ execute: (args, deps) => runDemoCli(args, { ...deps, dispatch: async (url, init) => {
      if (new URL(url).pathname === '/catalog' && ++targets === 2) {
        unblock(); await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error('Fixture stopped')); if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return deps.dispatch!(url, init);
    } }) });
    try {
      await f.login(); const id = (await (await f.request('/api/runs', 'POST', body())).json() as any).run.id;
      await blocked; expect((await f.request(`/api/runs/${id}/stop`, 'POST', {})).status).toBe(200);
      const job = await f.wait(id); expect(job.status).toBe('cancelled'); expect(job.observations.length).toBeGreaterThan(0);
      expect(job.result.report.result.outcome).not.toBe('verified'); const calls = f.calls.length;
      await f.request(`/api/runs/${id}`); expect(f.calls).toHaveLength(calls); expect(targets).toBe(2);
    } finally { await f.cleanup(); }
  });
  it('AT-11A missing, sampled, pending and stale sources stay distinct from zero', async () => {
    const f = controlFixture();
    try {
      await f.login(); const id = (await (await f.request('/api/runs', 'POST', body())).json() as any).run.id; const job = await f.wait(id);
      const result = job.result.report.result;
      const scope = { runId: job.actualRunId, scenarioId: result.scenarioId, mode: 'fixture' as const, startedAt: result.startedAt, endedAt: result.finishedAt, releaseDigest: result.releaseDigest, hosts: { before: 'before.example.test', after: 'after.example.test' }, running: true, truncated: false };
      const pending = evidenceView(scope, job.observations, []); expect(pending.roles[1]!.originReceived).toBeNull();
      expect(pending.roles[1]!.sources.find(s => s.source === 'origin')!.state).toBe('pending');
      const unavailable = evidenceView({ ...scope, running: false }, job.observations, []); expect(unavailable.roles[1]!.originReceived).toBeNull();
      expect(unavailable.roles[1]!.sources.find(s => s.source === 'cloudflare')!.state).toBe('unavailable');
      const stale = evidenceView({ ...scope, running: false }, job.observations, job.artifacts, Date.parse(result.finishedAt) + 61000);
      expect(stale.roles[1]!.sources.every(s => s.observedAt === null || s.state === 'stale')).toBe(true);
      const sampled = job.artifacts.map((a: any) => a.source === 'cloudflare' ? { ...a, payload: { ...a.payload, sampling: 'sampled' } } : a);
      expect(evidenceView(scope, job.observations, sampled).roles[1]!.sources.find(s => s.source === 'cloudflare')!.state).toBe('sampled');
    } finally { await f.cleanup(); }
  });
  it('AT-14B a Ray ID and denied status without attribution cannot verify mitigation', async () => {
    const f = controlFixture({ execute: (args, deps) => runDemoCli(args, { ...deps, dispatch: async (url, init) => {
      if (new URL(url).pathname.endsWith('/graphql')) return Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: [] }] } } });
      return deps.dispatch!(url, init);
    } }) });
    try {
      await f.login(); const id = (await (await f.request('/api/runs', 'POST', body())).json() as any).run.id; const job = await f.wait(id);
      expect(job.observations.some((o: any) => o.status === 403 && o.rayId)).toBe(true);
      expect(job.result.report.result.outcome).toBe('inconclusive'); expect(job.result.report.result.missingProof.length).toBeGreaterThan(0);
      expect(job.policies.find((p: any) => p.scenarioId === 'waf-custom').mitigationVerified).toBe(false);
    } finally { await f.cleanup(); }
  });
  it('all live scenario variants without opt-in dispatch nothing', async () => {
    const f = controlFixture(); f.config.liveOptIn = false;
    const dispatch = vi.fn(async () => { throw new Error('Forbidden network'); }); const credentials = vi.fn(() => f.credentials);
    try {
      for (const command of CATALOG.map(m => m.id)) {
        const r = await runDemoCli([command, '--json'], { projectRoot: f.root, mode: 'live', loadConfig: () => f.config, credentials, dispatch });
        expect(r.exitCode).not.toBe(0); expect(JSON.parse(r.output).kind).not.toBe('planned');
      }
      expect(dispatch).not.toHaveBeenCalled(); expect(credentials).not.toHaveBeenCalled();
    } finally { await f.cleanup(); }
  });
});
