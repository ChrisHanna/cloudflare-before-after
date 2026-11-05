import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { CoverageSchema, EvidenceRefSchema, Id, Mode, ObservationSchema, ReceiptSchema, Digest, RayId, Time } from '../../contracts/src/schemas.js';
import { evaluateProof, type Decision, type ProofPacket } from './proof.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { TlsClientVerificationSchema, type TlsClientVerification } from '../../contracts/src/tls-client-verification.js';
import { digestValue } from './canonical.js';
import { AccessEnforcementSchema, type AccessAdmission } from '../../contracts/src/access-service-identity.js';
import { observedAccessExchange, type CurrentAccessExchange } from './access-service-identity.js';
import { isCurrentAccessSnapshotPair } from './trusted-collectors.js';

// Only normalized, non-secret product signals cross this boundary. Raw TLS keys,
// Access assertions, headers, cookies and login URLs are deliberately not fields.
export const PolicySignalSchema = z.discriminatedUnion('product', [
  z.strictObject({ product: z.literal('mtls'), policyId: z.string().regex(/^[a-f0-9]{32}$/), hostname: z.string().max(253), path: z.literal('/api'), certificate: z.enum(['missing', 'invalid', 'authorized', 'unknown']), verified: z.boolean().nullable(), revoked: z.boolean().nullable(), fingerprint: Digest.nullable(), action: z.enum(['allow', 'block']), source: z.enum(['cloudflare-client-verification', 'tls-handshake', 'cloudflare-mtls-rule-event']), observedConfigDigest: Digest.optional(), rayId: RayId.optional(), eventTime: Time.optional() }).superRefine((s, context) => {
    const event = s.source === 'cloudflare-mtls-rule-event';
    if (event ? s.certificate !== 'unknown' || s.verified !== null || s.revoked !== null || s.fingerprint !== null || s.action !== 'block' || !s.observedConfigDigest || !s.rayId || !s.eventTime
      : s.certificate === 'unknown' || s.verified === null || s.revoked === null || s.observedConfigDigest !== undefined || s.rayId !== undefined || s.eventTime !== undefined)
      context.addIssue({ code: 'custom', message: 'TLS observations and rule-event observations are distinct sources' });
  }),
  z.strictObject({ product: z.literal('access'), applicationId: z.string().regex(/^[a-f0-9-]{32,36}$/), policyId: z.string().regex(/^[a-f0-9-]{32,36}$/), audience: z.string().regex(/^[a-f0-9]{64}$/), hostname: z.string().max(253), path: z.literal('/admin'), action: z.enum(['allow', 'deny', 'login']), identity: z.enum(['none', 'lab-service-token']), source: z.literal('cloudflare-access') }),
]);
export const PolicyFlowSchema = z.strictObject({
  observation: ObservationSchema, httpEvidence: EvidenceRefSchema,
  signal: PolicySignalSchema.nullable(), verificationEvidence: EvidenceRefSchema.nullable(),
  platformTls: TlsClientVerificationSchema.optional(), platformTlsEvidence: EvidenceRefSchema.optional(),
  accessEnforcement: AccessEnforcementSchema.optional(), accessEnforcementEvidence: EvidenceRefSchema.optional(),
  receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema,
  originEvidence: z.array(EvidenceRefSchema).max(100),
});
export type PolicyFlow = z.infer<typeof PolicyFlowSchema>;
interface AccessFlowSource { proof: AccessAdmission; exchange: CurrentAccessExchange; evaluated: boolean }
const accessFlowSources = new WeakMap<object, { source: AccessFlowSource; digest: string }>();
const adoptedAccessProofs = new WeakSet<object>();
function accessSourceCurrent(source: AccessFlowSource): boolean {
  const { proof, exchange: x } = source; const now = Date.now();
  return !source.evaluated && observedAccessExchange(proof) === x && isCurrentAccessSnapshotPair(x.before, x.after, now)
    && Date.parse(proof.completedAt) <= now && now - Date.parse(x.start) <= 120000;
}
function accessRefMatches(ref: z.infer<typeof EvidenceRefSchema>, flow: PolicyFlow, source: 'http' | 'origin' | 'verification', payload: object, requestId: string | null, observedAt: string): boolean {
  const o = flow.observation; const rayId = 'rayId' in payload ? payload.rayId : null;
  const artifact = { id: ref.id, mode: o.mode, runId: o.runId, scenarioId: 'access', targetRole: 'after', requestId, observedAt, source, payload };
  return ref.source === source && ref.mode === o.mode && ref.runId === o.runId && ref.scenarioId === 'access' && ref.targetRole === 'after'
    && ref.requestId === requestId && ref.observedAt === observedAt && ref.rayId === rayId
    && ref.artifactDigest === createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
}
/** Source identity is captured BEFORE schema/redaction copies it. No schema-shaped
 * callback, copied artifact or caller-supplied digest can create this provenance. */
