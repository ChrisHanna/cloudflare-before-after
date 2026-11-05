import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { captureWorkerReadback, compareWorkerReadbacks, type WorkerReadbackScope } from '../packages/demo-core/src/worker-readback.js';
import type { TrustedBindings, TrustedRead } from '../packages/demo-core/src/trusted-collectors.js';
import type { WorkerCodeFingerprint } from '../packages/contracts/src/worker-code.js';
import { WorkerReadbackSchema, type WorkerReadback } from '../packages/contracts/src/worker-readback.js';
import { digestValue } from '../packages/demo-core/src/canonical.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
const start = '2026-11-04T10:00:00.000Z'; const first = '2026-11-04T10:00:01.000Z'; const last = '2026-11-04T10:00:02.000Z';
function fixture() {
  const scope: WorkerReadbackScope = { runId: randomUUID(), mode: 'fixture', phase: 'before', targetRole: 'after', accountId: 'a'.repeat(32), workerName: 'after-worker', startedAt: start, observedAt: first };
  const bindings = [{ name: 'DB', type: 'd1', database_id: 'owned-database' }];
  const base = { state: 'observed' as const, permission: 'granted' as const, entitlement: 'unknown' as const, mode: 'fixture' as const, observedAt: first, gaps: [] };
  const b: TrustedRead<TrustedBindings> = { ...base, value: { role: 'after', accountId: scope.accountId, workerName: scope.workerName, bindings,
    functionalDigest: digestValue(bindings), releaseDigest: null, containerDigest: null } };
  const c: TrustedRead<WorkerCodeFingerprint> = { ...base, value: { schemaVersion: 1, kind: 'worker-code-fingerprint', source: 'cloudflare-workers-content-v2',
    observedAt: first, targetRole: 'after', accountId: scope.accountId, workerName: scope.workerName, format: 'javascript', moduleCount: 1, contentBytes: 123,
    codeDigest: 'b'.repeat(64), runtimeRelease: null, containerDigest: null } };
  return { scope, b, c };
}
describe('partial observed Worker readback, not a complete deployment state', () => {
  it('retains actual digests without copying a desired release or Container digest', () => {
    const f = fixture(); const snapshot = captureWorkerReadback(f.scope, f.b, f.c);
    expect(snapshot.bindingDigest).toBe(f.b.value!.functionalDigest); expect(snapshot.codeDigest).toBe(f.c.value!.codeDigest);
    expect(snapshot).not.toHaveProperty('releaseDigest'); expect(snapshot).not.toHaveProperty('containerDigest');
    const after = { ...snapshot, phase: 'after' as const, observedAt: last, bindingObservedAt: last, codeObservedAt: last };
    expect(compareWorkerReadbacks(snapshot, after).every(check => check.passed)).toBe(true);
  });
  it.each(['denied', 'unknown', 'mode', 'role', 'name', 'hash', 'stale', 'future'] as const)('leaves %s binding reads unknown instead of guessing', fault => {
    const f = fixture();
    if (fault === 'denied') f.b.permission = 'denied'; if (fault === 'unknown') f.b.state = 'unknown'; if (fault === 'mode') f.b.mode = 'live';
    if (fault === 'role') f.b.value!.role = 'before'; if (fault === 'name') f.b.value!.workerName = 'foreign';
    if (fault === 'hash') f.b.value!.functionalDigest = '9'.repeat(64);
    if (fault === 'stale') f.b.observedAt = '2026-11-04T09:00:00.000Z'; if (fault === 'future') f.b.observedAt = last;
    const value = captureWorkerReadback(f.scope, f.b, f.c); expect(value.bindingDigest).toBeNull(); expect(value.bindingObservedAt).toBeNull(); expect(value.codeDigest).not.toBeNull();
  });
  it.each(['denied', 'unknown', 'mode', 'role', 'name', 'account', 'stale', 'time'] as const)('leaves %s code reads unknown', fault => {
    const f = fixture();
    if (fault === 'denied') f.c.permission = 'denied'; if (fault === 'unknown') f.c.state = 'unknown'; if (fault === 'mode') f.c.mode = 'live';
    if (fault === 'role') f.c.value!.targetRole = 'before'; if (fault === 'name') f.c.value!.workerName = 'foreign'; if (fault === 'account') f.c.value!.accountId = 'c'.repeat(32);
    if (fault === 'stale') f.c.observedAt = '2026-11-04T09:00:00.000Z'; if (fault === 'time') f.c.value!.observedAt = last;
    const value = captureWorkerReadback(f.scope, f.b, f.c); expect(value.codeDigest).toBeNull(); expect(value.codeObservedAt).toBeNull(); expect(value.bindingDigest).not.toBeNull();
  });
  it.each(['code', 'bindings', 'missing', 'run', 'mode', 'role', 'account', 'name', 'phase', 'replay', 'saved'] as const)('never calls %s snapshots unchanged', fault => {
    const f = fixture(); const before = captureWorkerReadback(f.scope, f.b, f.c);
    const after: WorkerReadback = { ...before, phase: 'after' as const, observedAt: last, bindingObservedAt: last, codeObservedAt: last };
    if (fault === 'code') after.codeDigest = 'c'.repeat(64); if (fault === 'bindings') after.bindingDigest = 'c'.repeat(64);
    if (fault === 'missing') { after.codeDigest = null; after.codeObservedAt = null; }
    if (fault === 'run') after.runId = randomUUID(); if (fault === 'mode') after.mode = 'live'; if (fault === 'role') after.targetRole = 'before';
    if (fault === 'account') after.accountId = 'c'.repeat(32); if (fault === 'name') after.workerName = 'foreign';
    if (fault === 'phase') Object.assign(after, { phase: 'before' }); if (fault === 'replay') { after.codeObservedAt = start; after.bindingObservedAt = start; }
    if (fault === 'saved') { before.mode = 'saved'; after.mode = 'saved'; }
    expect(compareWorkerReadbacks(before, after).some(check => !check.passed)).toBe(true);
  });
  it('binds immutable partial artifacts to mode, role, run, source and observation time', () => {
    const f = fixture(); const payload = captureWorkerReadback(f.scope, f.b, f.c);
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: f.scope.runId, scenarioId: 'waf-custom' as const, targetRole: 'after' as const,
      requestId: null, source: 'cloudflare' as const, observedAt: payload.observedAt, payload };
    expect(makeArtifact(artifact).artifact.payload).toEqual(payload);
    expect(() => makeArtifact({ ...artifact, targetRole: 'before' })).toThrow(); expect(() => makeArtifact({ ...artifact, observedAt: last })).toThrow();
    expect(() => makeArtifact({ ...artifact, runId: randomUUID() })).toThrow();
    expect(WorkerReadbackSchema.safeParse({ ...payload, codeObservedAt: last }).success).toBe(false);
    expect(WorkerReadbackSchema.safeParse({ ...payload, releaseDigest: 'a'.repeat(64) }).success).toBe(false);
  });
});
