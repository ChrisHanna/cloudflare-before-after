import { z } from 'zod';
import { Id, Time, FingerprintSchema, ObservationSchema, ReceiptSchema, EvidenceRefSchema } from '../../contracts/src/schemas.js';
import type { Receipt } from '../../contracts/src/schemas.js';
import { ApiShieldReadbackSchema } from './api-shield.js';
import { PolicySignalSchema, type PolicyRequest } from './api-shield-proof.js';
import { makeArtifact, type Artifact } from './reports.js';
import { digestValue } from './canonical.js';
import { TlsClientVerificationSchema, type TlsClientVerification } from '../../contracts/src/tls-client-verification.js';
import type { SafeResponse } from './transport.js';

export interface PlatformTlsScope {
  runId: string; requestId: string; releaseDigest: string; hostname: string; start: string; end: string;
}
/** Decode the same bounded API response, never a new probe or a header assertion. */
export function readPlatformTlsVerification(response: SafeResponse | null, expected: PlatformTlsScope): TlsClientVerification | null {
  if (!response || response.status < 200 || response.status >= 300 || response.metadata.role !== 'after'
    || response.metadata.releaseDigest !== expected.releaseDigest || response.metadata.contentType !== 'application/json'
    || !Number.isSafeInteger(response.metadata.bodyBytes) || response.metadata.bodyBytes < 0 || response.metadata.bodyBytes > 4096 || !Time.safeParse(expected.start).success || !Time.safeParse(expected.end).success
    || Date.parse(expected.start) > Date.parse(expected.end)) return null;
  try {
    const body = z.object({ synthetic: z.literal(true), requestId: Id, tlsClientVerification: TlsClientVerificationSchema.nullable() }).parse(JSON.parse(response.excerpt));
    const facts = body.tlsClientVerification;
    if (!facts || body.requestId !== expected.requestId || facts.runId !== expected.runId || facts.requestId !== expected.requestId
      || facts.releaseDigest !== expected.releaseDigest || facts.hostname !== expected.hostname
      || Date.parse(facts.observedAt) < Date.parse(expected.start) || Date.parse(facts.observedAt) > Date.parse(expected.end)) return null;
    return facts;
  } catch { return null; }
}