function retainAccessSource(raw: unknown, parsed: PolicyFlow): void {
  if (!raw || typeof raw !== 'object') return;
  try {
    const known = accessFlowSources.get(raw);
    if (known) {
      if (known.digest !== digestValue(parsed)) known.source.evaluated = true;
      if (known.digest === digestValue(parsed) && accessSourceCurrent(known.source)) accessFlowSources.set(parsed, { source: known.source, digest: known.digest });
      return;
    }
    const original = Reflect.get(raw, 'accessEnforcement') as AccessAdmission | undefined;
    const p = parsed.accessEnforcement;
    if (!original || original.kind !== 'access-service-admission' || p?.kind !== 'access-service-admission' || adoptedAccessProofs.has(original)
      || digestValue(original) !== digestValue(p)) return;
    const x = observedAccessExchange(original); if (!x) return;
    const source: AccessFlowSource = { proof: original, exchange: x, evaluated: false };
    if (!accessSourceCurrent(source)) return;
    const o = parsed.observation; const f = p.facts; const r = x.response;
    if (parsed.signal !== null || parsed.verificationEvidence !== null || o.scenarioId !== 'access' || o.targetRole !== 'after'
      || o.mode !== f.mode || o.runId !== f.runId || o.requestId !== f.requestId || o.method !== f.method || o.path !== f.path
      || o.observedAt !== x.end || o.status !== r.status || r.status !== 200 || o.latencyMs !== r.latencyMs || o.rayId !== r.rayId
      || o.excerpt !== r.excerpt || digestValue(JSON.parse(o.excerpt)) !== digestValue(f)
      || o.action !== null || o.ruleId !== null || o.originCount !== null
      || r.metadata.role !== 'after' || r.metadata.releaseDigest !== f.releaseDigest || r.metadata.contentType !== 'application/json' || r.metadata.bodyBytes > 4096
      || f.observedAt < x.start || f.observedAt > x.end || x.before.observedAt > x.start || x.after.startedAt < x.end
      || p.beforeReadId !== x.before.readId || p.afterReadId !== x.after.readId || p.configurationDigest !== x.before.functionalDigest
      || p.configuredPolicyId !== x.before.configuredPolicyId || f.hostname !== x.before.hostname || f.audience !== x.before.audience
      || !x.origin.requestCompleted || !x.origin.requestEntered || !x.origin.coverage.healthy || !x.origin.coverage.complete || x.origin.coverage.gaps.length
      || digestValue(parsed.receipts) !== digestValue(x.origin.receipts) || digestValue(parsed.coverage) !== digestValue(x.origin.coverage)
      || !parsed.receipts.some(receipt => receipt.id === p.receiptId && receipt.stage === 'entry')
      || !accessRefMatches(parsed.httpEvidence, parsed, 'http', o, o.requestId, o.observedAt)
      || !parsed.accessEnforcementEvidence || !accessRefMatches(parsed.accessEnforcementEvidence, parsed, 'verification', p, o.requestId, p.completedAt)) return;
    const refs = parsed.originEvidence;
    if (refs.length !== parsed.receipts.length + 1 || new Set(refs.map(ref => ref.id)).size !== refs.length) return;
    const coverage = refs.filter(ref => ref.requestId === null);
    if (coverage.length !== 1 || !parsed.coverage.watermark || !accessRefMatches(coverage[0]!, parsed, 'origin', parsed.coverage, null, parsed.coverage.watermark)) return;
    for (const receipt of parsed.receipts) {
      const joined = refs.filter(ref => ref.id === receipt.id && ref.requestId === o.requestId);
      if (joined.length !== 1 || !accessRefMatches(joined[0]!, parsed, 'origin', receipt, o.requestId, receipt.observedAt)) return;
    }
    adoptedAccessProofs.add(original); const digest = digestValue(parsed);
    accessFlowSources.set(raw, { source, digest }); accessFlowSources.set(parsed, { source, digest });
  } catch { /* Missing provenance never grants native credit. */ }
}
export function isCurrentNativeAccessAdmission(flow: PolicyFlow, applicationId: string): boolean {
  try {
    let known = accessFlowSources.get(flow);
    if (!known) { const parsed = PolicyFlowSchema.parse(flow); retainAccessSource(flow, parsed); known = accessFlowSources.get(flow); }
    if (known && known.digest !== digestValue(PolicyFlowSchema.parse(flow))) known.source.evaluated = true;
    return !!known && known.digest === digestValue(PolicyFlowSchema.parse(flow)) && accessSourceCurrent(known.source)
      && known.source.exchange.before.applicationId === applicationId;
  } catch { return false; }
}
function parseCurrentAccessFlow(raw: unknown): PolicyFlow {
  const parsed = PolicyFlowSchema.parse(raw); retainAccessSource(raw, parsed); return parsed;
}
export interface PolicyRequest {
  runId: string; scenarioId: 'api-shield' | 'access'; requestId: string;
  role: 'before' | 'after'; origin: string; method: 'GET'; path: '/api' | '/admin';
  credentialRef: string | null; case: 'baseline' | 'missing' | 'invalid' | 'authorized';
  followRedirects: false;
}
export interface PolicyIO {
  redactor?: Redactor;
  // Implement with the shared guarded permits and an authenticated collector.
  // One exchange includes request AND bounded, budgeted product/origin reads.
  exchange(request: Readonly<PolicyRequest>, signal?: AbortSignal): Promise<unknown>;
}
export interface PolicyInspection { matches: boolean | null; evidence: z.infer<typeof EvidenceRefSchema> | null }
export interface PolicyComparison {
  runId: string; mode: 'live' | 'fixture'; releaseDigest: string;
  scenarioId: 'api-shield' | 'access'; requests: readonly PolicyRequest[];
  inspection: PolicyInspection; unavailable: string[]; missingControls?: readonly string[];
  platformTlsContradicts?(facts: TlsClientVerification): boolean;
  signalMatches(flow: PolicyFlow, request: PolicyRequest): boolean;
  signalContradicts?(flow: PolicyFlow, request: PolicyRequest): boolean;
}
export interface PolicyRun { decision: Decision; requests: PolicyRequest[]; flows: PolicyFlow[]; limitations: string[] }
export function policyRequest(runId: string, scenarioId: PolicyRequest['scenarioId'], origin: string, role: PolicyRequest['role'], path: PolicyRequest['path'], kind: PolicyRequest['case'], credentialRef: string | null): PolicyRequest {
  Id.parse(runId);
  return Object.freeze({ runId, scenarioId, origin, role, path, case: kind, credentialRef, requestId: randomUUID(), method: 'GET', followRedirects: false });
}
export function evaluatePolicyComparison(input: PolicyComparison, raw: readonly unknown[]): Decision {
  Id.parse(input.runId); Mode.parse(input.mode); Digest.parse(input.releaseDigest);
  const flows = raw.map(v => input.scenarioId === 'access' ? parseCurrentAccessFlow(v) : PolicyFlowSchema.parse(v));
  const facts: ProofPacket['facts'] = [];
  const linked = (e: z.infer<typeof EvidenceRefSchema>, source: string, request?: PolicyRequest) => e.source === source && e.runId === input.runId && e.scenarioId === input.scenarioId && e.mode === input.mode && (request ? e.requestId === request.requestId && e.targetRole === request.role : e.requestId === null && e.targetRole === 'after');
  const add = (name: string, state: 'supported' | 'missing' | 'contradicted', evidence: ProofPacket['facts'][number]['evidence']) => facts.push({ name, state, evidence });
  const config = input.inspection;
  add('deployed configuration', config.matches === false ? 'contradicted' : config.matches === true && config.evidence && linked(config.evidence, 'configuration') ? 'supported' : 'missing', config.evidence ? [config.evidence] : []);
  for (const control of input.missingControls ?? []) add(control, 'missing', []);
  const ids = new Set(input.requests.map(r => r.requestId));
  if (ids.size !== input.requests.length || flows.some(f => !ids.has(f.observation.requestId)) || new Set(flows.map(f => f.observation.requestId)).size !== flows.length) throw new Error('Foreign or duplicate policy flow');
  for (const request of input.requests) {
    const f = flows.find(v => v.observation.requestId === request.requestId);
    const label = `${request.role} ${request.case}`;
    if (!f) { add(label, 'missing', []); continue; }
    const o = f.observation;
    const scoped = o.runId === input.runId && o.scenarioId === input.scenarioId && o.targetRole === request.role && o.mode === input.mode && o.path === request.path && o.method === request.method;
    const http = scoped && linked(f.httpEvidence, 'http', request) && f.httpEvidence.observedAt === o.observedAt;
    const originRefs = f.originEvidence.filter(e => linked(e, 'origin', e.requestId === null ? undefined : request) && e.targetRole === request.role);
    // Coverage references are role-scoped, including the Before side.
    const coverageRefs = f.originEvidence.filter(e => e.source === 'origin' && e.runId === input.runId && e.scenarioId === input.scenarioId && e.mode === input.mode && e.targetRole === request.role && e.requestId === null && e.observedAt === f.coverage.watermark);
    const receipt = f.receipts.find(r => r.runId === input.runId && r.scenarioId === input.scenarioId && r.targetRole === request.role && r.requestId === request.requestId && r.stage === 'entry' && r.releaseDigest === input.releaseDigest && r.observedAt >= f.coverage.windowStart && f.coverage.watermark !== null && r.observedAt <= f.coverage.watermark);
    const anyEntry = f.receipts.some(r => r.runId === input.runId && r.scenarioId === input.scenarioId && r.targetRole === request.role && r.requestId === request.requestId && r.stage === 'entry');
    const admitted = request.case === 'baseline' || request.case === 'authorized';
    const origin = admitted ? !!receipt && originRefs.some(e => e.id === receipt.id && e.observedAt === receipt.observedAt) : !anyEntry && f.coverage.healthy && f.coverage.complete && f.coverage.gaps.length === 0 && f.coverage.producerSequence !== null && f.coverage.watermark !== null && f.coverage.watermark >= o.observedAt && f.coverage.windowStart <= o.observedAt && coverageRefs.length > 0;
    const success = o.status !== null && o.status >= 200 && o.status < 300;
    const behavior = admitted ? success : o.status === null || [302, 303, 307, 401, 403].includes(o.status);
    const contrary = scoped && (admitted ? o.status !== null && !success : success || anyEntry);
    add(label, contrary ? 'contradicted' : http && origin && behavior ? 'supported' : 'missing', [f.httpEvidence, ...originRefs, ...coverageRefs]);
    if (request.role === 'after') {
      const tls = f.platformTls; const tlsRef = f.platformTlsEvidence;
      if (tls && tlsRef && request.scenarioId === 'api-shield' && request.case === 'authorized' && input.platformTlsContradicts) {
        let sameBody = false;
        try { const body = JSON.parse(o.excerpt); sameBody = body.synthetic === true && body.requestId === request.requestId && digestValue(body.tlsClientVerification) === digestValue(tls); } catch { /* Missing body is not proof. */ }
        const joined = http && linked(tlsRef, 'verification', request) && tlsRef.observedAt === tls.observedAt && sameBody
          && tls.runId === request.runId && tls.requestId === request.requestId && tls.hostname === new URL(request.origin).hostname
          && tls.releaseDigest === input.releaseDigest && Date.parse(tls.observedAt) >= Date.parse(f.coverage.windowStart) && Date.parse(tls.observedAt) <= Date.parse(o.observedAt);
        if (joined && input.platformTlsContradicts(tls)) add(`${label} platform TLS control`, 'contradicted', [f.httpEvidence, tlsRef]);
      }
      const verificationRef = input.scenarioId === 'access' ? f.accessEnforcementEvidence : f.verificationEvidence;
      const verified = scoped && verificationRef && linked(verificationRef, 'verification', request)
        && (input.scenarioId === 'access' ? !!f.accessEnforcement : verificationRef.observedAt === o.observedAt);
      add(`${label} product attribution`, verified && input.signalContradicts?.(f, request) ? 'contradicted' : verified && input.signalMatches(f, request) ? 'supported' : 'missing', verificationRef ? [verificationRef] : []);
    }
  }
  const decision = evaluateProof({ runId: input.runId, scenarioId: input.scenarioId, mode: input.mode, kind: input.scenarioId === 'api-shield' ? 'mtls' : 'identity', facts, requiredFacts: facts.map(f => f.name), unavailable: input.unavailable, skipped: false });
  if (input.scenarioId === 'access') for (const flow of flows) { const known = accessFlowSources.get(flow); if (known) known.source.evaluated = true; }
  return decision;
}
export async function executePolicyComparison(input: PolicyComparison, io: PolicyIO, signal?: AbortSignal): Promise<PolicyRun> {
  const flows: PolicyFlow[] = []; const requests: PolicyRequest[] = []; const limitations: string[] = [];
  if (!input.unavailable.length && input.inspection.matches === true) {
    for (const request of input.requests) {
      if (signal?.aborted) { limitations.push('Run stopped before the next request'); break; }
      requests.push(request);
      try {
        const raw = await io.exchange(request, signal);
        const redactor = io.redactor ?? new Redactor();
        const flow = PolicyFlowSchema.parse(JSON.parse(redactor.serialize(PolicyFlowSchema, raw)));
        if (input.scenarioId === 'access') retainAccessSource(raw, flow);
        const o = flow.observation;
        if (o.requestId !== request.requestId || o.runId !== request.runId || o.scenarioId !== request.scenarioId || o.targetRole !== request.role || o.path !== request.path || o.method !== request.method || o.mode !== input.mode) throw new Error('Foreign policy observation');
        flows.push(flow);
      }
      catch { limitations.push('Policy exchange or trusted evidence collection failed'); break; }
    }
  }
  if (signal?.aborted && !limitations.length) limitations.push('Run stopped before complete reporting');
  const decision = evaluatePolicyComparison(input, flows);
  if (limitations.length && decision.outcome !== 'failed' && decision.outcome !== 'unavailable') decision.outcome = 'inconclusive';
  decision.missingProof.push(...limitations);
  return { decision, requests, flows, limitations };
}
