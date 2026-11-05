import { randomUUID } from 'node:crypto';
import type { PolicyFlow, PolicyIO, PolicyRequest } from '../packages/demo-core/src/api-shield-proof.js';
import type { ApiShieldOptions } from '../packages/demo-core/src/api-shield.js';
import type { AccessOptions } from '../packages/demo-core/src/access-policy.js';
import { Redactor } from '../packages/contracts/src/redaction.js';
export const time = '2026-11-04T07:38:00.000Z';
export const end = '2026-11-04T07:38:01.000Z';
export const digest = 'a'.repeat(64);
export const privateKey = '-----BEGIN PRIVATE KEY-----\nfixture-key-only\n-----END PRIVATE KEY-----';
export const token = 'fixture-service-secret-never-live';
export function evidence(scenarioId: 'api-shield' | 'access', runId: string, source: PolicyFlow['httpEvidence']['source'], request?: PolicyRequest): PolicyFlow['httpEvidence'] {
  return { id: randomUUID(), source, mode: 'fixture', observedAt: time, runId, scenarioId, targetRole: request?.role ?? 'after', requestId: request?.requestId ?? null, rayId: null, artifactDigest: digest };
}
export function apiOptions(): ApiShieldOptions {
  const runId = randomUUID();
  return { runId, mode: 'fixture', releaseDigest: digest,
    policy: { policyId: 'b'.repeat(32), beforeOrigin: 'https://before.lab.example', afterOrigin: 'https://after.lab.example', capability: 'available', enabled: true, baselineExcluded: true, path: '/api', authorizedCertificate: { ref: 'certificate:lab-valid', hostname: 'after.lab.example', fingerprint: digest }, invalidCertificateRef: 'certificate:lab-invalid' },
    readback: { policyId: 'b'.repeat(32), hostname: 'after.lab.example', path: '/api', enabled: true, baselineExcluded: true, action: 'block', requireVerifiedCertificate: true, rejectRevoked: true, authorizedFingerprint: digest },
    configurationEvidence: evidence('api-shield', runId, 'configuration'),
  };
}
export function accessOptions(): AccessOptions {
  const runId = randomUUID();
  return { runId, mode: 'fixture', releaseDigest: digest,
    policy: { applicationId: 'c'.repeat(32), policyId: 'd'.repeat(32), audience: digest, beforeOrigin: 'https://before.lab.example', afterOrigin: 'https://after.lab.example', capability: 'available', enabled: true, baselineExcluded: true, path: '/admin', serviceTokenRef: 'service-token:lab-valid' },
    readback: { applicationId: 'c'.repeat(32), policyId: 'd'.repeat(32), audience: digest, hostname: 'after.lab.example', path: '/admin', enabled: true, baselineExcluded: true, serviceTokenAllowed: true, decision: 'non_identity', bypass: false },
    configurationEvidence: evidence('access', runId, 'configuration'),
  };
}
// Synthetic edge and origin fixtures only. They supply observations, never a verdict.
export function fixtureIO(options: ApiShieldOptions | AccessOptions, tamper?: (flow: PolicyFlow, request: PolicyRequest) => void): PolicyIO & { sent: PolicyRequest[] } {
  const sent: PolicyRequest[] = [];
  return { sent, redactor: new Redactor([token, privateKey]), async exchange(request) {
    sent.push(request);
    const mtls = 'authorizedCertificate' in options.policy;
    const credential = mtls ? 'certificate:lab-valid' : 'service-token:lab-valid';
    const allowed = request.role === 'before' || request.credentialRef === credential;
    const flow: PolicyFlow = {
      observation: { schemaVersion: 1, id: randomUUID(), runId: request.runId, requestId: request.requestId, scenarioId: request.scenarioId, targetRole: request.role, mode: 'fixture', observedAt: time, method: 'GET', path: request.path, status: allowed ? 200 : mtls ? 403 : 302, latencyMs: 1, rayId: null, action: null, ruleId: null, originCount: null, excerpt: `synthetic response ${privateKey} ${token}` },
      httpEvidence: evidence(request.scenarioId, request.runId, 'http', request),
      signal: null, verificationEvidence: request.role === 'after' ? evidence(request.scenarioId, request.runId, 'verification', request) : null,
      receipts: [], coverage: { healthy: true, complete: true, windowStart: time, watermark: end, producerSequence: 1, gaps: [] }, originEvidence: [],
    };
    if (request.role === 'after') flow.signal = mtls
      ? { product: 'mtls', policyId: 'b'.repeat(32), hostname: 'after.lab.example', path: '/api', certificate: request.credentialRef === credential ? 'authorized' : request.credentialRef ? 'invalid' : 'missing', verified: allowed, revoked: false, fingerprint: allowed ? digest : null, action: allowed ? 'allow' : 'block', source: 'cloudflare-client-verification' }
      : { product: 'access', applicationId: 'c'.repeat(32), policyId: 'd'.repeat(32), audience: digest, hostname: 'after.lab.example', path: '/admin', action: allowed ? 'allow' : 'login', identity: allowed ? 'lab-service-token' : 'none', source: 'cloudflare-access' };
    const coverage = evidence(request.scenarioId, request.runId, 'origin'); coverage.targetRole = request.role; coverage.observedAt = end; flow.originEvidence.push(coverage);
    if (allowed) {
      const ref = evidence(request.scenarioId, request.runId, 'origin', request); flow.originEvidence.push(ref);
      flow.receipts.push({ schemaVersion: 1, id: ref.id, runId: request.runId, requestId: request.requestId, scenarioId: request.scenarioId, targetRole: request.role, producerId: 'synthetic-container', sequence: sent.length, observedAt: time, rayId: null, releaseDigest: digest, stage: 'entry' });
    }
    tamper?.(flow, request); return flow;
  } };
}