export interface PlatformTlsAdmission {
  request: PolicyRequest; facts: unknown; readback: unknown;
  configuration: Artifact | null; configurationEvidence: z.infer<typeof EvidenceRefSchema> | null;
  observation: z.infer<typeof ObservationSchema>; httpEvidence: z.infer<typeof EvidenceRefSchema>;
  receipts: readonly Receipt[]; originEvidence: readonly z.infer<typeof EvidenceRefSchema>[];
}
/** An allow is observed Container admission, not inferred from TLS flags or a status alone. */
export function bindPlatformTlsAdmission(input: PlatformTlsAdmission): z.infer<typeof PolicySignalSchema> | null {
  try {
    const request = input.request; const facts = TlsClientVerificationSchema.parse(input.facts);
    const readback = ApiShieldReadbackSchema.parse(input.readback); const observed = ObservationSchema.parse(input.observation);
    const configuration = input.configuration; const reference = input.configurationEvidence;
    if (request.scenarioId !== 'api-shield' || request.role !== 'after' || request.method !== 'GET' || request.path !== '/api'
      || request.followRedirects !== false || request.case === 'baseline' || !configuration || !reference) return null;
    if (request.case === 'missing' ? request.credentialRef !== null : !/^certificate:lab-[a-z0-9-]{1,60}$/.test(request.credentialRef ?? '')) return null;
    if (!['live', 'fixture'].includes(observed.mode)) return null;
    if (observed.runId !== request.runId || observed.requestId !== request.requestId || observed.scenarioId !== 'api-shield'
      || observed.targetRole !== 'after' || observed.method !== 'GET' || observed.path !== '/api' || observed.status === null || observed.status < 200 || observed.status >= 300) return null;
    const target = new URL(request.origin);
    if (facts.runId !== request.runId || facts.requestId !== request.requestId || target.href !== `https://${facts.hostname}/`
      || readback.hostname !== facts.hostname || !readback.enabled || !readback.baselineExcluded || !readback.requireVerifiedCertificate || !readback.rejectRevoked) return null;
    const fingerprint = FingerprintSchema.parse(configuration.payload);
    if (configuration.source !== 'configuration' || configuration.mode !== observed.mode || configuration.runId !== request.runId
      || configuration.scenarioId !== 'api-shield' || configuration.targetRole !== 'after' || configuration.requestId !== null
      || fingerprint.state !== 'observed' || fingerprint.releaseDigest !== facts.releaseDigest
      || fingerprint.observedConfigDigest !== digestValue(readback) || Date.parse(fingerprint.observedAt) > Date.parse(facts.observedAt)
      || Date.parse(configuration.observedAt) > Date.parse(facts.observedAt) || Date.parse(facts.observedAt) > Date.parse(observed.observedAt)
      || Date.parse(observed.observedAt) - Date.parse(configuration.observedAt) > 120000
      || Date.parse(observed.observedAt) - Date.parse(fingerprint.observedAt) > 120000) return null;
    const body = z.object({ synthetic: z.literal(true), requestId: Id, tlsClientVerification: TlsClientVerificationSchema }).parse(JSON.parse(observed.excerpt));
    if (body.requestId !== request.requestId || digestValue(body.tlsClientVerification) !== digestValue(facts)) return null;
    const sameReference = (actual: z.infer<typeof EvidenceRefSchema>, wanted: z.infer<typeof EvidenceRefSchema>) =>
      digestValue(EvidenceRefSchema.parse(actual)) === digestValue(wanted);
    if (!sameReference(reference, makeArtifact(configuration).ref)) return null;
    const http = makeArtifact({ id: input.httpEvidence.id, mode: observed.mode, runId: request.runId, scenarioId: 'api-shield',
      targetRole: 'after', requestId: request.requestId, observedAt: observed.observedAt, source: 'http', payload: observed });
    if (!sameReference(input.httpEvidence, http.ref)) return null;
    const receipts = input.receipts.map(receipt => ReceiptSchema.parse(receipt)).filter(receipt => receipt.stage === 'entry'
      && receipt.runId === request.runId && receipt.requestId === request.requestId && receipt.scenarioId === 'api-shield'
      && receipt.targetRole === 'after' && receipt.releaseDigest === facts.releaseDigest
      && Date.parse(receipt.observedAt) >= Date.parse(configuration.observedAt) && Date.parse(receipt.observedAt) <= Date.parse(observed.observedAt));
    if (receipts.length !== 1) return null;
    const receipt = receipts[0]!;
    if (receipt.rayId && observed.rayId && receipt.rayId.split('-')[0]!.toLowerCase() !== observed.rayId.split('-')[0]!.toLowerCase()) return null;
    const refs = input.originEvidence.filter(ref => ref.id === receipt.id);
    const origin = makeArtifact({ id: receipt.id, mode: observed.mode, runId: request.runId, scenarioId: 'api-shield',
      targetRole: 'after', requestId: request.requestId, observedAt: receipt.observedAt, source: 'origin', payload: receipt });
    if (refs.length !== 1 || !sameReference(refs[0]!, origin.ref)) return null;
    return PolicySignalSchema.parse({ product: 'mtls', policyId: readback.policyId, hostname: facts.hostname, path: facts.path,
      // This is the guarded client's control-case label, not a claim that the
      // presented certificate was valid. Preserve the actual flags/fingerprint.
      certificate: request.case, verified: facts.certificateVerified, revoked: facts.certificateRevoked,
      fingerprint: facts.fingerprintSha256, action: 'allow', source: 'cloudflare-client-verification' });
  } catch { return null; }
}
