import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { joinAnalytics, type AnalyticsInput, type AnalyticsSource } from '../packages/demo-core/src/analytics.js';
import type { Artifact } from '../packages/demo-core/src/reports.js';
const start = '2026-11-04T00:00:00Z'; const end = '2026-11-04T00:01:00Z'; const time = '2026-11-04T00:00:30Z';
function fixture(): AnalyticsInput {
  const runId = randomUUID(); const requestId = randomUUID();
  const scope: AnalyticsInput['scope'] = { runId, scenarioId: 'waf-custom', mode: 'fixture', releaseDigest: 'a'.repeat(64), window: { start, end }, hosts: { before: 'before.example.test', after: 'after.example.test' } };
  const observation: AnalyticsInput['observations'][number] = { schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: scope.scenarioId, targetRole: 'after', mode: 'fixture', observedAt: time, method: 'GET', path: '/catalog', status: 403, latencyMs: 1, rayId: '0123456789abcdef-SJC', action: null, ruleId: null, originCount: null, excerpt: '' };
  const artifact = (source: Artifact['source'], payload: Artifact['payload'], request: string | null = requestId): Artifact => ({ id: randomUUID(), runId, scenarioId: scope.scenarioId, mode: 'fixture', targetRole: 'after', requestId: request, source, observedAt: end, payload });
  const receipt = artifact('origin', { schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: scope.scenarioId, targetRole: 'after', producerId: 'container-after', sequence: 1, observedAt: time, rayId: observation.rayId, releaseDigest: scope.releaseDigest, stage: 'entry' });
  const coverage = artifact('origin', { healthy: true, complete: true, windowStart: start, watermark: end, producerSequence: 1, gaps: [] }, null);
  const edge = artifact('cloudflare', { kind: 'edge', rayId: '0123456789abcdef', action: 'block', ruleId: 'rule1', product: 'firewallrules', hostname: scope.hosts.after, eventTime: time, sampling: 'complete' });
  const sources: AnalyticsSource[] = (['before', 'after'] as const).flatMap(role => (['http', 'origin', 'cloudflare'] as const).map(source => ({ runId, scenarioId: scope.scenarioId, mode: scope.mode, role, source, api: source === 'cloudflare' ? 'firewallEventsAdaptive' : source, state: 'available', observedAt: end, window: { start, end }, sampling: 'complete', complete: true, ingestionDelayMs: 0 })));
  return { scope, observations: [observation], artifacts: [receipt, coverage, edge], sources };
}
const after = (input: AnalyticsInput) => joinAnalytics(input).roles[1]!;
describe('analytics', () => {
  it('joins real fixture records by run/request/Ray/window and separates counts', () => {
    const f = fixture(); const view = after(f);
    expect(view).toMatchObject({ observedRequests: 1, originReceipts: 1, edgeEvents: 1, actions: [{ product: 'firewallrules', action: 'block', ruleId: 'rule1', count: 1 }] });
    expect(view.joins).toEqual([{ requestId: f.observations[0]!.requestId, originReceived: true, edgeEvidenceIds: [f.artifacts[2]!.id] }]);
    expect(joinAnalytics(f)).toMatchObject({ label: 'FIXTURE', inferredExplanations: [] });
    expect(JSON.stringify(joinAnalytics(f))).not.toContain('revenueGain');
  });
  it('deduplicates requests, entry/completion receipts and edge events', () => {
    const f = fixture(); f.observations.push({ ...f.observations[0]!, id: randomUUID() });
    const receipt = f.artifacts[0]!; const p = receipt.payload; if (!('stage' in p)) throw new Error('receipt fixture');
    f.artifacts.push(receipt, { ...receipt, id: randomUUID(), payload: { ...p, stage: 'completion' } }, f.artifacts[2]!);
    expect(after(f)).toMatchObject({ observedRequests: 1, originReceipts: 1, edgeEvents: 1 });
  });
  it('does not trust status, response action, or a zero originCount', () => {
    const f = fixture(); f.artifacts = []; f.sources = [];
    f.observations[0] = { ...f.observations[0]!, status: 429, originCount: 0, action: 'block', ruleId: 'response-rule' };
    expect(after(f)).toMatchObject({ observedRequests: 1, originReceipts: null, edgeEvents: null, actions: [], joins: [{ originReceived: null }] });
    expect(joinAnalytics(f).outcome).toBe('inconclusive');
  });
  it('allows zero only with full healthy origin coverage', () => {
    const f = fixture(); f.artifacts.shift();
    expect(after(f)).toMatchObject({ originReceipts: 0, joins: [{ originReceived: false }] });
    const p = f.artifacts[0]!.payload; if (!('windowStart' in p)) throw new Error('coverage fixture');
    for (const patch of [{ healthy: false }, { complete: false }, { gaps: ['gap'] }, { watermark: null }, { producerSequence: null }, { watermark: start }]) {
      f.artifacts[0] = { ...f.artifacts[0]!, payload: { ...p, ...patch } };
      expect(after(f)).toMatchObject({ originReceipts: null, joins: [{ originReceived: null }] });
    }
  });
  it.each(['pending', 'stale', 'unavailable', 'permission-denied'] as const)('preserves %s sources as unknown', state => {
    const f = fixture(); f.sources = f.sources.map(s => ({ ...s, state }));
    expect(after(f)).toMatchObject({ originReceipts: null, edgeEvents: null });
    expect(joinAnalytics(f).missingProof.length).toBeGreaterThan(0);
  });
  it('discloses sampling and API delay without scaling observed events', () => {
    const f = fixture(); f.sources = f.sources.map(s => s.source === 'cloudflare' ? { ...s, sampling: 'sampled', ingestionDelayMs: 5000 } : s);
    const p = f.artifacts[2]!.payload; if (!('kind' in p) || p.kind !== 'edge') throw new Error('edge fixture');
    f.artifacts[2] = { ...f.artifacts[2]!, payload: { ...p, sampling: 'sampled' } };
    expect(after(f).edgeEvents).toBe(1); expect(after(f).sources.at(-1)).toMatchObject({ sampling: 'sampled', ingestionDelayMs: 5000 });
    expect(joinAnalytics(f).missingProof.join(' ')).toContain('observed rows only');
    f.artifacts = []; expect(after(f).edgeEvents).toBeNull();
  });
  it('rejects foreign run, scenario, mode, time, host and release joins', () => {
    for (const change of ['run', 'scenario', 'mode', 'time', 'host', 'release']) {
      const f = fixture();
      if (change === 'run') f.scope.runId = randomUUID();
      if (change === 'scenario') f.scope.scenarioId = 'analytics';
      if (change === 'mode') f.scope.mode = 'saved';
      if (change === 'time') f.scope.window = { start: '2026-11-03T00:00:00Z', end: '2026-11-03T00:01:00Z' };
      if (change === 'host') f.scope.hosts.after = 'other.example.test';
      if (change === 'release') f.scope.releaseDigest = 'b'.repeat(64);
      if (change === 'host') expect(after(f).edgeEvents).toBe(0);
      else if (change === 'release') expect(after(f).originReceipts).toBeNull();
      else { expect(after(f).joins).toEqual([]); expect(after(f).originReceipts ?? 0).toBe(0); expect(after(f).edgeEvents ?? 0).toBe(0); }
    }
  });
  it('rejects source metadata copied from another run or mode', () => {
    const f = fixture(); f.artifacts = []; f.sources = f.sources.map(s => ({ ...s, runId: randomUUID() }));
    expect(after(f)).toMatchObject({ originReceipts: null, edgeEvents: null });
    f.sources = f.sources.map(s => ({ ...s, runId: f.scope.runId, mode: 'saved' }));
    expect(after(f)).toMatchObject({ originReceipts: null, edgeEvents: null });
  });
  it('does not join an event with the wrong request ID or an ambiguous Ray', () => {
    const f = fixture(); f.artifacts[2] = { ...f.artifacts[2]!, requestId: randomUUID() };
    expect(after(f).actions).toEqual([]); expect(joinAnalytics(f).missingProof.join(' ')).toContain('unmatched');
    f.observations.push({ ...f.observations[0]!, id: randomUUID(), requestId: randomUUID() });
    expect(after(f).actions).toEqual([]);
  });
  it('flags conflicting HTTP observations instead of silently choosing one', () => {
    const f = fixture(); f.observations.push({ ...f.observations[0]!, status: 200 });
    expect(after(f).observedRequests).toBeNull(); expect(after(f).joins).toEqual([]);
    expect(joinAnalytics(f).missingProof.join(' ')).toContain('conflicting');
  });
  it('validates schema, metadata uniqueness and exact source windows', () => {
    const f = fixture(); f.sources[1] = f.sources[0]!; expect(() => joinAnalytics(f)).toThrow('Duplicate');
    const g = fixture(); g.sources = g.sources.map(s => ({ ...s, window: { start: '2026-11-03T00:00:00Z', end } }));
    expect(after(g).originReceipts).toBeNull();
    expect(() => joinAnalytics({ ...fixture(), revenueGain: 100 } as AnalyticsInput)).toThrow();
    expect(() => joinAnalytics({ ...fixture(), scope: { ...fixture().scope, window: { start: end, end: start } } })).toThrow();
  });
  it('never sends requests on repeated refresh and keeps fixture/saved labels', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No requests'); });
    try {
      const f = fixture(); for (let n = 0; n < 3; n++) expect(joinAnalytics(f)).toEqual(joinAnalytics(f));
      expect(network).not.toHaveBeenCalled(); f.scope.mode = 'saved'; expect(joinAnalytics(f).label).toBe('SAVED EVIDENCE');
    } finally { network.mockRestore(); }
  });
});
