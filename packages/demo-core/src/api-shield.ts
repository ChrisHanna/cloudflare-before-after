import { z } from 'zod';
import { CapabilityState, Digest, EvidenceRefSchema, Id } from '../../contracts/src/schemas.js';
import { labOrigin } from './config.js';
import { digestValue } from './canonical.js';
import { executePolicyComparison, policyRequest, type PolicyComparison, type PolicyIO, type PolicyInspection, type PolicyRun } from './api-shield-proof.js';

const ResourceId = z.string().regex(/^[a-f0-9]{32}$/);
const CertificateSchema = z.strictObject({ ref: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/), hostname: z.string().regex(/^[a-z0-9.-]{1,253}$/), fingerprint: Digest });
export const ApiShieldPolicySchema = z.strictObject({
  policyId: ResourceId, beforeOrigin: z.string(), afterOrigin: z.string(),
  capability: CapabilityState, enabled: z.boolean(), baselineExcluded: z.boolean(),
  path: z.literal('/api'), authorizedCertificate: CertificateSchema,
  invalidCertificateRef: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/).nullable(),
});
export type ApiShieldPolicy = z.infer<typeof ApiShieldPolicySchema>;
export const ApiShieldReadbackSchema = z.strictObject({
  policyId: ResourceId, hostname: z.string().regex(/^[a-z0-9.-]{1,253}$/), path: z.literal('/api'),
  enabled: z.boolean(), baselineExcluded: z.boolean(), action: z.literal('block'),
  requireVerifiedCertificate: z.boolean(), rejectRevoked: z.boolean(), authorizedFingerprint: Digest,
});
export interface ApiShieldOptions {
  policy: ApiShieldPolicy; runId: string; mode: 'live' | 'fixture'; releaseDigest: string;
  readback: z.infer<typeof ApiShieldReadbackSchema> | null;
  configurationEvidence: z.infer<typeof EvidenceRefSchema> | null;
}
export function apiShieldModule(value: ApiShieldPolicy, selected = true) {
  const p = ApiShieldPolicySchema.parse(value);
  const before = new URL(labOrigin(p.beforeOrigin)); const after = new URL(labOrigin(p.afterOrigin));
  if (before.origin === after.origin || p.authorizedCertificate.hostname !== after.hostname || p.invalidCertificateRef === p.authorizedCertificate.ref) throw new Error('Certificate or paired hostname scope mismatch');
  return Object.freeze({ module: 'api-shield' as const, included: selected && p.capability === 'available',
    blocked: selected && p.capability !== 'available', reason: !selected ? 'Module not selected' : p.capability,
    hostname: after.hostname, path: p.path, enabled: p.enabled, action: 'block' as const,
    policyId: p.policyId, phase: 'http_request_firewall_custom' as const,
    // Declarative setup only. Scenario execution has no setup/write dependency.
    expression: `(http.host eq ${JSON.stringify(after.hostname)} and http.request.uri.path eq "/api" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked or not cf.tls_client_auth.cert_fingerprint_sha256 in {${JSON.stringify(p.authorizedCertificate.fingerprint)}}))`,
    certificateRef: p.authorizedCertificate.ref,
  });
}
export function apiShieldComparison(options: ApiShieldOptions): PolicyComparison {
  const p = ApiShieldPolicySchema.parse(options.policy); const module = apiShieldModule(p); Id.parse(options.runId);
  const observed = options.readback === null ? null : ApiShieldReadbackSchema.parse(options.readback);
  const inspection: PolicyInspection = { evidence: options.configurationEvidence, matches: observed === null ? null : p.enabled && p.baselineExcluded && observed.policyId === p.policyId && observed.hostname === module.hostname && observed.path === p.path && observed.enabled && observed.baselineExcluded && observed.requireVerifiedCertificate && observed.rejectRevoked && observed.authorizedFingerprint === p.authorizedCertificate.fingerprint };
  const requests = [policyRequest(options.runId, 'api-shield', p.beforeOrigin, 'before', '/api', 'baseline', null), policyRequest(options.runId, 'api-shield', p.afterOrigin, 'after', '/api', 'missing', null)];
  if (p.invalidCertificateRef) requests.push(policyRequest(options.runId, 'api-shield', p.afterOrigin, 'after', '/api', 'invalid', p.invalidCertificateRef));
  requests.push(policyRequest(options.runId, 'api-shield', p.afterOrigin, 'after', '/api', 'authorized', p.authorizedCertificate.ref));
  const ruleEventMatches = (flow: Parameters<PolicyComparison['signalMatches']>[0]) => {
    const s = flow.signal;
    return s?.product === 'mtls' && s.source === 'cloudflare-mtls-rule-event' && observed !== null
      && s.observedConfigDigest === digestValue(observed) && !!flow.observation.rayId && !!s.rayId && !!s.eventTime
      && s.rayId.split('-')[0]!.toLowerCase() === flow.observation.rayId.split('-')[0]!.toLowerCase()
      && Date.parse(s.eventTime) >= Date.parse(flow.coverage.windowStart) && Date.parse(s.eventTime) <= Date.parse(flow.observation.observedAt);
  };
  return { runId: options.runId, mode: options.mode, releaseDigest: options.releaseDigest, scenarioId: 'api-shield', requests, inspection,
    missingControls: p.invalidCertificateRef ? [] : ['Protected invalid-certificate control unavailable'],
    platformTlsContradicts: facts => facts.certificateVerified !== true || facts.certificateRevoked !== false || facts.fingerprintSha256 !== p.authorizedCertificate.fingerprint,
    unavailable: p.capability === 'available' ? [] : ['API Shield mTLS capability is unavailable; other modules are unaffected'],
    signalContradicts: (flow, request) => {
      const s = flow.signal;
      if (!s || s.product !== 'mtls' || s.policyId !== p.policyId || s.hostname !== module.hostname || s.path !== p.path) return false;
      if (s.source === 'cloudflare-mtls-rule-event') return request.case === 'authorized' && ruleEventMatches(flow);
      if (s.certificate !== request.case) return false;
      return request.case === 'authorized' ? s.action !== 'allow' || s.verified !== true || s.revoked !== false || s.fingerprint !== p.authorizedCertificate.fingerprint : s.action === 'allow';
    },
    signalMatches: (flow, request) => {
      const s = flow.signal;
      if (!s || s.product !== 'mtls' || s.policyId !== p.policyId || s.hostname !== module.hostname || s.path !== p.path) return false;
      if (s.source === 'cloudflare-mtls-rule-event') return ['missing', 'invalid'].includes(request.case) && ruleEventMatches(flow) && [401, 403].includes(flow.observation.status ?? 0);
      if (s.certificate !== request.case) return false;
      return request.case === 'authorized' ? s.action === 'allow' && s.verified === true && s.revoked === false && s.fingerprint === p.authorizedCertificate.fingerprint && s.source === 'cloudflare-client-verification'
        : s.action === 'block' && (request.case === 'missing' ? s.verified === false && s.fingerprint === null : s.verified === false || s.revoked === true || s.fingerprint !== p.authorizedCertificate.fingerprint) && (flow.observation.status === null ? s.source === 'tls-handshake' : [401, 403].includes(flow.observation.status));
    },
  };
}
export async function runApiShield(options: ApiShieldOptions, io: PolicyIO, signal?: AbortSignal): Promise<PolicyRun> {
  const result = await executePolicyComparison(apiShieldComparison(options), io, signal);
  if (!options.policy.invalidCertificateRef) result.limitations.push('Invalid lab certificate flow is unsupported; it was not tested');
  return result;
}
