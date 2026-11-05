import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionSchema, AccessServiceIdentitySchema, AccessSnapshotSchema } from '../packages/contracts/src/access-service-identity.js';
import { bindAccessServiceAdmission } from '../packages/demo-core/src/access-service-identity.js';
import { observedAccessSnapshot } from '../packages/demo-core/src/trusted-collectors.js';
import { accessComparison } from '../packages/demo-core/src/access-policy.js';
import { evaluatePolicyComparison, executePolicyComparison, policyRequest, type PolicyFlow } from '../packages/demo-core/src/api-shield-proof.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';

const time = '2026-11-05T00:00:00.000Z';
function facts() { return { schemaVersion: 1, kind: 'access-service-identity', source: 'verified-rs256-service-jwt',
  channel: 'authenticated-same-request-https', mode: 'fixture', targetRole: 'after', scenarioId: 'access',
  runId: randomUUID(), requestId: randomUUID(), nonce: randomUUID(), releaseDigest: 'a'.repeat(64),
  hostname: 'after.example.test', path: '/admin', method: 'GET', observedAt: time, audience: '3'.repeat(64), issuer: 'https://synthetic-team.cloudflareaccess.com',
  issuerMatched: true, clientIdMatched: true, identity: 'lab-service-token', signatureVerified: true,
  policyId: null, perRequestEvaluation: 'unknown' }; }
