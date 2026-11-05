import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { platformTlsVerification } from '../apps/storefront-worker/src/tls-client-verification.js';
import { bindPlatformTlsAdmission, type PlatformTlsAdmission } from '../packages/demo-core/src/platform-tls.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import { digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { ObservationSchema, type Receipt } from '../packages/contracts/src/schemas.js';
import { apiShieldComparison } from '../packages/demo-core/src/api-shield.js';
import type { PolicyFlow } from '../packages/demo-core/src/api-shield-proof.js';

const start = '2026-11-04T10:00:00.000Z'; const observedAt = '2026-11-04T10:00:00.500Z'; const end = '2026-11-04T10:00:01.000Z';
function fixture() {
  const runId = randomUUID(); const requestId = randomUUID(); const releaseDigest = 'a'.repeat(64);
  const facts = platformTlsVerification({ tlsClientAuth: { certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0', certFingerprintSHA256: 'b'.repeat(64) } },
    { runId, requestId, releaseDigest, hostname: 'after.example.test', observedAt })!;
  const readback = { policyId: 'c'.repeat(32), hostname: facts.hostname, path: '/api' as const, enabled: true,
    baselineExcluded: true, action: 'block' as const, requireVerifiedCertificate: true, rejectRevoked: true, authorizedFingerprint: 'b'.repeat(64) };
  const configuration = makeArtifact({ id: randomUUID(), mode: 'fixture', runId, scenarioId: 'api-shield', targetRole: 'after', requestId: null,
    observedAt: start, source: 'configuration', payload: { schemaVersion: 1, observedAt: start, releaseDigest,
      observedConfigDigest: digestValue(readback), inventoryDigest: 'd'.repeat(64), state: 'observed' } });
  const observation = ObservationSchema.parse({ schemaVersion: 1, id: randomUUID(), mode: 'fixture', runId, requestId,
    scenarioId: 'api-shield', targetRole: 'after', observedAt: end, method: 'GET', path: '/api', status: 200,
    latencyMs: 1, rayId: '1234567890abcdef-DFW', action: null, ruleId: null, originCount: null,
    excerpt: JSON.stringify({ synthetic: true, requestId, tlsClientVerification: facts }) });
  const httpEvidence = makeArtifact({ id: randomUUID(), mode: 'fixture', runId, scenarioId: 'api-shield', targetRole: 'after', requestId,
    observedAt: end, source: 'http', payload: observation }).ref;
  const receipt: Receipt = { schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'api-shield', targetRole: 'after',
    releaseDigest, producerId: 'owned-after-container', sequence: 1, observedAt: '2026-11-04T10:00:00.400Z', rayId: '1234567890abcdef', stage: 'entry' };
  const origin = makeArtifact({ id: receipt.id, mode: 'fixture', runId, scenarioId: 'api-shield', targetRole: 'after', requestId,
    observedAt: receipt.observedAt, source: 'origin', payload: receipt });
  const input: PlatformTlsAdmission = { request: { runId, requestId, scenarioId: 'api-shield', role: 'after', origin: 'https://after.example.test',
    method: 'GET', path: '/api', case: 'authorized', credentialRef: 'certificate:lab-valid', followRedirects: false }, facts, readback,
    configuration: configuration.artifact, configurationEvidence: configuration.ref, observation, httpEvidence,
    receipts: [receipt], originEvidence: [origin.ref] };
  function syncHttp() {
    input.observation.excerpt = JSON.stringify({ synthetic: true, requestId, tlsClientVerification: input.facts });
    input.httpEvidence = makeArtifact({ id: input.httpEvidence.id, mode: input.observation.mode, runId, scenarioId: 'api-shield', targetRole: 'after', requestId,
      observedAt: input.observation.observedAt, source: 'http', payload: input.observation }).ref;
  }
  function flow(signal: PolicyFlow['signal']): PolicyFlow {
    return { observation: input.observation, httpEvidence: input.httpEvidence, signal, verificationEvidence: null,
      receipts: [...input.receipts], originEvidence: [...input.originEvidence],
      coverage: { healthy: true, complete: true, gaps: [], windowStart: start, watermark: end, producerSequence: 1 } };
  }
  const comparison = apiShieldComparison({ runId, mode: 'fixture', releaseDigest, readback, configurationEvidence: configuration.ref,
    policy: { policyId: readback.policyId, beforeOrigin: 'https://before.example.test', afterOrigin: 'https://after.example.test',
      path: '/api', capability: 'available', enabled: true, baselineExcluded: true,
      authorizedCertificate: { ref: 'certificate:lab-valid', hostname: 'after.example.test', fingerprint: readback.authorizedFingerprint }, invalidCertificateRef: 'certificate:lab-invalid' } });
  return { input, facts, readback, receipt, syncHttp, flow, comparison };
}
describe('platform TLS admission requires three independent scoped evidence channels', () => {
  it('joins actual response facts, observed rule fingerprint and exact Container entry reference', () => {
    const f = fixture(); const signal = bindPlatformTlsAdmission(f.input);
    expect(signal).toMatchObject({ product: 'mtls', policyId: f.readback.policyId, certificate: 'authorized', verified: true,
      revoked: false, fingerprint: f.facts.fingerprintSha256, action: 'allow', source: 'cloudflare-client-verification' });
    expect(f.comparison.signalMatches(f.flow(signal), f.input.request)).toBe(true);
  });
  it('does not turn matching historical records into an active admission signal', () => {
    const f = fixture(); f.input.observation.mode = 'saved'; f.syncHttp();
    f.input.configuration!.mode = 'saved'; f.input.configurationEvidence = makeArtifact(f.input.configuration!).ref;
    f.input.originEvidence = [makeArtifact({ id: f.receipt.id, mode: 'saved', runId: f.receipt.runId, scenarioId: 'api-shield',
      targetRole: 'after', requestId: f.receipt.requestId, observedAt: f.receipt.observedAt, source: 'origin', payload: f.receipt }).ref];
    expect(bindPlatformTlsAdmission(f.input)).toBeNull();
  });
  it.each(['unverified', 'revoked', 'fingerprint', 'missing'] as const)('preserves actual %s contradictions rather than replacing them with desired flags', fault => {
    const f = fixture();
    if (fault === 'unverified') { f.facts.certificateVerified = false; f.facts.verificationStatus = 'FAILED'; }
    if (fault === 'revoked') f.facts.certificateRevoked = true;
    if (fault === 'fingerprint') f.facts.fingerprintSha256 = 'e'.repeat(64);
    if (fault === 'missing') { f.facts.certificatePresented = false; f.facts.certificateVerified = false; f.facts.verificationStatus = 'NONE'; f.facts.fingerprintSha256 = null; }
    f.syncHttp(); const signal = bindPlatformTlsAdmission(f.input);
    expect(signal).not.toBeNull();
    if (signal?.product !== 'mtls') throw new Error('No observed TLS signal');
    expect(signal.action).toBe('allow'); // Actual Container admission, not successful certificate validation.
    expect(signal.verified).toBe(f.facts.certificateVerified); expect(signal.revoked).toBe(f.facts.certificateRevoked);
    expect(signal.fingerprint).toBe(f.facts.fingerprintSha256);
    expect(f.comparison.signalContradicts!(f.flow(signal), f.input.request)).toBe(true);
  });
  it.each(['configuration', 'configuration-ref', 'configuration-hash', 'http-hash', 'origin-hash', 'origin-ref', 'receipt', 'worker-only'] as const)('does not allow from missing or altered %s', fault => {
    const f = fixture();
    if (fault === 'configuration') f.input.configuration = null;
    if (fault === 'configuration-ref') f.input.configurationEvidence = null;
    if (fault === 'configuration-hash') f.input.configurationEvidence!.artifactDigest = '0'.repeat(64);
    if (fault === 'http-hash') f.input.httpEvidence.artifactDigest = '0'.repeat(64);
    if (fault === 'origin-hash') f.input.originEvidence[0]!.artifactDigest = '0'.repeat(64);
    if (fault === 'origin-ref') f.input.originEvidence = [];
    if (fault === 'receipt' || fault === 'worker-only') f.input.receipts = [];
    expect(bindPlatformTlsAdmission(f.input)).toBeNull();
  });
  it.each(['readback', 'desired', 'disabled', 'host', 'release', 'future', 'stale'] as const)('rejects %s configuration evidence', fault => {
    const f = fixture();
    if (fault === 'readback') f.readback.policyId = '9'.repeat(32);
    if (fault === 'disabled') f.readback.enabled = false;
    if (fault === 'host') f.readback.hostname = 'before.example.test';
    const payload = f.input.configuration!.payload;
    if (!('observedConfigDigest' in payload)) throw new Error('No observed configuration');
    if (fault === 'desired') payload.state = 'desired';
    if (fault === 'release') payload.releaseDigest = 'e'.repeat(64);
    if (fault === 'future') { payload.observedAt = end; f.input.configuration!.observedAt = end; }
    if (fault === 'stale') { payload.observedAt = '2026-11-04T09:00:00.000Z'; f.input.configuration!.observedAt = payload.observedAt; }
    f.input.configurationEvidence = makeArtifact(f.input.configuration!).ref;
    expect(bindPlatformTlsAdmission(f.input)).toBeNull();
  });
  it.each(['run', 'request', 'role', 'release', 'ray', 'duplicate', 'duplicate-ref'] as const)('rejects a foreign or ambiguous %s receipt', fault => {
    const f = fixture();
    if (fault === 'run') f.receipt.runId = randomUUID();
    if (fault === 'request') f.receipt.requestId = randomUUID();
    if (fault === 'role') f.receipt.targetRole = 'before';
    if (fault === 'release') f.receipt.releaseDigest = 'e'.repeat(64);
    if (fault === 'ray') f.receipt.rayId = '9'.repeat(16);
    if (fault === 'duplicate') f.input.receipts = [f.receipt, { ...f.receipt, id: randomUUID() }];
    if (fault === 'duplicate-ref') f.input.originEvidence = [...f.input.originEvidence, f.input.originEvidence[0]!];
    expect(bindPlatformTlsAdmission(f.input)).toBeNull();
  });
  it.each(['body', 'facts', 'status', 'baseline', 'scheme', 'redirect', 'credential'] as const)('rejects %s input instead of deriving an action from status or TLS flags alone', fault => {
    const f = fixture();
    if (fault === 'body') { f.input.observation.excerpt = '{}'; f.input.httpEvidence = makeArtifact({ id: f.input.httpEvidence.id, mode: 'fixture', runId: f.input.request.runId, scenarioId: 'api-shield', targetRole: 'after', requestId: f.input.request.requestId, observedAt: end, source: 'http', payload: f.input.observation }).ref; }
    if (fault === 'facts') f.facts.fingerprintSha256 = 'e'.repeat(64); // Does not match the actual sealed response body.
    if (fault === 'status') { f.input.observation.status = 403; f.syncHttp(); }
    if (fault === 'baseline') f.input.request.case = 'baseline';
    if (fault === 'scheme') f.input.request.origin = 'http://after.example.test';
    if (fault === 'redirect') Object.assign(f.input.request, { followRedirects: true });
    if (fault === 'credential') f.input.request.credentialRef = null;
    expect(bindPlatformTlsAdmission(f.input)).toBeNull();
  });
});
