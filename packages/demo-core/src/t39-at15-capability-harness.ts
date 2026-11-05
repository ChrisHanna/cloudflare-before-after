import { randomUUID } from 'node:crypto';
import { assessExecutionAudit } from './execution-audit.js';
import type { DeploymentStore } from './deployment-store.js';
import { sourceDigest } from './deployment-plan.js';
import { AcceptanceSchema } from '../../contracts/src/schemas.js';
import { BudgetLedger, type Clock } from './budget.js';
import { collectDeploymentVerification, type DeploymentProbeOptions } from './deployment-verification-core.js';
import { InterviewTimeline, type InterviewOptions, type InterviewRun } from './interview-timeline.js';
import { buildReadinessReport, type ReadinessOptions, type ReadinessReport } from './readiness-report-core.js';

export interface At15Options {
  deployment: Omit<DeploymentProbeOptions, 'parent' | 'clock'>;
  readiness: Omit<ReadinessOptions, 'deployment' | 'interview' | 'measured'>;
  interview?: Omit<InterviewOptions, 'parent' | 'clock'>;
  clock?: Clock;
  /** Separate harness consent. Config opt-in is still required by collection. */
  liveOptIn?: boolean;
  prerequisites?: readonly string[];
  /** Current source binding, not a credential or caller-fed mutation count. */
  sourceDigest?: string;
  /** Read an already approved exact plan. This harness never approves or applies. */
  liveApproval?: { store: DeploymentStore; planPath: string; planDigest: string };
}
export interface At15Result {
  report: ReadinessReport | null;
  interview: InterviewRun | null;
  records: ReturnType<typeof AcceptanceSchema.parse>[];
  blockers: string[];
}
/** Uses the production collectors, fixed timeline and readiness evaluator.
 * No setup executor exists in this dependency graph. Fixture evidence remains
 * fixture evidence; a passing local test cannot become a deployed AT pass. */
