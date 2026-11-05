import { z } from 'zod';
import { CapabilityState, Digest, EvidenceRefSchema, Id } from '../../contracts/src/schemas.js';
import { labOrigin } from './config.js';
import { executePolicyComparison, policyRequest, isCurrentNativeAccessAdmission, type PolicyComparison, type PolicyIO, type PolicyRun } from './api-shield-proof.js';

const AccessId = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
export const AccessPolicySchema = z.strictObject({
  applicationId: AccessId, policyId: AccessId, audience: Digest,
  beforeOrigin: z.string(), afterOrigin: z.string(), path: z.literal('/admin'),
  capability: CapabilityState, enabled: z.boolean(), baselineExcluded: z.boolean(),
  serviceTokenRef: z.string().regex(/^service-token:lab-[a-z0-9-]{1,60}$/).nullable(),
});
export const AccessReadbackSchema = z.strictObject({
  applicationId: AccessId, policyId: AccessId, audience: Digest,
  hostname: z.string().regex(/^[a-z0-9.-]{1,253}$/), path: z.literal('/admin'),
  enabled: z.boolean(), baselineExcluded: z.boolean(), serviceTokenAllowed: z.boolean(),
  decision: z.literal('non_identity'), bypass: z.boolean(),
});
export type AccessPolicy = z.infer<typeof AccessPolicySchema>;
export interface AccessOptions {
  policy: AccessPolicy; runId: string; mode: 'live' | 'fixture'; releaseDigest: string;
  readback: z.infer<typeof AccessReadbackSchema> | null;
  configurationEvidence: z.infer<typeof EvidenceRefSchema> | null;
}
export function accessPolicyModule(value: AccessPolicy, selected = true) {
  const p = AccessPolicySchema.parse(value);
  const before = new URL(labOrigin(p.beforeOrigin)); const after = new URL(labOrigin(p.afterOrigin));
  if (before.origin === after.origin) throw new Error('Access requires distinct paired hostnames');
  return Object.freeze({ module: 'access' as const, included: selected && p.capability === 'available', blocked: selected && p.capability !== 'available',
    reason: !selected ? 'Module not selected' : p.capability, applicationId: p.applicationId, policyId: p.policyId,
    application: { type: 'self_hosted' as const, domain: `${after.hostname}/admin`, aud: p.audience },
    // Reviewed setup must resolve this reference to the owned service-token ID.
    policy: { decision: 'non_identity' as const, include: p.serviceTokenRef ? [{ serviceTokenRef: p.serviceTokenRef }] : [] },
    hostname: after.hostname, path: p.path, enabled: p.enabled,
  });
}
export function accessComparison(options: AccessOptions): PolicyComparison {
  const p = AccessPolicySchema.parse(options.policy); const module = accessPolicyModule(p); Id.parse(options.runId);
  const r = options.readback === null ? null : AccessReadbackSchema.parse(options.readback);
  const matches = r === null ? null : p.enabled && p.baselineExcluded && r.applicationId === p.applicationId && r.policyId === p.policyId && r.audience === p.audience && r.hostname === module.hostname && r.path === p.path && r.enabled && r.baselineExcluded && !r.bypass && (!p.serviceTokenRef || r.serviceTokenAllowed);
  const requests = [policyRequest(options.runId, 'access', p.beforeOrigin, 'before', '/admin', 'baseline', null), policyRequest(options.runId, 'access', p.afterOrigin, 'after', '/admin', 'missing', null)];
  if (p.serviceTokenRef) requests.push(policyRequest(options.runId, 'access', p.afterOrigin, 'after', '/admin', 'authorized', p.serviceTokenRef));
  return { runId: options.runId, mode: options.mode, releaseDigest: options.releaseDigest, scenarioId: 'access', requests,
    inspection: { matches, evidence: options.configurationEvidence },
    unavailable: p.capability === 'available' ? [] : ['Cloudflare Access capability is unavailable; other modules are unaffected'],
    signalContradicts: (flow, request) => {
      const s = flow.signal;
      if (!s || s.product !== 'access' || s.applicationId !== p.applicationId || s.policyId !== p.policyId || s.audience !== p.audience || s.hostname !== module.hostname || s.path !== p.path) return false;
      return request.case === 'authorized' ? s.action !== 'allow' || s.identity !== 'lab-service-token' : s.action === 'allow';
    },
    signalMatches: (flow, request) => {
      const e = flow.accessEnforcement;
      // Legacy full signals and test callbacks cannot supply native Access proof.
      if (!e || !flow.accessEnforcementEvidence || e.configurationDigest.length !== 64 || e.beforeReadId === e.afterReadId
        || e.configuredPolicyId !== p.policyId) return false;
      if (request.case === 'authorized') {
        if (e.kind !== 'access-service-admission' || request.role !== 'after' || request.origin !== p.afterOrigin || request.path !== p.path
          || request.method !== 'GET' || request.followRedirects !== false || !p.serviceTokenRef || request.credentialRef !== p.serviceTokenRef
          || !isCurrentNativeAccessAdmission(flow, p.applicationId)) return false;
        const f = e.facts;
        return f.mode === options.mode && f.runId === request.runId && f.requestId === request.requestId && f.hostname === module.hostname
          && f.audience === p.audience && f.releaseDigest === options.releaseDigest && f.path === request.path && f.method === request.method
          && f.observedAt <= flow.observation.observedAt && flow.receipts.some(r => r.id === e.receiptId && r.stage === 'entry'
            && r.requestId === request.requestId && r.runId === request.runId && r.releaseDigest === options.releaseDigest);
      }
      // REST documents identity login failures, not missing/invalid nonpersonal
      // service-token coverage. A joined arbitrary login failure is supplemental
      // evidence only; it cannot substitute for the required negative producer.
      return false;
    },
  };
}
export async function runAccessPolicy(options: AccessOptions, io: PolicyIO, signal?: AbortSignal): Promise<PolicyRun> {
  const result = await executePolicyComparison(accessComparison(options), io, signal);
  return qualifyAccessControl(result, options.policy);
}
export function qualifyAccessControl(result: PolicyRun, policy: AccessPolicy): PolicyRun {
  result.decision.missingProof.push('Missing/invalid nonpersonal Access-token denial producer remains unqualified');
  if (result.decision.outcome === 'verified') result.decision.outcome = 'inconclusive';
  if (!policy.serviceTokenRef) {
    result.limitations.push('Authorized lab service-token control is unavailable');
    result.decision.missingProof.push('Protected allowed control is unavailable');
  }
  return result;
}
