import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { evaluateEdgeProof, evaluateProof, type EdgeProof } from '../packages/demo-core/src/proof.js';
const time = '2026-11-04T00:00:00.000Z'; const end = '2026-11-04T00:00:10.000Z'; const digest = 'a'.repeat(64);
function fixture(): EdgeProof {
  const runId = randomUUID();
  const obs = (targetRole: 'before' | 'after') => ({ schemaVersion: 1 as const, id: randomUUID(), runId, requestId: randomUUID(), scenarioId: 'waf-custom' as const, targetRole, mode: 'fixture' as const, observedAt: time, method: 'GET' as const, path: '/catalog', status: 200, latencyMs: 1, rayId: 'abcdef0123456789', action: null, ruleId: null, originCount: null, excerpt: '' });
  const baseline = obs('before'); const protectedRequest = { ...obs('after'), status: 403 };
  const controls = [obs('before'), obs('after')];
  const ref = (source: 'http' | 'origin' | 'cloudflare' | 'configuration', requestId: string | null, role: 'before' | 'after' = 'after') => ({ id: randomUUID(), source, mode: 'fixture' as const, observedAt: time, runId, scenarioId: 'waf-custom' as const, targetRole: role, requestId, rayId: null, artifactDigest: digest });
  return {
    runId, scenarioId: 'waf-custom', mode: 'fixture', baseline, protected: protectedRequest, controls,
    receipts: [baseline, ...controls].map((o, i) => ({ schemaVersion: 1, id: randomUUID(), runId, requestId: o.requestId, scenarioId: 'waf-custom', targetRole: o.targetRole, producerId: `${o.targetRole}-producer`, sequence: i + 1, observedAt: time, rayId: o.rayId, releaseDigest: digest, stage: 'entry' })),
    coverage: { healthy: true, complete: true, windowStart: time, watermark: end, producerSequence: 1, gaps: [] },
    expectedRuleId: 'f'.repeat(32), expectedAction: 'block', expectedSource: 'firewallrules',
    config: { enabled: true, scopeMatches: true, ruleId: 'f'.repeat(32), action: 'block', evidence: ref('configuration', null) },
    events: [{ rayId: protectedRequest.rayId, action: 'block', source: 'firewallrules', ruleId: 'f'.repeat(32), observedAt: time, evidence: ref('cloudflare', protectedRequest.requestId) }],
    httpEvidence: [baseline, protectedRequest, ...controls].map(o => ref('http', o.requestId, o.targetRole)),
    originEvidence: [baseline, ...controls].map(o => ref('origin', o.requestId, o.targetRole)).concat([ref('origin', protectedRequest.requestId)]),
    unavailable: [], skipped: false,
  };
}
describe('proof-evaluator', () => {
  it('only verifies the complete joined fixture contract, preserving fixture provenance', () => {
    const result = evaluateEdgeProof(fixture()); expect(result).toEqual({ outcome: 'verified', mode: 'fixture', missingProof: [], contradictions: [] });
  });
  it('rejects 403, 429 and Ray-only evidence without an attributed action', () => {
    for (const status of [403, 429]) { const p = fixture(); p.protected.status = status; p.events = []; expect(evaluateEdgeProof(p).outcome).toBe('inconclusive'); }
  });
  it('requires complete healthy origin coverage, not empty/missing logs', () => {
    for (const patch of [{ healthy: false }, { complete: false }, { watermark: null }, { producerSequence: null }, { gaps: ['delivery gap'] }, { watermark: '2020-01-01T00:00:00.000Z' }]) {
      const p = fixture(); Object.assign(p.coverage, patch); expect(evaluateEdgeProof(p).outcome).toBe('inconclusive');
    }
  });
  it('fails a known protected origin arrival even when prerequisites and proof are missing', () => {
    const p = fixture(); p.receipts.push({ ...p.receipts[0]!, id: randomUUID(), targetRole: 'after', requestId: p.protected.requestId });
    p.events = []; p.unavailable = ['Event permission missing'];
    expect(evaluateEdgeProof(p)).toMatchObject({ outcome: 'failed', contradictions: ['protected stopped before origin'] });
  });
  it('rejects wrong scope, ambiguous rules, missing controls and Worker-only references', () => {
    for (const change of [
      (p: EdgeProof) => { p.events.push({ ...p.events[0]! }); },
      (p: EdgeProof) => { p.events[0]!.ruleId = 'wrong'; },
      (p: EdgeProof) => { p.controls[1]!.status = 500; },
      (p: EdgeProof) => { p.baseline.runId = randomUUID(); },
      (p: EdgeProof) => { p.originEvidence = []; },
      (p: EdgeProof) => { p.events[0]!.evidence.runId = randomUUID(); },
      (p: EdgeProof) => { p.events[0]!.evidence.requestId = randomUUID(); },
      (p: EdgeProof) => { p.originEvidence = p.originEvidence.filter(e => e.requestId !== p.baseline.requestId); },
    ]) { const p = fixture(); change(p); expect(evaluateEdgeProof(p).outcome).toBe('inconclusive'); }
    const wrongConfig = fixture(); wrongConfig.config!.scopeMatches = false; expect(evaluateEdgeProof(wrongConfig).outcome).toBe('failed');
  });
  it('cannot substitute saved or mixed-mode evidence for the current run', () => {
    const saved = fixture(); saved.mode = 'saved'; expect(evaluateEdgeProof(saved).outcome).toBe('inconclusive');
    const mixed = fixture(); mixed.httpEvidence[0]!.mode = 'saved'; expect(evaluateEdgeProof(mixed).outcome).toBe('inconclusive');
  });
  it('requires product-specific sources and preserves unavailable/skipped precedence', () => {
    const p = fixture(); p.unavailable = ['Missing event permission']; expect(evaluateEdgeProof(p).outcome).toBe('unavailable');
    p.unavailable = []; p.skipped = true; expect(evaluateEdgeProof(p).outcome).toBe('skipped');
    const fact = { name: 'verification', state: 'supported' as const, evidence: [p.httpEvidence[0]!] };
    for (const kind of ['turnstile', 'identity', 'mtls', 'waiting-room', 'ddos-evidence', 'analytics'] as const) {
      expect(evaluateProof({ runId: p.runId, scenarioId: p.scenarioId, mode: p.mode, kind, facts: [fact], requiredFacts: ['verification'], unavailable: [], skipped: false }).outcome).toBe('inconclusive');
    }
  });
});
