import { z } from 'zod';
import { CATALOG } from '../../../scenarios/catalog.js';
import { BudgetLedger, limitsFor, validatePlan, type Clock, type Limits } from './budget.js';
import { DoctorSchema, type DoctorReport } from './doctor.js';
import { ReportSchema, ReportStore, fallbackEligibility, makeArtifact, type Artifact, type Report } from './reports.js';
import type { Manifest } from '../../contracts/src/schemas.js';
import type { DeploymentVerification } from './deployment-verification-core.js';
import type { InterviewRun } from './interview-timeline.js';

export interface SequenceContext {
  /** Pass this parent, limits and signal to concrete scenario runners. */
  parent: BudgetLedger; limits: Limits; signal: AbortSignal;
}
export interface ScenarioCapture { report: Report; artifacts: Artifact[] }
export interface SequenceDriver {
  limits?: Partial<Limits>; minimumRequests?: number; minimumWorkMs?: number;
  /** Monotonic time, shared with the aggregate clock. Never reset remote counters. */
  nextEligibleAt?: number;
  run(context: SequenceContext): Promise<ScenarioCapture>;
}
export interface SequenceItem {
  scenarioId: Manifest['id']; outcome: Report['result']['outcome'];
  capture: ScenarioCapture | null; reason: string | null;
  fallback: { runId: string; label: 'SAVED EVIDENCE'; historicalOnly: boolean; ageMs: number } | null;
  cleanup: Report['result']['cleanup'];
}
/** An abort-resistant adapter cannot hold the sequence beyond its allocated slot.
 * A private parent is stopped at the hard end, fencing late dispatches. Inner
 * lifecycle runners retain the work-to-hard-deadline interval for owned cleanup. */
