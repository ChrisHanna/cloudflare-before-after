import { z } from 'zod';
import { assessExecutionAudit, type ExecutionAuditScope } from './execution-audit.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, linkSync, unlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AcceptanceSchema, Digest, Id, ScenarioId, Time } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { CATALOG } from '../../../scenarios/catalog.js';
import { validateEvidenceDirectory } from './config.js';
import { fallbackEligibility, type ReportStore } from './reports.js';
import { validateCapture, type ScenarioCapture } from './workshop-aggregation.js';
import type { DeploymentVerification } from './deployment-verification-core.js';
import type { InterviewRun } from './interview-timeline.js';
import type { DdosReview } from './ddos-evidence.js';
import type { WaitingRoomResult } from './waiting-room.js';

const Claim = z.strictObject({ verified: z.boolean(), blockers: z.array(z.string().max(256)).max(100) });
export const ReadinessReportSchema = z.strictObject({
  schemaVersion: z.literal(1), id: Id, mode: z.enum(['live', 'fixture']), observedAt: Time,
  scope: z.enum(['core', 'core-waf', 'workshop']), releaseDigest: Digest, configurationDigest: Digest,
  hostnames: z.array(z.hostname()).length(2), includedModules: z.array(ScenarioId).max(11),
  excludedModules: z.array(z.strictObject({ scenarioId: ScenarioId, reason: z.string().min(1).max(256) })).max(11),
  claims: z.strictObject({ coreDeployed: Claim, deploymentVerified: Claim, interviewVerified: Claim, workshopVerified: Claim, fallbackAvailable: Claim }),
  scenarios: z.array(z.strictObject({ scenarioId: ScenarioId, outcome: z.enum(['verified', 'failed', 'inconclusive', 'unavailable', 'skipped']), cleanup: z.enum(['complete', 'incomplete', 'not-needed']), missingProof: z.array(z.string().max(4096)).max(100), currentLiveProof: z.boolean(), requestsUsed: z.number().int().nonnegative(), durationMs: z.number().nonnegative(), evidenceIds: z.array(Id).max(500) })).length(11),
  deploymentChecks: z.array(z.strictObject({ id: z.string().max(256), passed: z.boolean() })).max(100),
  expectedInterviewDurationMs: z.literal(300000),
  fallbacks: z.array(z.strictObject({ scenarioId: ScenarioId, runId: Id, label: z.literal('SAVED EVIDENCE'), historicalOnly: z.boolean(), ageMs: z.number().nonnegative() })).max(11),
  historical: z.boolean(), requestsUsed: z.number().int().nonnegative(), durationMs: z.number().nonnegative(),
}).superRefine((v, ctx) => {
  const claims = Object.entries(v.claims).filter(([key]) => key !== 'fallbackAvailable');
  if (v.mode !== 'live' && claims.some(([, claim]) => claim.verified)) ctx.addIssue({ code: 'custom', message: 'Fixture cannot claim live readiness' });
  if (Object.values(v.claims).some(c => c.verified && c.blockers.length)) ctx.addIssue({ code: 'custom', message: 'Blocked claim cannot pass' });
  if ((v.claims.interviewVerified.verified || v.claims.workshopVerified.verified) && !v.claims.deploymentVerified.verified || v.claims.deploymentVerified.verified && !v.claims.coreDeployed.verified) ctx.addIssue({ code: 'custom', message: 'Readiness claim dependency is missing' });
});
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;
const auditedReports = new WeakMap<object, NonNullable<ReadinessOptions['executionAudit']>>();
/** JSON and status flags cannot carry process-local execution authority. */
export function readinessHasCurrentAudit(report: ReadinessReport): boolean {
  const audit = auditedReports.get(report);
  if (!audit || audit.scope.mode !== report.mode || audit.scope.releaseDigest !== report.releaseDigest || audit.scope.configurationDigest !== report.configurationDigest) return false;
  const assessment = assessExecutionAudit(audit.evidence, audit.scope);
  return assessment.noRepairObserved && assessment.readinessClaimValid;
}
export interface ReadinessOptions {
  mode: 'live' | 'fixture'; scope: ReadinessReport['scope']; observedAt: string;
  releaseDigest: string; configurationDigest: string; hostnames: [string, string];
  includedModules: z.infer<typeof ScenarioId>[]; excludedModules: ReadinessReport['excludedModules'];
  /** Sanitized setup readback, not desired Terraform output. */
  core: { appliedInventoryDigest: string | null; observedInventoryDigest: string | null; reachableRoles: readonly ('before' | 'after')[] };
  deployment: DeploymentVerification; captures: readonly ScenarioCapture[]; interview?: InterviewRun;
  currentScenarioDigests: Partial<Record<z.infer<typeof ScenarioId>, string>>;
  waitingRoom?: WaitingRoomResult; ddos?: DdosReview; setupMutations: number;
  /** Issued boundary evidence, not a caller's count or reloaded JSON. */
  executionAudit?: { evidence: unknown; scope: ExecutionAuditScope };
  /** Measurements from the owning aggregate ledger, not sums of reused evidence. */
  measured: { requestsUsed: number; durationMs: number };
  fallback?: { store: ReportStore; savedRunIds: readonly string[]; now?: number };
}
export function buildReadinessReport(options: ReadinessOptions): ReadinessReport {
  Digest.parse(options.releaseDigest); Digest.parse(options.configurationDigest); Time.parse(options.observedAt);
  z.strictObject({ requestsUsed: z.number().int().nonnegative(), durationMs: z.number().nonnegative() }).parse(options.measured);
  const selected = new Set(options.includedModules);
  if (selected.size !== options.includedModules.length || new Set(options.excludedModules.map(m => m.scenarioId)).size !== options.excludedModules.length || options.excludedModules.some(m => selected.has(m.scenarioId))) throw new Error('Invalid included/excluded module partition');
  if (options.core.appliedInventoryDigest !== null) Digest.parse(options.core.appliedInventoryDigest);
  if (options.core.observedInventoryDigest !== null) Digest.parse(options.core.observedInventoryDigest);
  const captures = options.captures.map(c => validateCapture(c, c.report.result.scenarioId, options.mode));
  if (new Set(captures.map(c => c.report.result.scenarioId)).size !== captures.length) throw new Error('Ambiguous scenario readiness results');
  const current = (c: ScenarioCapture) => c.report.mode === 'live' && c.report.result.releaseDigest === options.releaseDigest && c.report.result.observedConfigDigest !== null && c.report.result.observedConfigDigest === options.currentScenarioDigests[c.report.result.scenarioId] && c.report.result.finishedAt <= options.observedAt && c.report.result.cleanup !== 'incomplete' && c.report.result.outcome === 'verified';
  const core: string[] = [];
  if (options.mode !== 'live') core.push('Fixture is not deployed evidence');
  if (!options.core.appliedInventoryDigest || options.core.appliedInventoryDigest !== options.core.observedInventoryDigest) core.push('Applied core inventory is missing or differs from readback');
  if (!(['before', 'after'] as const).every(role => options.core.reachableRoles.includes(role))) core.push('Both deployed storefronts must be reachable');
  const deployment = [...core, ...options.deployment.blockers];
  const audit = options.executionAudit;
  const auditScopeMatches = !!audit && audit.scope.mode === options.mode && audit.scope.releaseDigest === options.releaseDigest && audit.scope.configurationDigest === options.configurationDigest;
  const auditAssessment = auditScopeMatches ? assessExecutionAudit(audit.evidence, audit.scope) : null;
  if (!auditAssessment?.noRepairObserved || !auditAssessment.readinessClaimValid) deployment.push('Complete independently scoped execution audit is missing or unqualified');
  if (!options.deployment.deploymentVerified || options.deployment.mode !== 'live' || !options.deployment.checks.length || options.deployment.checks.some(c => !c.passed)) deployment.push('Live deployment checks are not verified');
  if (options.deployment.historical || options.deployment.beforeFingerprint !== options.configurationDigest || options.deployment.afterFingerprint !== options.configurationDigest) deployment.push('Deployment fingerprint is historical, changed or unreadable');
  if (new Set(options.hostnames).size !== 2 || options.deployment.hostnames.length !== 2 || !options.hostnames.every(h => options.deployment.hostnames.includes(h))) deployment.push('Tested hostnames differ from requested pair');
  const releaseMatches = (['before', 'after'] as const).every(role => {
    const probes = options.deployment.probes.filter(probe => probe.role === role);
    return probes.length === 1 && probes[0]!.releaseDigest === options.releaseDigest;
  });
  if (!releaseMatches) deployment.push('Deployment release differs from the requested release or is unproven');
  if (options.deployment.observedAt > options.observedAt) deployment.push('Deployment evidence comes from the future');
  for (const id of selected) if (!captures.some(c => c.report.result.scenarioId === id && current(c))) deployment.push(`${id}: live enabled-policy proof is missing`);
  const interview = [...deployment]; const run = options.interview;
  if (!run || run.mode !== 'live' || !run.interviewVerified || !run.sequenceCompleted || run.requestsUsed > 100 || run.durationMs > 300000 || run.stages.length !== 5) interview.push('Five-minute live interview is incomplete');
  if (run) {
    const ids = ['storefronts', 'waf', 'rate-limit', 'waiting-room', 'analytics'];
    const ends = [45000, 105000, 165000, 240000, 300000];
    for (let i = 0; i < ids.length; i++) {
      const stage = run.stages[i];
      if (!stage || stage.id !== ids[i] || stage.outcome !== 'verified' || stage.fallbackLabel || stage.finishedMs > ends[i]! || stage.finishedMs < stage.startedMs || (stage.id === 'waiting-room' && stage.finishedMs - stage.startedMs > 75000)) interview.push(`${ids[i]}: required live stage proof or timing is incomplete`);
      if (i >= 1 && i <= 3 && (!stage?.capture || !current(stage.capture))) interview.push(`${ids[i]}: stage capture is not current live proof`);
      if (stage?.id === 'analytics' && (!stage.analytics || stage.analytics.scope.mode !== 'live' || stage.analytics.outcome !== 'verified')) interview.push('Analytics stage lacks live collected evidence');
    }
  }
  if (options.setupMutations !== 0) { deployment.push('Setup changes occurred during verification'); interview.push('Manual repair or setup changes occurred during the interview'); }
  const room = options.waitingRoom;
  const roomVerified = !!room && room.mode === 'live' && room.liveReadiness && room.outcome === 'verified' && !room.missingProof.length && !room.contradictions.length && room.sessions.every(s => s.cookieContinuity) && room.sessions.some(s => s.role === 'after' && s.transitions.some(t => t.to === 'queued') && s.transitions.some(t => t.from !== 'closed' && t.to === 'admitted'));
  if (!roomVerified) interview.push('Live Waiting Room queue and same-session admission proof is missing');
  const scenarios = CATALOG.map(manifest => {
    const capture = captures.find(c => c.report.result.scenarioId === manifest.id);
    return { scenarioId: manifest.id, outcome: capture?.report.result.outcome ?? 'unavailable' as const, cleanup: capture?.report.result.cleanup ?? 'not-needed' as const,
      missingProof: capture?.report.result.missingProof ?? ['No current scenario result'],
      currentLiveProof: !!capture && current(capture), requestsUsed: capture?.report.result.requestsUsed ?? 0,
      durationMs: capture ? Math.max(0, Date.parse(capture.report.result.finishedAt) - Date.parse(capture.report.result.startedAt)) : 0,
      evidenceIds: capture?.report.result.evidence.map(e => e.id) ?? [] }; 
  });
  const workshop = [...deployment];
  for (const manifest of CATALOG) if (!captures.some(c => c.report.result.scenarioId === manifest.id && current(c))) workshop.push(`${manifest.id}: complete live proof is missing`);
  if (options.excludedModules.length) workshop.push('Excluded products cannot count as a full workshop');
  if (!roomVerified) workshop.push('Live Waiting Room proof is missing');
  if (!options.ddos || options.ddos.outcome !== 'verified' || options.ddos.selection.mode !== 'live' || !options.ddos.events.length || options.ddos.artifactDigest === null) workshop.push('Genuine available DDoS event evidence is missing');
  const fallbacks: ReadinessReport['fallbacks'] = [];
  for (const runId of options.fallback?.savedRunIds ?? []) {
    try {
      const report = options.fallback!.store.load(runId); const manifest = CATALOG.find(m => m.id === report.result.scenarioId)!;
      const e = fallbackEligibility(report, { scenarioId: manifest.id, manifestVersion: manifest.version, releaseDigest: options.releaseDigest, observedConfigDigest: options.currentScenarioDigests[manifest.id] ?? null }, options.fallback?.now);
      fallbacks.push({ scenarioId: manifest.id, runId, label: e.label, historicalOnly: e.historicalOnly, ageMs: e.ageMs });
    } catch { /* Corrupt evidence cannot supply a fallback claim. */ }
  }
  const claim = (blockers: string[]) => ({ verified: blockers.length === 0, blockers: [...new Set(blockers)] });
  const report = ReadinessReportSchema.parse({ schemaVersion: 1, id: randomUUID(), mode: options.mode, observedAt: options.observedAt, scope: options.scope,
    releaseDigest: options.releaseDigest, configurationDigest: options.configurationDigest, hostnames: options.hostnames,
    includedModules: options.includedModules, excludedModules: options.excludedModules,
    claims: { coreDeployed: claim(core), deploymentVerified: claim(deployment), interviewVerified: claim(interview), workshopVerified: claim(workshop),
      fallbackAvailable: claim(fallbacks.some(f => !f.historicalOnly) ? [] : ['No intact matching live saved evidence']) },
    scenarios, fallbacks, deploymentChecks: options.deployment.checks, expectedInterviewDurationMs: 300000,
    historical: options.deployment.historical || !releaseMatches || options.deployment.beforeFingerprint !== options.configurationDigest || options.deployment.afterFingerprint !== options.configurationDigest,
    requestsUsed: options.measured.requestsUsed,
    durationMs: options.measured.durationMs });
  if (auditScopeMatches && audit) auditedReports.set(report, audit);
  return report;
}
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderReadinessHtml(raw: ReadinessReport): string {
  const report = ReadinessReportSchema.parse(raw);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Readiness</title><main><h1>Readiness</h1><p>${report.mode === 'live' ? 'LIVE OBSERVATIONS' : 'FIXTURE'} — ${escape(report.scope)}</p><p>${escape(report.observedAt)}</p><dl><dt>Hostnames</dt><dd>${report.hostnames.map(escape).join(' / ')}</dd><dt>Release</dt><dd>${report.releaseDigest}</dd><dt>Configuration</dt><dd>${report.configurationDigest}</dd><dt>Requests</dt><dd>${report.requestsUsed}</dd><dt>Runtime ms</dt><dd>${report.durationMs}</dd><dt>Expected interview ms</dt><dd>${report.expectedInterviewDurationMs}</dd></dl><h2>Modules</h2><p>Included: ${report.includedModules.map(escape).join(', ')}</p><ul>${report.excludedModules.map(m => `<li>${escape(m.scenarioId)}: ${escape(m.reason)}</li>`).join('')}</ul><table><caption>Separate claims</caption><thead><tr><th>Claim</th><th>Status</th><th>Blockers</th></tr></thead><tbody>${Object.entries(report.claims).map(([name, c]) => `<tr><th>${escape(name)}</th><td>${c.verified ? 'Verified' : 'Incomplete'}</td><td>${c.blockers.map(escape).join('; ')}</td></tr>`).join('')}</tbody></table><h2>Deployment checks</h2><ul>${report.deploymentChecks.map(c => `<li>${escape(c.id)}: ${c.passed ? 'Passed' : 'Incomplete'}</li>`).join('')}</ul><h2>Scenarios</h2><ul>${report.scenarios.map(s => `<li>${escape(s.scenarioId)}: ${s.outcome}; ${s.currentLiveProof ? 'Current live proof' : 'Not current live proof'}; cleanup ${s.cleanup}; requests ${s.requestsUsed}; runtime ${s.durationMs} ms; evidence ${s.evidenceIds.join(', ')}; ${s.missingProof.map(escape).join('; ')}</li>`).join('')}</ul><h2>SAVED EVIDENCE</h2><ul>${report.fallbacks.map(f => `<li>${escape(f.scenarioId)}: ${f.historicalOnly ? 'Historical only' : 'Matching fallback'}; age ${f.ageMs} ms</li>`).join('')}</ul></main></html>`;
}
/** Immutable, checksum-checked AT/readiness records. No cloud writer exists. */
export class ReadinessRecordStore {
  readonly root: string;
  constructor(readonly projectRoot: string, evidenceDirectory: string, readonly redactor = new Redactor()) {
    this.root = join(validateEvidenceDirectory(evidenceDirectory, projectRoot), 'readiness');
    validateEvidenceDirectory(this.root, projectRoot); mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  save(report: ReadinessReport, acceptance: readonly z.infer<typeof AcceptanceSchema>[]): string {
    if (['deploymentVerified', 'interviewVerified', 'workshopVerified'].some(key => report.claims[key as keyof ReadinessReport['claims']].verified) && !readinessHasCurrentAudit(report)) throw new Error('Current independent execution audit required for readiness persistence');
    validateEvidenceDirectory(this.root, this.projectRoot);
    const text = this.redactor.serialize(ReadinessReportSchema, report);
    const parsed = ReadinessReportSchema.parse(JSON.parse(text));
    if (acceptance.length > 100) throw new Error('Acceptance record cap exceeded');
    const records = acceptance.map(record => AcceptanceSchema.parse(JSON.parse(this.redactor.serialize(AcceptanceSchema, record))));
    if (new Set(records.map(r => r.id)).size !== records.length || records.some(r => r.mode !== parsed.mode || r.releaseDigest !== parsed.releaseDigest || r.observedConfigDigest !== parsed.configurationDigest || r.runId !== parsed.id)) throw new Error('Acceptance/readiness scope mismatch');
    const payload = JSON.stringify({ report: parsed, acceptance: records });
    if (Buffer.byteLength(payload) > 500000) throw new Error('Readiness payload exceeds bounded record size');
    const checksum = createHash('sha256').update(payload).digest('hex');
    const destination = join(this.root, `${parsed.id}.json`); const temporary = join(this.root, `.staging-${randomUUID()}`);
    writeFileSync(temporary, JSON.stringify({ checksum, payload }), { flag: 'wx', mode: 0o600 });
    try { linkSync(temporary, destination); } finally { unlinkSync(temporary); }
    return destination;
  }
  load(id: string): { report: ReadinessReport; acceptance: z.infer<typeof AcceptanceSchema>[] } {
    Id.parse(id); validateEvidenceDirectory(this.root, this.projectRoot);
    const path = join(this.root, `${id}.json`); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1048576) throw new Error('Invalid readiness record');
    const envelope = z.strictObject({ checksum: Digest, payload: z.string().max(1000000) }).parse(JSON.parse(readFileSync(path, 'utf8')));
    if (createHash('sha256').update(envelope.payload).digest('hex') !== envelope.checksum) throw new Error('Readiness integrity check failed');
    const result = z.strictObject({ report: ReadinessReportSchema, acceptance: z.array(AcceptanceSchema).max(100) }).parse(JSON.parse(envelope.payload));
    if (result.report.id !== id || new Set(result.acceptance.map(r => r.id)).size !== result.acceptance.length || result.acceptance.some(r => r.runId !== id || r.mode !== result.report.mode || r.releaseDigest !== result.report.releaseDigest || r.observedConfigDigest !== result.report.configurationDigest)) throw new Error('Readiness identity mismatch');
    for (const key of ['deploymentVerified', 'interviewVerified', 'workshopVerified'] as const) if (result.report.claims[key].verified) {
      result.report.claims[key] = { verified: false, blockers: ['Reloaded execution audit is historical and cannot prove current readiness'] };
      result.report.historical = true;
    }
    return result;
  }
}