describe('strict sanitized Access bridge contracts and private one-shot binding', () => {
  it('keeps configured policy separate from approving policy and full runtime state', () => {
    const observation = AccessServiceIdentitySchema.parse(facts());
    const admission = AccessAdmissionSchema.parse({ schemaVersion: 1, kind: 'access-service-admission', channel: 'authenticated-same-request-https',
      facts: observation, beforeReadId: randomUUID(), afterReadId: randomUUID(), configurationDigest: 'b'.repeat(64),
      configuredPolicyId: '2'.repeat(32), approvingPolicyId: null, receiptId: randomUUID(), completedAt: time, fullRuntimeState: null });
    // Even a perfectly shaped object from a test callback is not current proof.
    expect(bindAccessServiceAdmission(admission)).toBeNull();
  });
  it('F2 rejects forged and cloned callback-only admission at matcher and evaluator boundaries', async () => {
    const f = AccessServiceIdentitySchema.parse(facts()); const q = { ...policyRequest(f.runId, 'access', 'https://after.example.test', 'after', '/admin', 'authorized', 'service-token:lab-only'), requestId: f.requestId };
    const receipt = { schemaVersion: 1 as const, id: randomUUID(), runId: q.runId, requestId: q.requestId, scenarioId: 'access' as const, targetRole: 'after' as const,
      releaseDigest: f.releaseDigest, producerId: 'invented', sequence: 1, observedAt: time, rayId: null, stage: 'entry' as const };
    const proof = AccessAdmissionSchema.parse({ schemaVersion: 1, kind: 'access-service-admission', channel: 'authenticated-same-request-https', facts: f,
      beforeReadId: randomUUID(), afterReadId: randomUUID(), configurationDigest: 'b'.repeat(64), configuredPolicyId: '2'.repeat(32), approvingPolicyId: null,
      receiptId: receipt.id, completedAt: time, fullRuntimeState: null });
    const observation = { schemaVersion: 1 as const, id: randomUUID(), runId: q.runId, requestId: q.requestId, scenarioId: 'access' as const, targetRole: 'after' as const,
      mode: 'fixture' as const, observedAt: time, method: 'GET' as const, path: '/admin', status: 200, latencyMs: 1, rayId: null, action: null, ruleId: null, originCount: null, excerpt: JSON.stringify(f) };
    const base = { mode: 'fixture' as const, runId: q.runId, requestId: q.requestId, scenarioId: 'access' as const, targetRole: 'after' as const, observedAt: time };
    const flow: PolicyFlow = { observation, httpEvidence: makeArtifact({ ...base, id: randomUUID(), source: 'http', payload: observation }).ref,
      signal: null, verificationEvidence: null, accessEnforcement: proof, accessEnforcementEvidence: makeArtifact({ ...base, id: randomUUID(), source: 'verification', payload: proof }).ref,
      receipts: [receipt], originEvidence: [makeArtifact({ ...base, id: receipt.id, source: 'origin', payload: receipt }).ref], coverage: { healthy: true, complete: true, gaps: [], windowStart: time, watermark: time, producerSequence: 1 } };
    const comparison = accessComparison({ policy: { applicationId: '1'.repeat(32), policyId: proof.configuredPolicyId, audience: f.audience,
      beforeOrigin: 'https://before.example.test', afterOrigin: q.origin, path: '/admin', capability: 'available', enabled: true, baselineExcluded: true, serviceTokenRef: q.credentialRef },
      runId: q.runId, mode: 'fixture', releaseDigest: f.releaseDigest, readback: null, configurationEvidence: null });
    comparison.requests = [q];
    for (const candidate of [flow, structuredClone(flow)]) {
      expect(comparison.signalMatches(candidate, q)).toBe(false);
      expect(evaluatePolicyComparison(comparison, [candidate]).missingProof).toContain('after authorized product attribution');
      const result = await executePolicyComparison({ ...comparison, inspection: { matches: true, evidence: null } }, { exchange: async () => candidate });
      expect(result.decision.missingProof).toContain('after authorized product attribution');
    }
  });
  it.each(['email', 'sub', 'common_name', 'assertion', 'jwt', 'clientId', 'clientSecret', 'policy', 'cookie', 'error', 'jku'])('rejects raw/private %s', field => {
    expect(AccessServiceIdentitySchema.safeParse({ ...facts(), [field]: 'PRIVATE-CANARY' }).success).toBe(false);
  });
  it.each(['runId', 'requestId', 'nonce', 'releaseDigest', 'hostname', 'audience', 'observedAt', 'source', 'mode', 'targetRole', 'path', 'method', 'identity', 'signatureVerified', 'issuerMatched', 'clientIdMatched'])(
    'requires typed %s', field => {
      const value: Record<string, unknown> = facts(); delete value[field];
      expect(AccessServiceIdentitySchema.safeParse(value).success).toBe(false);
      value[field] = 'PRIVATE CANARY'; expect(AccessServiceIdentitySchema.safeParse(value).success).toBe(false);
    });
  it('rejects invented policy IDs, denial identity and per-request evaluation', () => {
    expect(AccessServiceIdentitySchema.safeParse({ ...facts(), policyId: '2'.repeat(32) }).success).toBe(false);
    expect(AccessServiceIdentitySchema.safeParse({ ...facts(), identity: 'none' }).success).toBe(false);
    expect(AccessServiceIdentitySchema.safeParse({ ...facts(), perRequestEvaluation: 'verified' }).success).toBe(false);
  });
  it('does not adopt deserialized snapshots or save Client IDs', () => {
    const snapshot = AccessSnapshotSchema.parse({ schemaVersion: 1, kind: 'access-config-snapshot', source: 'guarded-access-app-policy-token-reads',
      runId: randomUUID(), scenarioId: 'access', targetRole: 'after', phase: 'before', mode: 'fixture', readId: randomUUID(), observedAt: time, startedAt: time, generation: 1,
      accountId: 'a'.repeat(32), applicationId: '1'.repeat(32), configuredPolicyId: '2'.repeat(32), audience: '3'.repeat(64),
      hostname: 'after.example.test', path: '/admin', functionalDigest: 'b'.repeat(64), tokenMapped: true });
    expect(observedAccessSnapshot(snapshot, {}, Date.parse(time))).toBeNull();
    expect(AccessSnapshotSchema.safeParse({ ...snapshot, clientId: 'PRIVATE-CLIENT.access' }).success).toBe(false);
    expect(AccessSnapshotSchema.safeParse({ ...snapshot, mode: 'saved' }).success).toBe(false);
  });
});
