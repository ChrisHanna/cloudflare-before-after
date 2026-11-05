import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AcceptanceSchema, BudgetSchema, CapabilityState, CoverageSchema, ExecutionSchema, ManifestSchema, ObservationSchema, ReceiptSchema, ResultSchema } from '../packages/contracts/src/schemas.js';
const time = '2026-11-04T00:00:00.000Z';
const digest = 'a'.repeat(64);
const base = { schemaVersion: 1, runId: randomUUID(), scenarioId: 'waf-custom', outcome: 'inconclusive', evidence: [], missingProof: ['No edge proof'], contradictions: [], releaseDigest: digest, observedConfigDigest: null, startedAt: time, finishedAt: time, requestsUsed: 1, peakConcurrency: 1, sessionsUsed: 0, cleanup: 'complete' };
describe('contracts', () => {
  it('keeps strict, bounded versioned outcomes', () => {
    expect(ResultSchema.parse(base).observedConfigDigest).toBeNull();
    for (const patch of [{ schemaVersion: 2 }, { outcome: 'success' }, { privateKey: 'secret' }, { requestsUsed: -1 }, { finishedAt: '2020-01-01T00:00:00.000Z' }]) expect(ResultSchema.safeParse({ ...base, ...patch }).success).toBe(false);
  });
  it('distinguishes planned and cancelled execution from verified results', () => {
    const budget = { requests: 30, concurrency: 2, sessions: 0, maxRuntimeMs: 60000, cleanupRequests: 1, cleanupMs: 1000 };
    expect(ExecutionSchema.safeParse({ kind: 'planned', mode: 'fixture', targets: ['https://before.example.test'], budget }).success).toBe(true);
    expect(ExecutionSchema.safeParse({ kind: 'planned', mode: 'live', outcome: 'verified', targets: [], budget }).success).toBe(false);
    expect(ExecutionSchema.safeParse({ kind: 'cancelled', result: { ...base, outcome: 'verified' } }).success).toBe(false);
    expect(BudgetSchema.safeParse({ ...budget, cleanupRequests: 31 }).success).toBe(false);
  });
  it('requires actual receipt identity and safe observation fields', () => {
    const receipt = { schemaVersion: 1, id: randomUUID(), runId: base.runId, requestId: randomUUID(), scenarioId: 'waf-custom', targetRole: 'before', producerId: 'container-1', sequence: 1, observedAt: time, rayId: null, releaseDigest: digest, stage: 'entry' };
    expect(ReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(ReceiptSchema.safeParse({ ...receipt, sequence: 0 }).success).toBe(false);
    const obs = { schemaVersion: 1, id: receipt.id, runId: receipt.runId, requestId: receipt.requestId, scenarioId: receipt.scenarioId, targetRole: 'before', mode: 'fixture', observedAt: time, method: 'GET', path: '/test', status: null, latencyMs: 1, rayId: null, action: null, ruleId: null, originCount: null, excerpt: '' };
    expect(ObservationSchema.parse(obs).originCount).toBeNull();
    expect(ObservationSchema.safeParse({ ...obs, path: '/?token=secret' }).success).toBe(false);
  });
  it('preserves unknown coverage and capability states', () => {
    expect(CapabilityState.parse('permission-denied')).toBe('permission-denied');
    expect(CoverageSchema.parse({ healthy: false, complete: false, windowStart: time, watermark: null, producerSequence: null, gaps: ['delivery unknown'] }).watermark).toBeNull();
  });
  it('rejects passing acceptance with a failed predicate', () => {
    expect(AcceptanceSchema.safeParse({ schemaVersion: 1, id: 'AT-13A', mode: 'fixture', requirements: ['13.1'], runId: base.runId, releaseDigest: digest, observedConfigDigest: null, assertions: [{ name: 'Queued', passed: false, evidenceIds: [] }], requestsUsed: 0, durationMs: 1, outcome: 'passed' }).success).toBe(false);
    expect(ManifestSchema.safeParse({ id: 'waf-custom' }).success).toBe(false);
  });
});