export async function runAt15Acceptance(options: At15Options): Promise<At15Result> {
  const mode = options.deployment.mode;
  const blockers = [...(options.prerequisites ?? [])];
  if (mode === 'live' && (!options.liveOptIn || !options.deployment.config.liveOptIn)) blockers.push('Explicit live acceptance opt-in is required');
  if (options.readiness.mode !== mode || options.interview && options.interview.mode !== mode) blockers.push('Acceptance modes differ');
  if (mode === 'live') {
    try {
      const approval = options.liveApproval;
      if (!approval || !options.sourceDigest) throw new Error('Missing approval');
      const { plan, digest } = approval.store.load(approval.planPath);
      const now = (options.deployment.now ?? Date.now)();
      approval.store.approval(plan, digest, now);
      const config = options.deployment.config;
      if (approval.store.projectRoot !== options.deployment.projectRoot || approval.store.evidenceDirectory !== config.evidenceDirectory ||
          digest !== approval.planDigest || plan.mode !== 'live' || plan.status !== 'review-required' || plan.blockers.length ||
          now < Date.parse(plan.createdAt) || now >= Date.parse(plan.expiresAt) ||
          plan.sourceDigest !== options.sourceDigest || plan.intent.releaseDigest !== options.readiness.releaseDigest ||
          plan.intent.profile !== options.readiness.scope || plan.intent.discovery.accountId !== config.accountId ||
          plan.intent.discovery.zoneId !== config.zoneId || plan.intent.discovery.telemetryOrigin !== config.telemetryOrigin ||
          plan.intent.discovery.environments.some((env, i) => env.origin !== config.environments[i]?.origin) ||
          config.environments.some(env => env.releaseDigest !== options.readiness.releaseDigest) ||
          plan.includedModules.filter(id => id !== 'core').length !== options.readiness.includedModules.length ||
          options.readiness.includedModules.some(id => !plan.includedModules.includes(id)) ||
          sourceDigest(options.deployment.projectRoot) !== options.sourceDigest) throw new Error('Foreign approval');
    } catch { blockers.push('Current exact live-plan approval and source/scope binding required'); }
  }
  const record = (id: string, runId: string, assertions: { name: string; passed: boolean; evidenceIds: string[] }[], requestsUsed: number, durationMs: number, unavailable = false) => AcceptanceSchema.parse({
    schemaVersion: 1, id, mode, runId, releaseDigest: options.readiness.releaseDigest,
    observedConfigDigest: options.readiness.configurationDigest,
    requirements: id === 'AT-15A' ? ['15.1', '15.2', '15.3', '15.4', '15.7'] : id === 'AT-15C' ? ['15.8', '15.9'] : ['15.5', '15.6', '15.7'],
    assertions, requestsUsed, durationMs,
    outcome: unavailable ? 'unavailable' : assertions.every(a => a.passed) ? 'passed' : 'failed',
  });
  if (blockers.length) {
    const runId = randomUUID();
    return { report: null, interview: null, blockers, records: ['AT-15A', 'AT-15B', 'AT-15C'].map(id => record(id, runId, blockers.map(name => ({ name, passed: false, evidenceIds: [] })), 0, 0, true)) };
  }
  const parent = new BudgetLedger({ scope: 'rehearsal', limits: { cleanupRequests: 0, cleanupMs: 0 }, ...(options.clock ? { clock: options.clock } : {}) });
  const start = parent.clock.now();
  try {
    const deployment = await collectDeploymentVerification({ ...options.deployment, parent, ...(options.clock ? { clock: options.clock } : {}) });
    const interview = options.interview ? await new InterviewTimeline({ ...options.interview, parent, ...(options.clock ? { clock: options.clock } : {}) }).run() : undefined;
    const measured = { requestsUsed: parent.snapshot.requestsUsed, durationMs: parent.clock.now() - start };
    const report = buildReadinessReport({ ...options.readiness, deployment, ...(interview ? { interview } : {}), measured });
    const refs = [...new Set(deployment.probes.flatMap(p => [...p.receipts.map(r => r.id), ...p.operations.map(o => o.evidence.id)]))].slice(0, 100);
    const scope = options.readiness.executionAudit?.scope;
    const audit = scope ? assessExecutionAudit(options.readiness.executionAudit!.evidence, scope) : null;
    const auditBound = !!scope && scope.mode === mode && scope.releaseDigest === options.readiness.releaseDigest &&
      scope.configurationDigest === options.readiness.configurationDigest && scope.accountId === options.deployment.config.accountId &&
      scope.zoneId === options.deployment.config.zoneId && !!options.sourceDigest && scope.sourceDigest === options.sourceDigest;
    const a = record('AT-15A', report.id, [
      ...deployment.checks.map(check => ({ name: check.id, passed: check.passed, evidenceIds: refs })),
      { name: 'Current live deployment claim', passed: report.claims.deploymentVerified.verified, evidenceIds: refs },
      { name: 'Deployment-probe command-center publication requires shared integration', passed: false, evidenceIds: [] },
    ], measured.requestsUsed, measured.durationMs);
    const b = record('AT-15B', report.id, [
      { name: 'Five-minute live interview', passed: report.claims.interviewVerified.verified, evidenceIds: [] },
      { name: 'Complete live workshop catalog', passed: report.claims.workshopVerified.verified, evidenceIds: report.scenarios.flatMap(s => s.evidenceIds).slice(0, 100) },
      { name: 'No setup or manual repair', passed: auditBound && !!audit?.noRepairObserved && audit.readinessClaimValid, evidenceIds: [] },
      { name: 'Measured cumulative limits', passed: measured.requestsUsed <= 300 && measured.durationMs <= 900000 && (!interview || interview.requestsUsed <= 100 && interview.durationMs <= 300000), evidenceIds: [] },
    ], measured.requestsUsed, measured.durationMs, !interview);
    // A normal run is not a fault injection. Do not mark the AT-15C safeguard
    // contract passed just because this run did not observe a contradiction.
    const c = record('AT-15C', report.id, [
      { name: 'Current release and fingerprint', passed: !report.historical && options.readiness.releaseDigest === options.deployment.expected.releaseDigest && options.readiness.configurationDigest === deployment.beforeFingerprint && deployment.beforeFingerprint === deployment.afterFingerprint, evidenceIds: refs },
      { name: 'Independent bound no-repair audit', passed: auditBound && !!audit?.noRepairObserved && audit.readinessClaimValid, evidenceIds: [] },
      { name: 'Safeguard fault-injection suite required', passed: false, evidenceIds: [] },
    ], measured.requestsUsed, measured.durationMs, true);
    return { report, interview: interview ?? null, records: [a, b, c], blockers: [...new Set([...report.claims.deploymentVerified.blockers, ...report.claims.interviewVerified.blockers, ...report.claims.workshopVerified.blockers, ...(!auditBound ? ['Current source/account/zone audit binding missing'] : []), ...(audit?.blockers ?? ['Independent execution audit missing']), 'AT-15A deployment probes are not published to command-center run evidence', 'AT-15C fault-injection evidence remains required'])] };
  } finally { parent.stop('AT-15 acceptance finished'); }
}
