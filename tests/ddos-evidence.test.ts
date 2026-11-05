import { describe, expect, it, vi } from 'vitest';
import { collectDdosEvidence, DdosEvidenceReadError, reviewDdosEvidence, type DdosCapture, type DdosSelection } from '../packages/demo-core/src/ddos-evidence.js';
const selection = (mode: DdosSelection['mode'] = 'fixture'): DdosSelection => ({ source: 'firewallEventsAdaptive', zoneId: 'a'.repeat(32), hostname: 'after.example.test', start: '2026-11-04T00:00:00Z', end: '2026-11-04T00:01:00Z', limit: 100, mode });
const capture = (mode: DdosSelection['mode'] = 'fixture'): DdosCapture => ({ source: 'firewallEventsAdaptive', zoneId: 'a'.repeat(32), hostname: 'after.example.test', start: selection().start, end: selection().end, mode, observedAt: '2026-11-04T00:02:00Z', sampling: 'sampled', complete: true, ingestionDelayMs: 1000, events: [{ datetime: '2026-11-04T00:00:30Z', rayName: '0123456789abcdef', source: 'l7ddos', action: 'block', ruleId: 'ddos-rule', clientRequestHTTPHost: 'after.example.test' }] });
describe('ddos-evidence', () => {
  it('uses only one read, passes exact selection and performs no attack traffic', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('No provider traffic'); });
    const read = vi.fn(async () => capture());
    try {
      const result = await collectDdosEvidence(selection(), { read });
      expect(read).toHaveBeenCalledExactlyOnceWith(selection(), undefined); expect(network).not.toHaveBeenCalled();
      expect(result).toMatchObject({ label: 'FIXTURE', outcome: 'inconclusive', currentApplicationResilienceProven: false, sampling: 'sampled', ingestionDelayMs: 1000 });
      expect(result.events).toEqual([{ eventTime: '2026-11-04T00:00:30Z', rayId: '0123456789abcdef', ruleId: 'ddos-rule', action: 'block', kind: 'mitigation' }]);
      expect(result.artifactDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally { network.mockRestore(); }
  });
  it('reviews provider-sourced historical evidence without claiming current resilience', () => {
    // Injected live-mode fixture tests classification, not a live Cloudflare result.
    const result = reviewDdosEvidence(selection('live'), capture('live'));
    expect(result).toMatchObject({ outcome: 'verified', label: 'HISTORICAL EVENT EVIDENCE', currentApplicationResilienceProven: false });
    expect(result.limitations.join(' ')).toContain('Sampling');
    expect(reviewDdosEvidence(selection('saved'), capture('saved')).label).toBe('SAVED EVIDENCE');
  });
  it.each(['firewallrules', 'waf', 'ratelimit', 'dashboard'])('cannot prove DDoS from generic %s blocks', source => {
    const c = capture('live'); c.events[0]!.source = source;
    expect(reviewDdosEvidence(selection('live'), c)).toMatchObject({ outcome: 'unavailable', events: [] });
  });
  it('requires rule identity and a known DDoS action, and accepts detection separately', () => {
    const c = capture('live'); c.events[0]!.ruleId = null;
    expect(reviewDdosEvidence(selection('live'), c).outcome).toBe('unavailable');
    c.events[0]!.ruleId = 'rule'; c.events[0]!.action = 'allow';
    expect(reviewDdosEvidence(selection('live'), c).events).toEqual([]);
    c.events[0]!.action = 'log'; c.events.push({ ...c.events[0]! });
    expect(reviewDdosEvidence(selection('live'), c).events.map(e => e.kind)).toEqual(['detection']);
  });
  it('keeps empty, truncated, and limit-hit evidence honest', () => {
    const c = capture('live'); c.events = [];
    expect(reviewDdosEvidence(selection('live'), c).outcome).toBe('unavailable');
    c.events = capture('live').events; c.complete = false;
    expect(reviewDdosEvidence(selection('live'), c).outcome).toBe('inconclusive');
    c.complete = true;
    expect(reviewDdosEvidence({ ...selection('live'), limit: 1 }, c).outcome).toBe('inconclusive');
  });
  it('rejects mismatched provenance, host, window, malformed and extra secret fields', () => {
    for (const patch of [{ zoneId: 'b'.repeat(32) }, { mode: 'saved' }, { hostname: 'wrong.example.test' }, { observedAt: '2026-11-03T00:00:00Z' }, { token: 'SECRET' }]) {
      expect(() => reviewDdosEvidence(selection(), { ...capture(), ...patch })).toThrow();
    }
    for (const patch of [{ datetime: '2026-11-03T00:00:00Z' }, { clientRequestHTTPHost: 'wrong.example.test' }, { rayName: 'bad' }, { email: 'private@example.test' }]) {
      const c = capture(); expect(() => reviewDdosEvidence(selection(), { ...c, events: [{ ...c.events[0], ...patch }] })).toThrow();
    }
    expect(() => reviewDdosEvidence({ ...selection(), start: selection().end }, capture())).toThrow();
  });
  it.each(['permission-denied', 'not-entitled', 'unavailable', 'unknown'] as const)('reports %s without leaking reader errors', async state => {
    const result = await collectDdosEvidence(selection(), { read: async () => { throw new DdosEvidenceReadError(state); } });
    expect(result.outcome).toBe('unavailable'); expect(result.missingProof[0]).toContain(state); expect(result.artifactDigest).toBeNull();
  });
  it('sanitizes unknown errors and rejects corrupt successful responses', async () => {
    const result = await collectDdosEvidence(selection(), { read: async () => { throw new Error('SECRET'); } });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    await expect(collectDdosEvidence(selection(), { read: async () => ({}) })).rejects.toThrow();
  });
  it('cancels before and during reads with no retry or fake success', async () => {
    const abort = new AbortController(); abort.abort(); const read = vi.fn(async () => capture());
    await expect(collectDdosEvidence(selection(), { read }, abort.signal)).rejects.toThrow(); expect(read).not.toHaveBeenCalled();
    const during = new AbortController();
    await expect(collectDdosEvidence(selection(), { read: async () => { during.abort(); return capture(); } }, during.signal)).rejects.toThrow();
  });
});
