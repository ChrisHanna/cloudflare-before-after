import { WorkerReadbackSchema, type WorkerReadback } from '../../contracts/src/worker-readback.js';
import { WorkerCodeFingerprintSchema, type WorkerCodeFingerprint } from '../../contracts/src/worker-code.js';
import type { TrustedBindings, TrustedRead } from './trusted-collectors.js';
import { digestValue } from './canonical.js';
import { Time } from '../../contracts/src/schemas.js';
export interface WorkerReadbackScope {
  runId: string; mode: 'live' | 'fixture'; phase: 'before' | 'after'; targetRole: 'before' | 'after';
  accountId: string; workerName: string; startedAt: string; observedAt: string;
}
function fresh(time: string, start: string, end: string): boolean {
  return Time.safeParse(time).success && Date.parse(time) >= Date.parse(start) && Date.parse(time) <= Date.parse(end);
}
/** Retain only independently observed partial data. No expected release/container fields. */
export function captureWorkerReadback(scope: WorkerReadbackScope, bindings: TrustedRead<TrustedBindings>, code: TrustedRead<WorkerCodeFingerprint>): WorkerReadback {
  Time.parse(scope.startedAt); Time.parse(scope.observedAt);
  if (Date.parse(scope.startedAt) > Date.parse(scope.observedAt)) throw new Error('Invalid readback window');
  const b = bindings.value;
  const bindingKnown = bindings.state === 'observed' && bindings.permission === 'granted' && bindings.mode === scope.mode
    && fresh(bindings.observedAt, scope.startedAt, scope.observedAt) && b?.role === scope.targetRole && b.workerName === scope.workerName
    && b.functionalDigest === digestValue(b.bindings);
  const parsed = WorkerCodeFingerprintSchema.safeParse(code.value); const c = parsed.success ? parsed.data : null;
  const codeKnown = code.state === 'observed' && code.permission === 'granted' && code.mode === scope.mode
    && fresh(code.observedAt, scope.startedAt, scope.observedAt) && c?.targetRole === scope.targetRole && c.accountId === scope.accountId
    && c.workerName === scope.workerName && c.observedAt === code.observedAt;
  return WorkerReadbackSchema.parse({ schemaVersion: 1, kind: 'worker-readback', source: 'independent-provider-reads',
    runId: scope.runId, scenarioId: 'waf-custom', mode: scope.mode, phase: scope.phase, targetRole: scope.targetRole, accountId: scope.accountId,
    workerName: scope.workerName, startedAt: scope.startedAt, observedAt: scope.observedAt, bindingObservedAt: bindingKnown ? bindings.observedAt : null,
    codeObservedAt: codeKnown ? code.observedAt : null, bindingDigest: bindingKnown ? b!.functionalDigest : null, codeDigest: codeKnown ? c!.codeDigest : null });
}
export function compareWorkerReadbacks(before: WorkerReadback, after: WorkerReadback): { id: string; passed: boolean }[] {
  const a = WorkerReadbackSchema.parse(before); const b = WorkerReadbackSchema.parse(after);
  const joined = ['live', 'fixture'].includes(a.mode) && a.runId === b.runId && a.mode === b.mode && a.targetRole === b.targetRole && a.accountId === b.accountId && a.workerName === b.workerName
    && a.phase === 'before' && b.phase === 'after' && a.startedAt === b.startedAt && Date.parse(a.observedAt) <= Date.parse(b.observedAt)
    && [b.bindingObservedAt, b.codeObservedAt].every(time => time === null || Date.parse(time) >= Date.parse(a.observedAt));
  return [
    { id: `${a.targetRole}-worker-readback-available`, passed: joined && !!a.bindingDigest && !!b.bindingDigest && !!a.codeDigest && !!b.codeDigest },
    { id: `${a.targetRole}-worker-code-unchanged`, passed: joined && a.codeDigest !== null && b.codeDigest !== null && a.codeDigest === b.codeDigest },
    { id: `${a.targetRole}-worker-bindings-unchanged`, passed: joined && a.bindingDigest !== null && b.bindingDigest !== null && a.bindingDigest === b.bindingDigest },
  ];
}