export async function runSequenceSlot<T>(parent: BudgetLedger, limits: Limits, run: (context: SequenceContext) => Promise<T>, signal?: AbortSignal): Promise<{ state: 'completed'; value: T; requestsUsed: number; interruption: 'cancelled' | 'timeout' | null } | { state: 'cancelled' | 'timeout' | 'error' }> {
  const gate = new BudgetLedger({ scope: parent.scope, parent, limits: { ...limits, cleanupRequests: 0, cleanupMs: 0 } });
  const controller = new AbortController();
  let interrupted = false; let expired = false;
  const stop = () => { interrupted = true; controller.abort(); };
  const effective = signal ? AbortSignal.any([signal, parent.signal]) : parent.signal;
  effective.addEventListener('abort', stop, { once: true });
  if (effective.aborted) stop();
  const cancelWork = parent.clock.schedule(Math.max(0, gate.deadline - limits.cleanupMs - parent.clock.now()), () => { expired = true; controller.abort(); });
  let cancelHard = () => {};
  const end = new Promise<{ state: 'cancelled' | 'timeout' }>(resolve => {
    cancelHard = parent.clock.schedule(Math.max(0, gate.deadline - parent.clock.now()), () => { gate.stop(); resolve({ state: interrupted ? 'cancelled' : 'timeout' }); });
  });
  try {
    if (interrupted) return { state: 'cancelled' };
    const work = Promise.resolve().then(() => run({ parent: gate, limits, signal: controller.signal })).then(value => ({ state: 'completed' as const, value, requestsUsed: gate.snapshot.requestsUsed, interruption: interrupted ? 'cancelled' as const : expired ? 'timeout' as const : null }), () => ({ state: interrupted ? 'cancelled' as const : expired ? 'timeout' as const : 'error' as const }));
    return await Promise.race([work, end]);
  } finally { controller.abort(); cancelWork(); cancelHard(); effective.removeEventListener('abort', stop); gate.stop('Sequence slot finished'); }
}
export function validateCapture(raw: ScenarioCapture, scenarioId: Manifest['id'], mode: 'live' | 'fixture'): ScenarioCapture {
  const report = ReportSchema.parse(raw.report);
  if (report.result.scenarioId !== scenarioId || report.mode !== mode) throw new Error('Scenario capture scope mismatch');
  if (report.result.outcome === 'verified' && (report.result.missingProof.length || report.result.contradictions.length || report.result.observedConfigDigest === null || !report.result.evidence.length)) throw new Error('Verified capture lacks complete proof');
  const built = raw.artifacts.map(a => makeArtifact(a));
  if (built.length !== report.result.evidence.length || new Set(built.map(a => a.ref.id)).size !== built.length || report.result.evidence.some(ref => !built.some(a => JSON.stringify(a.ref) === JSON.stringify(ref)))) throw new Error('Scenario artifact integrity mismatch');
  return { report, artifacts: built.map(a => a.artifact) };
}
export interface AggregateOptions {
  command: 'all' | 'rehearsal'; mode: 'live' | 'fixture'; drivers: Partial<Record<Manifest['id'], SequenceDriver>>;
  clock?: Clock; limits?: Partial<Limits>; signal?: AbortSignal;
  doctor?: { limits: Partial<Limits>; run(context: SequenceContext): Promise<DoctorReport> };
  deploymentCheck?: { limits: Partial<Limits>; minimumRequests: number; run(context: SequenceContext): Promise<DeploymentVerification> };
  interviewCheck?: { minimumRequests: number; run(context: SequenceContext, captures: readonly ScenarioCapture[]): Promise<InterviewRun> };
  /** Uses ReportStore.load, including its artifact-integrity verification. */
  store?: ReportStore; savedRunIds?: Partial<Record<Manifest['id'], string>>;
  currentRevisions?: Partial<Record<Manifest['id'], { releaseDigest: string; observedConfigDigest: string | null }>>;
  now?: () => number;
  onItem?: (item: SequenceItem) => void;
}
export interface AggregateRun {
  schemaVersion: 1; command: 'all' | 'rehearsal'; mode: 'live' | 'fixture';
  doctor: DoctorReport | null; deployment: DeploymentVerification | null; interview: InterviewRun | null;
  items: SequenceItem[]; sequenceCompleted: boolean;
  allRequiredVerified: boolean; cleanRehearsal: boolean; requestsUsed: number;
  durationMs: number; exitCode: 0 | 1 | 130; blockers: string[];
}
export async function runWorkshopAggregate(options: AggregateOptions): Promise<AggregateRun> {
  z.enum(['all', 'rehearsal']).parse(options.command); z.enum(['live', 'fixture']).parse(options.mode);
  const parent = new BudgetLedger({ scope: options.command, limits: { cleanupRequests: 0, cleanupMs: 0, ...options.limits }, ...(options.clock ? { clock: options.clock } : {}) });
  const start = parent.clock.now(); const items: SequenceItem[] = []; const blockers: string[] = [];
  let doctor: DoctorReport | null = null; let doctorGood = options.command === 'all';
  let deployment: DeploymentVerification | null = null; let interview: InterviewRun | null = null;
  try {
    if (options.command === 'rehearsal') {
      if (!options.doctor) blockers.push('Read-only doctor was not supplied');
      else {
        const limits = limitsFor('scenario', options.doctor.limits);
        const result = await runSequenceSlot(parent, limits, options.doctor.run, options.signal);
        if (result.state === 'completed') {
          try { doctor = DoctorSchema.parse(result.value); doctorGood = !result.interruption && doctor.requestsUsed === result.requestsUsed && doctor.mode === options.mode && doctor.scope === 'catalog' && doctor.checks.length > 0 && doctor.checks.every(c => c.state === 'passed');
            if (!doctor.preflightReady) blockers.push('Catalog prerequisites are incomplete; individual configured adapters still run'); } catch { blockers.push('Invalid doctor report'); }
        }
        if (!doctorGood) blockers.push('Doctor prerequisites are incomplete');
      }
    }
    if (options.command === 'rehearsal' && doctorGood) {
      if (!options.deploymentCheck) blockers.push('Deployment verification was not supplied');
      else {
        const check = options.deploymentCheck;
        try {
          const limits = limitsFor('scenario', check.limits); validatePlan(limits, check.minimumRequests, 0);
          if (check.minimumRequests + limits.cleanupRequests > parent.limits.requests - parent.snapshot.requestsUsed) throw new Error('Insufficient cumulative deployment allowance');
          const result = await runSequenceSlot(parent, limits, check.run, options.signal);
          if (result.state === 'completed') deployment = result.value;
          if (result.state !== 'completed' || result.interruption || result.value.requestsUsed !== result.requestsUsed || result.value.mode !== options.mode || result.value.blockers.length || !result.value.checks.length || result.value.checks.some(c => !c.passed) || options.mode === 'live' && !result.value.deploymentVerified) blockers.push('Deployment verification is incomplete');
        } catch { blockers.push('Deployment verification could not fit or execute within its allowance'); }
      }
    }
    for (const manifest of CATALOG) {
      const driver = options.drivers[manifest.id]; let reason: string | null = null;
      let outcome: SequenceItem['outcome'] = 'skipped'; let capture: ScenarioCapture | null = null;
      if (options.signal?.aborted || parent.signal.aborted) reason = 'Sequence stopped';
      else if (!doctorGood) { reason = 'Required doctor checks did not pass'; outcome = 'unavailable'; }
      else if (!driver) { reason = 'Scenario adapter unavailable'; outcome = 'unavailable'; }
      else if (driver.nextEligibleAt !== undefined && parent.clock.now() < driver.nextEligibleAt) { reason = 'Declared cooldown has not elapsed'; outcome = 'unavailable'; }
      else {
        try {
          const limits = limitsFor('scenario', { ...manifest.budget, ...driver.limits });
          const minimum = driver.minimumRequests ?? manifest.minimumRequests;
          validatePlan(limits, minimum, manifest.budget.sessions, driver.minimumWorkMs ?? 0);
          if (minimum + limits.cleanupRequests > parent.limits.requests - parent.snapshot.requestsUsed || parent.clock.now() + (driver.minimumWorkMs ?? 0) + limits.cleanupMs >= parent.workDeadline) reason = 'Remaining aggregate allowance cannot fit proof and cleanup';
          else {
            const result = await runSequenceSlot(parent, limits, driver.run, options.signal);
            if (result.state !== 'completed') { reason = `Scenario ${result.state}; cleanup acknowledgement unavailable`; outcome = 'inconclusive'; }
            else {
              capture = validateCapture(result.value, manifest.id, options.mode);
              if (capture.report.result.requestsUsed !== result.requestsUsed) throw new Error('Scenario bypassed aggregate budget');
              outcome = capture.report.result.outcome;
              if (result.interruption) { reason = `Scenario ${result.interruption}; partial evidence retained`; if (outcome !== 'failed') outcome = 'inconclusive'; }
            }
          }
        } catch { reason = 'Scenario plan, execution or validated evidence failed'; outcome = 'inconclusive'; }
      }
      if (capture && (capture.report.result.cleanup === 'incomplete') && outcome === 'verified') { outcome = 'inconclusive'; reason = 'Owned cleanup is incomplete'; }
      let fallback: SequenceItem['fallback'] = null;
      const savedId = options.savedRunIds?.[manifest.id]; const revision = options.currentRevisions?.[manifest.id];
      if (options.store && savedId && outcome !== 'verified') {
        try {
          const saved = options.store.load(savedId);
          const eligibility = fallbackEligibility(saved, { scenarioId: manifest.id, manifestVersion: manifest.version, releaseDigest: revision?.releaseDigest ?? '', observedConfigDigest: revision?.observedConfigDigest ?? null }, options.now?.() ?? Date.now());
          fallback = { runId: savedId, label: eligibility.label, historicalOnly: !eligibility.eligible, ageMs: eligibility.ageMs };
        } catch { blockers.push(`${manifest.id}: saved evidence integrity unavailable`); }
      }
      // Only complete live proof is eligible for a new live fallback. Partial and
      // fixture results remain returned; callers may save them as labeled reports.
      if (options.store && capture && options.mode === 'live' && outcome === 'verified' && capture.report.result.cleanup !== 'incomplete') {
        try { options.store.save(capture.report, capture.artifacts); } catch { blockers.push(`${manifest.id}: report save failed`); }
      }
      const item: SequenceItem = { scenarioId: manifest.id, outcome, capture, reason, fallback, cleanup: capture?.report.result.cleanup ?? (reason?.includes('cleanup acknowledgement') ? 'incomplete' : 'not-needed') };
      items.push(item); options.onItem?.(item);
    }
    if (options.command === 'rehearsal' && doctorGood && !options.signal?.aborted) {
      const check = options.interviewCheck;
      if (!check) blockers.push('Interview-sequence verification was not supplied');
      else if (!Number.isSafeInteger(check.minimumRequests) || check.minimumRequests < 0 || check.minimumRequests > parent.limits.requests - parent.snapshot.requestsUsed || parent.workDeadline - parent.clock.now() < 300000) blockers.push('Interview-sequence proof cannot fit remaining aggregate allowance');
      else {
        // The interview has its own 100-request/300-second scope, still under
        // the rehearsal root. Its concrete timeline owns stage reservations.
        const limits = limitsFor('interview', { cleanupRequests: 0, cleanupMs: 0 });
        const gate = new BudgetLedger({ scope: 'interview', parent, limits });
        let cancelEnd = () => {};
        // Unlike a scenario's work cancellation, the interview's hard end may
        // end only a presentation hold. Fence traffic immediately, but allow
        // its final report microtasks to finish before declaring a timeout.
        const end = new Promise<null>(resolve => { cancelEnd = parent.clock.schedule(gate.deadline - parent.clock.now(), () => { gate.stop(); setImmediate(() => resolve(null)); }); });
        try {
          const userSignal = options.signal ?? new AbortController().signal;
          const work = Promise.resolve().then(() => check.run({ parent: gate, limits, signal: userSignal }, items.flatMap(i => i.capture ? [i.capture] : []))).catch(() => null);
          interview = await Promise.race([work, end]);
          if (!interview || interview.requestsUsed !== gate.snapshot.requestsUsed || interview.mode !== options.mode || !interview.sequenceCompleted || interview.durationMs > 300000 || interview.requestsUsed > 100 || interview.stages.length !== 5 || interview.exitCode !== 0 || interview.stages.some(s => s.outcome !== 'verified' || s.fallbackLabel) || options.mode === 'live' && !interview.interviewVerified) blockers.push('Interview-sequence verification is incomplete');
        } finally { cancelEnd(); gate.stop('Rehearsal interview finished'); }
      }
    }
    const allRequiredVerified = doctorGood && !blockers.length && items.length === CATALOG.length && items.every(i => i.outcome === 'verified' && i.cleanup !== 'incomplete');
    const cancelled = !!options.signal?.aborted;
    return { schemaVersion: 1, command: options.command, mode: options.mode, doctor, deployment, interview, items,
      sequenceCompleted: !cancelled && items.every(i => i.outcome !== 'skipped'), allRequiredVerified,
      cleanRehearsal: options.command === 'rehearsal' && options.mode === 'live' && allRequiredVerified,
      requestsUsed: parent.snapshot.requestsUsed, durationMs: parent.clock.now() - start,
      exitCode: cancelled ? 130 : allRequiredVerified ? 0 : 1, blockers };
  } finally { parent.stop('Aggregate finished'); }
}
