import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { BotSettingsSchema, BotSummarySchema, CoverageSchema, Digest, EvidenceRefSchema, FingerprintSchema, Id, Label, Mode, ObservationSchema, ReceiptSchema, RateSettingsSchema, RateSummarySchema, ResultSchema, Role, ScenarioId, Time } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { validateEvidenceDirectory } from './config.js';
import { AnalyticsSummarySchema } from './analytics.js';
import { DdosCaptureSchema } from './ddos-evidence.js';
import { PolicySignalSchema } from './api-shield-proof.js';
import { ServiceReadReceiptSchema } from '../../contracts/src/service-read.js';
import { WaitingRoomRecordSchema } from '../../contracts/src/waiting-room.js';
import { AccessAuthenticationEvidenceSchema } from '../../contracts/src/access-authentication.js';
import { AccessEnforcementSchema, AccessSnapshotSchema } from '../../contracts/src/access-service-identity.js';
import { TlsClientVerificationSchema } from '../../contracts/src/tls-client-verification.js';
import { WorkerCodeFingerprintSchema } from '../../contracts/src/worker-code.js';
import { WorkerReadbackSchema } from '../../contracts/src/worker-readback.js';
import { D1WriteReadReceiptSchema } from '../../contracts/src/d1-probe.js';
import { R2WriteReadReceiptSchema } from '../../contracts/src/r2-probe.js';
import { ImageDeliveryReadbackSchema, PublicVariantProofSchema } from '../../contracts/src/public-variant-proof.js';
const Text = z.string().max(4096);
export const ArtifactSchema = z.strictObject({
  id: Id, mode: Mode, runId: Id, scenarioId: ScenarioId, targetRole: Role, requestId: Id.nullable(), observedAt: Time,
  source: z.enum(['http', 'origin', 'cloudflare', 'verification', 'browser', 'configuration']),
  payload: z.union([
    ObservationSchema, ReceiptSchema, CoverageSchema, FingerprintSchema, AccessEnforcementSchema, AccessSnapshotSchema, AccessAuthenticationEvidenceSchema, TlsClientVerificationSchema, WorkerCodeFingerprintSchema, WorkerReadbackSchema, D1WriteReadReceiptSchema, R2WriteReadReceiptSchema, PublicVariantProofSchema,
    z.strictObject({ kind: z.literal('configuration'), product: z.enum(['Custom WAF rules', 'Rate limiting']), rateLimit: RateSettingsSchema.optional(), botManagement: BotSettingsSchema.optional(), rulesetId: z.string().regex(/^[a-f0-9]{32}$/), rulesetVersion: z.string().max(128), ruleId: z.string().regex(/^[a-f0-9]{32}$/), ref: z.string().max(128), enabled: z.boolean(), action: z.string().min(1).max(100), expression: Text, afterHostname: z.string().max(253), order: z.number().int().positive().nullable().optional() }),
    z.strictObject({ kind: z.literal('edge'), rayId: z.string().max(32), action: z.string().max(100), ruleId: z.string().max(128).nullable(), product: z.string().max(100), hostname: z.string().max(253), eventTime: Time, sampling: z.enum(['unknown', 'sampled', 'complete']), botScore: z.number().int().min(0).max(99).nullable().optional() }),
    z.strictObject({ kind: z.literal('verification'), accepted: z.boolean(), verificationMode: z.enum(['test', 'live']), policyId: z.string().max(128), reason: z.string().max(256), policySignal: PolicySignalSchema.optional() }),
    z.strictObject({ kind: z.literal('ddos'), capture: DdosCaptureSchema }),
    z.strictObject({ kind: z.literal('service-read'), receipt: ServiceReadReceiptSchema }),
    z.strictObject({ kind: z.literal('owned-image-decode'), role: Role, runId: Id, requestId: Id, scenarioId: ScenarioId, releaseDigest: Digest, resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), variant: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(), source: z.literal('observed-browser'), width: z.number().int().min(1).max(512), height: z.number().int().min(1).max(512), bodyBytes: z.number().int().min(1).max(32768), encodedDigest: Digest, pixelDigest: Digest, delivery: ImageDeliveryReadbackSchema.optional(), applicationJoin: z.literal('unknown') }),
    z.strictObject({ kind: z.literal('browser'), sessionLabel: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), state: z.enum(['queued', 'admitted', 'unknown']), cookieContinuity: z.boolean(), source: z.literal('observed-page') }),
  ]),
}).superRefine((a, ctx) => {
  const payload = a.payload;
  if ('kind' in payload && payload.kind === 'service-read' && (payload.receipt.runId !== a.runId || payload.receipt.requestId !== a.requestId || payload.receipt.scenarioId !== a.scenarioId || payload.receipt.targetRole !== a.targetRole || payload.receipt.observedAt !== a.observedAt)) ctx.addIssue({ code: 'custom', message: 'Service receipt artifact join mismatch' });
  if ('kind' in payload && payload.kind === 'owned-image-decode') {
    if (payload.role !== a.targetRole) ctx.addIssue({ code: 'custom', message: 'Image artifact role mismatch' });
    if (payload.delivery && (payload.delivery.resourceId !== payload.resourceId || payload.delivery.variant !== payload.variant || payload.delivery.encodedDigest !== payload.encodedDigest)) ctx.addIssue({ code: 'custom', message: 'Image artifact actual delivery tuple mismatch' });
  }
  if ('kind' in payload && payload.kind === 'access-service-admission') {
    const f = payload.facts;
    if (a.source !== 'verification' || a.scenarioId !== 'access' || a.targetRole !== 'after' || a.requestId !== f.requestId
      || a.runId !== f.runId || a.mode !== f.mode || a.observedAt !== payload.completedAt) ctx.addIssue({ code: 'custom', message: 'Access service admission artifact join mismatch' });
  }
  if ('kind' in payload && payload.kind === 'access-application-rejection' && (a.source !== 'verification' || a.scenarioId !== 'access'
    || a.targetRole !== 'after' || a.requestId === null || a.observedAt !== payload.observedAt)) ctx.addIssue({ code: 'custom', message: 'Access rejection artifact join mismatch' });
  if ('kind' in payload && payload.kind === 'access-config-snapshot' && (a.source !== 'configuration' || a.scenarioId !== 'access'
    || a.targetRole !== 'after' || a.requestId !== null || a.id !== payload.readId || a.observedAt !== payload.observedAt)) ctx.addIssue({ code: 'custom', message: 'Access snapshot artifact join mismatch' });
  if ('kind' in payload && payload.kind === 'access-authentication' && (a.scenarioId !== 'access' || a.targetRole !== 'after' || a.requestId === null)) ctx.addIssue({ code: 'custom', message: 'Access authentication artifact scope mismatch' });
  if ('kind' in payload && (payload.kind === 'd1-write-read' || payload.kind === 'r2-write-read') && (a.scenarioId !== 'waf-custom' || a.requestId === null || payload.observedAt !== a.observedAt)) ctx.addIssue({ code: 'custom', message: 'Storage probe artifact scope mismatch' });
  if ('kind' in payload && (payload.kind === 'worker-code-fingerprint' || payload.kind === 'worker-readback') && (payload.observedAt !== a.observedAt || a.requestId !== null)) ctx.addIssue({ code: 'custom', message: 'Worker code artifact scope mismatch' });
  if ('kind' in payload && payload.kind === 'public-variant-proof' && (payload.observedAt !== a.observedAt || a.requestId !== null || a.targetRole !== 'before')) ctx.addIssue({ code: 'custom', message: 'Public dependency artifact scope mismatch' });
  if ('kind' in payload && payload.kind === 'tls-client-verification' && payload.observedAt !== a.observedAt) ctx.addIssue({ code: 'custom', message: 'TLS platform artifact time mismatch' });
  if ('kind' in payload && payload.kind === 'configuration' && ((payload.product === 'Rate limiting') !== (payload.rateLimit !== undefined))) ctx.addIssue({ code: 'custom', message: 'Configuration product/settings mismatch' });
  if ('runId' in payload && (payload.runId !== a.runId || payload.scenarioId !== a.scenarioId)) ctx.addIssue({ code: 'custom', message: 'Artifact scope mismatch' });
  if ('mode' in payload && payload.mode !== a.mode) ctx.addIssue({ code: 'custom', message: 'Artifact payload mode mismatch' });
  if ('targetRole' in payload && payload.targetRole !== a.targetRole) ctx.addIssue({ code: 'custom', message: 'Artifact role mismatch' });
  if ('requestId' in payload && payload.requestId !== a.requestId) ctx.addIssue({ code: 'custom', message: 'Artifact request mismatch' });
  const kind = 'kind' in payload ? payload.kind : 'stage' in payload ? 'receipt' : 'status' in payload ? 'http' : 'windowStart' in payload ? 'coverage' : 'configuration';
  const source = kind === 'receipt' || kind === 'coverage' ? 'origin' : kind === 'edge' || kind === 'ddos' || kind === 'access-authentication' || kind === 'worker-code-fingerprint' || kind === 'worker-readback' || kind === 'public-variant-proof' ? 'cloudflare' : kind === 'service-read' || kind === 'tls-client-verification' || kind === 'd1-write-read' || kind === 'r2-write-read' ? 'verification' : kind === 'owned-image-decode' ? 'browser' : kind;
  const accessSource = kind === 'access-config-snapshot' ? 'configuration' : kind === 'access-service-admission' || kind === 'access-application-rejection' ? 'verification' : source;
  if (accessSource !== a.source) ctx.addIssue({ code: 'custom', message: 'Artifact source mismatch' });
});
export type Artifact = z.infer<typeof ArtifactSchema>;
export const ReportSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: Mode, manifestVersion: z.number().int().positive(), createdAt: Time,
  result: ResultSchema, rateLimitSummary: RateSummarySchema.optional(), botSummary: BotSummarySchema.optional(),
  analytics: z.lazy(() => AnalyticsSummarySchema).optional(),
  waitingRoom: WaitingRoomRecordSchema.optional(),
  notes: z.strictObject({ problem: Text, solution: Text, limitations: Text, question: Text }),
}).superRefine((r, ctx) => { if (r.waitingRoom && (r.result.scenarioId !== 'waiting-room' || r.waitingRoom.mode !== r.mode)) ctx.addIssue({ code: 'custom', message: 'Waiting Room report scope mismatch' }); if (r.result.evidence.some(e => e.mode !== r.mode || e.runId !== r.result.runId || e.scenarioId !== r.result.scenarioId)) ctx.addIssue({ code: 'custom', message: 'Report evidence provenance mismatch' }); });
export type Report = z.infer<typeof ReportSchema>;
const IndexSchema = z.strictObject({ schemaVersion: z.literal(1), runId: Id, reportDigest: Digest, htmlDigest: Digest, artifacts: z.array(z.strictObject({ id: Id, digest: Digest })).max(500) });
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function readBounded(file: string, cap = 4 * 1024 * 1024): string {
  const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > cap) throw new Error('Invalid bounded report file');
  return readFileSync(file, 'utf8');
}
export function makeArtifact(input: Artifact, redactor = new Redactor()) {
  const text = redactor.serialize(ArtifactSchema, input); const artifact = ArtifactSchema.parse(JSON.parse(text));
  const ref = EvidenceRefSchema.parse({ id: artifact.id, source: artifact.source, mode: artifact.mode, observedAt: artifact.observedAt, runId: artifact.runId, scenarioId: artifact.scenarioId, targetRole: artifact.targetRole, requestId: artifact.requestId, rayId: 'rayId' in artifact.payload ? artifact.payload.rayId : null, artifactDigest: sha(text) });
  return { artifact, ref, text };
}
function reportHtml(report: Report, artifacts: readonly Artifact[], json: string): string {
  const observations = artifacts.flatMap(a => { const p = ObservationSchema.safeParse(a.payload); return p.success ? [p.data] : []; });
  const receipts = artifacts.flatMap(a => { const p = ReceiptSchema.safeParse(a.payload); return p.success && p.data.stage === 'entry' ? [p.data] : []; });
  const originState = (o: z.infer<typeof ObservationSchema>) => {
    if (receipts.some(r => r.requestId === o.requestId && r.targetRole === o.targetRole)) return 'Received';
    const latest = artifacts.filter(a => a.source === 'origin' && a.targetRole === o.targetRole && CoverageSchema.safeParse(a.payload).success).at(-1);
    const coverage = latest ? CoverageSchema.parse(latest.payload) : null;
    return coverage?.healthy && coverage.complete && !coverage.gaps.length && coverage.producerSequence !== null && coverage.watermark !== null && coverage.windowStart <= o.observedAt && coverage.watermark >= o.observedAt ? 'Not received' : 'Unknown';
  };
  const rows = observations.map(o => `<tr><td>${escape(o.targetRole)}</td><td>${escape(o.path)}</td><td>${o.status ?? 'Unknown'}</td><td>${o.latencyMs}</td><td>${originState(o)}</td><td>${escape(o.rayId ?? 'Unknown')}</td></tr>`).join('');
  const actions = new Set<string>(); const edges: string[] = []; const policies: string[] = [];
  for (const artifact of artifacts) {
    const p = artifact.payload;
    if ('kind' in p && p.kind === 'edge') {
      const key = `${p.rayId}:${p.product}:${p.ruleId}:${p.action}:${p.eventTime}`;
      if (!actions.has(key)) { actions.add(key); edges.push(`<tr><td>${escape(p.product)}</td><td>${escape(p.action)}</td><td>${escape(p.ruleId ?? 'Unknown')}</td><td>${escape(p.rayId)}</td><td>${escape(p.sampling)}</td></tr>`); }
    }
    if ('kind' in p && p.kind === 'configuration') policies.push(`<section><h3>${escape(p.product)}</h3><dl><dt>Rule</dt><dd>${escape(p.ruleId)}</dd><dt>Action</dt><dd>${escape(p.action)}</dd><dt>After host</dt><dd>${escape(p.afterHostname)}</dd><dt>Version</dt><dd>${escape(p.rulesetVersion)}</dd></dl><pre>${escape(p.expression)}</pre></section>`);
  }
  const rateSummary = report.rateLimitSummary ? `<section><h2>After rate signals</h2><p>Admitted: ${report.rateLimitSummary.admitted ?? 'Unknown'}; mitigated: ${report.rateLimitSummary.mitigated ?? 'Unknown'}; unknown: ${report.rateLimitSummary.unknown ?? 'Unknown'}</p><p>Shared key: ${escape(report.rateLimitSummary.sharedKeyContamination)}; cooldown until: ${escape(report.rateLimitSummary.cooldownUntil ?? 'Unknown')}</p><p>Allowed controls are excluded. No counter reset was sent.</p></section>` : '';
  const botSummary = report.botSummary ? `<section><h2>Bot observations</h2><p>Declared client: ${escape(report.botSummary.userAgent)}</p><p>Score: ${report.botSummary.score ?? 'Unknown'}; action: ${escape(report.botSummary.action ?? 'Unknown')}; classification: ${escape(report.botSummary.classification)}</p><p>Subscription readback: ${escape(report.botSummary.subscriptionReadback)}. No fingerprint evasion or assumed blocking.</p></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Cloudflare demo report</title><style>body{background:Canvas;color:CanvasText;color-scheme:light dark;font:16px system-ui;margin:2rem}table{border-collapse:collapse}th,td{border:1px solid currentColor;padding:.5rem;text-align:left}pre{white-space:pre-wrap;overflow-wrap:anywhere}.scroll{overflow:auto}</style></head><body><main><h1>${escape(report.result.scenarioId)}</h1><p>${report.mode === 'live' ? 'SAVED EVIDENCE — LIVE CAPTURE' : report.mode === 'saved' ? 'SAVED EVIDENCE' : 'FIXTURE'}</p><p>Outcome: ${escape(report.result.outcome)}</p><p>${escape(report.createdAt)}</p><div class="scroll" tabindex="0" aria-label="Request comparison"><table><caption>Request evidence</caption><thead><tr><th scope="col">Role</th><th scope="col">Path</th><th scope="col">Status</th><th scope="col">Latency ms</th><th scope="col">Origin</th><th scope="col">Ray ID</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Edge actions</h2><table><thead><tr><th>Product</th><th>Action</th><th>Rule</th><th>Ray ID</th><th>Sampling</th></tr></thead><tbody>${edges.join('')}</tbody></table><p>Responses alone do not prove mitigation.</p>${policies.join('')}${rateSummary}${botSummary}${report.analytics ? `<section><h2>Analytics: ${escape(report.analytics.label)}</h2>${report.analytics.roles.map(r => `<p>${r.role}: requests ${r.observedRequests ?? 'Unknown'}; origin ${r.originReceipts ?? 'Unknown'}; edge ${r.edgeEvents ?? 'Unknown'}</p>`).join('')}<ul>${report.analytics.missingProof.map(m => `<li>${escape(m)}</li>`).join('')}</ul></section>` : ''}<h2>Customer problem</h2><p>${escape(report.notes.problem)}</p><h2>Solution</h2><p>${escape(report.notes.solution)}</p><h2>Limits</h2><p>${escape(report.notes.limitations)}</p><h2>Discussion</h2><p>${escape(report.notes.question)}</p><details><summary>JSON record</summary><pre>${escape(json)}</pre></details></main></body></html>`;
}
export class ReportStore {
  readonly root: string;
  constructor(readonly projectRoot: string, evidenceDirectory: string, readonly redactor = new Redactor()) {
    this.root = validateEvidenceDirectory(evidenceDirectory, projectRoot);
  }
  #directory(...parts: string[]): string {
    const path = join(this.root, ...parts); validateEvidenceDirectory(path, this.projectRoot); mkdirSync(path, { recursive: true, mode: 0o700 }); validateEvidenceDirectory(path, this.projectRoot); return path;
  }
  save(input: Report, artifacts: readonly Artifact[]): string {
    const text = this.redactor.serialize(ReportSchema, input); const report = ReportSchema.parse(JSON.parse(text));
    const built = artifacts.map(a => makeArtifact(a, this.redactor));
    if (new Set(built.map(a => a.artifact.id)).size !== built.length) throw new Error('Duplicate artifact ID');
    for (const ref of report.result.evidence) {
      const a = built.find(a => a.artifact.id === ref.id);
      if (!a || JSON.stringify(a.ref) !== JSON.stringify(ref)) throw new Error('Evidence reference does not match stored artifact');
    }
    if (built.length !== report.result.evidence.length) throw new Error('Unreferenced artifacts rejected');
    const runs = this.#directory('runs'); const reservations = this.#directory('reservations');
    const lock = join(reservations, `${report.result.runId}.lock`); const fd = openSync(lock, 'wx', 0o600);
    const staging = join(runs, `.staging-${randomUUID()}`); const destination = join(runs, report.result.runId);
    try {
      if (existsSync(destination)) throw new Error('Run report already exists');
      mkdirSync(staging, { mode: 0o700 });
      const html = reportHtml(report, built.map(a => a.artifact), text);
      writeFileSync(join(staging, 'report.json'), text, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(staging, 'report.html'), html, { flag: 'wx', mode: 0o600 });
      for (const a of built) writeFileSync(join(staging, `${a.artifact.id}.json`), a.text, { flag: 'wx', mode: 0o600 });
      const index = IndexSchema.parse({ schemaVersion: 1, runId: report.result.runId, reportDigest: sha(text), htmlDigest: sha(html), artifacts: built.map(a => ({ id: a.artifact.id, digest: a.ref.artifactDigest })) });
      writeFileSync(join(staging, 'index.json'), JSON.stringify(index), { flag: 'wx', mode: 0o600 });
      renameSync(staging, destination); return destination;
    } finally { closeSync(fd); unlinkSync(lock); if (existsSync(staging)) rmSync(staging, { recursive: true }); }
  }
  loadArtifacts(runId: string): Artifact[] {
    const report = this.load(runId);
    return report.result.evidence.map(ref => ArtifactSchema.parse(JSON.parse(readBounded(join(this.root, 'runs', runId, `${ref.id}.json`), 65536))));
  }
  loadHtml(runId: string): string {
    this.load(runId);
    return readBounded(join(this.root, 'runs', runId, 'report.html'));
  }
  load(runId: string): Report {
    Id.parse(runId); const directory = join(this.root, 'runs', runId); validateEvidenceDirectory(directory, this.projectRoot);
    const index = IndexSchema.parse(JSON.parse(readBounded(join(directory, 'index.json'))));
    const text = readBounded(join(directory, 'report.json')); const html = readBounded(join(directory, 'report.html'));
    if (index.runId !== runId || sha(text) !== index.reportDigest || sha(html) !== index.htmlDigest) throw new Error('Report integrity check failed');
    const report = ReportSchema.parse(JSON.parse(text));
    if (report.result.runId !== runId || report.result.evidence.length !== index.artifacts.length || new Set(index.artifacts.map(a => a.id)).size !== index.artifacts.length) throw new Error('Report identity mismatch');
    for (const entry of index.artifacts) {
      const artifactText = readBounded(join(directory, `${entry.id}.json`));
      if (sha(artifactText) !== entry.digest) throw new Error('Evidence integrity check failed');
      const actual = makeArtifact(ArtifactSchema.parse(JSON.parse(artifactText)));
      const ref = report.result.evidence.find(r => r.id === entry.id);
      if (!ref || JSON.stringify(actual.ref) !== JSON.stringify(ref) || ref.artifactDigest !== entry.digest) throw new Error('Stored artifact reference mismatch');
    }
    return report;
  }
}
export function fallbackEligibility(report: Report, current: { scenarioId: string; manifestVersion: number; releaseDigest: string; observedConfigDigest: string | null }, now = Date.now()) {
  report = ReportSchema.parse(report);
  const ageMs = now - Date.parse(report.createdAt);
  const compatible = report.mode === 'live' && report.result.outcome === 'verified' && report.result.scenarioId === current.scenarioId && report.manifestVersion === current.manifestVersion && report.result.releaseDigest === current.releaseDigest && current.observedConfigDigest !== null && report.result.observedConfigDigest === current.observedConfigDigest && ageMs >= 0;
  return { eligible: compatible, label: 'SAVED EVIDENCE' as const, historicalOnly: !compatible, ageMs: Math.max(0, ageMs) };
}
export const JournalEvent = z.strictObject({
  schemaVersion: z.literal(1), runId: Id, sequence: z.number().int().positive().max(1000), observedAt: Time,
  event: z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('started'), scenarioId: ScenarioId, mode: Mode, labId: Label, accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/), releaseDigest: Digest }),
    z.strictObject({ type: z.literal('phase'), phase: z.enum(['planned', 'preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup', 'finished']) }),
    z.strictObject({ type: z.literal('observation'), observation: ObservationSchema }),
    z.strictObject({ type: z.literal('outcome'), result: ResultSchema }),
    z.strictObject({ type: z.literal('evidence'), artifact: ArtifactSchema }),
  ]),
}).superRefine((v, ctx) => { const detail = v.event.type === 'observation' ? v.event.observation : v.event.type === 'outcome' ? v.event.result : v.event.type === 'evidence' ? v.event.artifact : null; if (detail && detail.runId !== v.runId) ctx.addIssue({ code: 'custom', message: 'Foreign journal event' }); });
const JournalOwner = z.strictObject({ runId: Id, ownerId: Id });
export class RunJournal {
  readonly directory: string;
  constructor(projectRoot: string, evidenceDirectory: string, readonly runId: string, readonly redactor = new Redactor()) {
    Id.parse(runId); this.directory = join(validateEvidenceDirectory(evidenceDirectory, projectRoot), 'journal', runId);
    validateEvidenceDirectory(this.directory, projectRoot); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); validateEvidenceDirectory(this.directory, projectRoot);
  }
  claim(ownerId: string): void { writeFileSync(join(this.directory, 'owner.json'), JSON.stringify(JournalOwner.parse({ runId: this.runId, ownerId })), { flag: 'wx', mode: 0o600 }); }
  append(ownerId: string, event: z.infer<typeof JournalEvent>['event']): number {
    const owner = JournalOwner.parse(JSON.parse(readBounded(join(this.directory, 'owner.json'), 4096)));
    if (owner.ownerId !== Id.parse(ownerId) || owner.runId !== this.runId) throw new Error('Journal owner mismatch');
    const entries = this.read(0); const sequence = entries.length + 1;
    const value = { schemaVersion: 1, runId: this.runId, sequence, observedAt: new Date().toISOString(), event };
    const text = this.redactor.serialize(JournalEvent, value);
    const temporary = join(this.directory, `.event-${randomUUID()}`); const final = join(this.directory, `${String(sequence).padStart(4, '0')}.json`);
    const reservation = openSync(`${final}.lock`, 'wx', 0o600);
    try { if (existsSync(final)) throw new Error('Journal sequence already exists'); writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 }); renameSync(temporary, final); }
    finally { closeSync(reservation); unlinkSync(`${final}.lock`); if (existsSync(temporary)) unlinkSync(temporary); }
    return sequence;
  }
  read(after: number): z.infer<typeof JournalEvent>[] {
    if (!Number.isInteger(after) || after < 0 || after > 1000) throw new Error('Invalid journal position');
    const files = readdirSync(this.directory).filter(f => /^\d{4}\.json$/.test(f)).sort();
    if (files.length > 1000) throw new Error('Journal exceeds cap');
    const events = files.map((name, i) => { const event = JournalEvent.parse(JSON.parse(readBounded(join(this.directory, name), 65536))); if (event.runId !== this.runId || event.sequence !== i + 1 || name !== `${String(event.sequence).padStart(4, '0')}.json`) throw new Error('Journal sequence gap'); return event; });
    return events.filter(e => e.sequence > after);
  }
}
