import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { platformTlsVerification } from '../apps/storefront-worker/src/tls-client-verification.js';
import { TlsClientVerificationSchema } from '../packages/contracts/src/tls-client-verification.js';
import { readPlatformTlsVerification } from '../packages/demo-core/src/platform-tls.js';
import { PolicySignalSchema } from '../packages/demo-core/src/api-shield-proof.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import type { SafeResponse } from '../packages/demo-core/src/transport.js';

const start = '2026-11-04T10:00:00.000Z'; const observedAt = '2026-11-04T10:00:00.500Z'; const end = '2026-11-04T10:00:01.000Z';
function fixture() {
  const scope = { runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64), hostname: 'after.example.test', observedAt };
  const auth = { certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0', certFingerprintSHA256: 'b'.repeat(64),
    certSubjectDN: 'CN=PRIVATE-PERSON', certIssuerDN: 'PRIVATE-ISSUER', certSerial: 'PRIVATE-SERIAL',
    certRFC9440: 'PRIVATE-CERT-DER', certChainRFC9440: 'PRIVATE-CERT-CHAIN' };
  const facts = platformTlsVerification({ tlsClientAuth: auth }, scope)!;
  const body = { synthetic: true, requestId: scope.requestId, tlsClientVerification: facts };
  const response: SafeResponse = { status: 200, excerpt: JSON.stringify(body), rayId: '1234567890abcdef-DFW', latencyMs: 1,
    metadata: { role: 'after', releaseDigest: scope.releaseDigest, services: ['container-completed'], contentType: 'application/json', bodyBytes: Buffer.byteLength(JSON.stringify(body)) } };
  return { scope, auth, facts, body, response, expected: { ...scope, start, end } };
}
describe('platform TLS facts are scoped observations, not policy actions', () => {
  it('projects only actual platform flags and canonical public fingerprint', () => {
    const f = fixture();
    expect(f.facts).toMatchObject({ certificatePresented: true, certificateVerified: true, certificateRevoked: false,
      verificationStatus: 'SUCCESS', fingerprintSha256: 'b'.repeat(64), runId: f.scope.runId, requestId: f.scope.requestId });
    expect(JSON.stringify(f.facts)).not.toMatch(/PRIVATE|certSubjectDN|certIssuerDN|certSerial|certRFC9440/);
    expect(f.facts).not.toHaveProperty('policyId'); expect(f.facts).not.toHaveProperty('action');
    expect(PolicySignalSchema.safeParse(f.facts).success).toBe(false);
    f.auth.certFingerprintSHA256 = Array(32).fill('BB').join(':');
    expect(platformTlsVerification({ tlsClientAuth: f.auth }, f.scope)?.fingerprintSha256).toBe('b'.repeat(64));
  });
  it('distinguishes a documented no-certificate placeholder from absent platform data', () => {
    const f = fixture();
    expect(platformTlsVerification({ tlsClientAuth: { certPresented: '0', certVerified: 'NONE', certRevoked: '0', certFingerprintSHA256: '' } }, f.scope))
      .toMatchObject({ certificatePresented: false, certificateVerified: false, certificateRevoked: false, fingerprintSha256: null, verificationStatus: 'NONE' });
    for (const input of [undefined, null, {}, { tlsClientAuth: null }, { headers: { 'cf-cert-verified': 'SUCCESS' } }]) expect(platformTlsVerification(input, f.scope)).toBeNull();
  });
  it.each(['FAILED', 'FAILED:self signed certificate', 'FAILED:unable to verify the first certificate', 'FAILED:certificate is not yet valid', 'FAILED:certificate has expired'] as const)('retains the supported %s result without copying free text', status => {
    const f = fixture();
    expect(platformTlsVerification({ tlsClientAuth: { ...f.auth, certVerified: status } }, f.scope)).toMatchObject({ certificatePresented: true, certificateVerified: false, verificationStatus: status });
  });
  it('preserves revocation independently of chain-verification success', () => {
    const f = fixture();
    expect(platformTlsVerification({ tlsClientAuth: { ...f.auth, certRevoked: '1' } }, f.scope)).toMatchObject({ certificateVerified: true, certificateRevoked: true });
  });
  it.each([
    { certPresented: 1 }, { certVerified: 'TRUE' }, { certVerified: 'NONE' }, { certVerified: 'FAILED:PRIVATE-PERSON' },
    { certRevoked: undefined }, { certRevoked: false }, { certFingerprintSHA256: undefined },
    { certFingerprintSHA256: 'b'.repeat(128) }, { certFingerprintSHA256: 'PRIVATE-KEY' }, { certFingerprintSHA256: '' },
  ])('does not coerce missing, malformed or unsupported facts: %j', fault => {
    const f = fixture(); expect(platformTlsVerification({ tlsClientAuth: { ...f.auth, ...fault } }, f.scope)).toBeNull();
  });
  it('decodes the same bounded response without requests or desired-state fallback', () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external requests'));
    try { expect(readPlatformTlsVerification(f.response, f.expected)).toEqual(f.facts); expect(fetch).not.toHaveBeenCalled(); }
    finally { fetch.mockRestore(); }
    expect(readPlatformTlsVerification({ ...f.response, excerpt: JSON.stringify({ synthetic: true, requestId: f.scope.requestId, tlsClientVerification: null }) }, f.expected)).toBeNull();
  });
  it.each(['run', 'request', 'release', 'host', 'start', 'end'] as const)('rejects a foreign or stale %s binding', fault => {
    const f = fixture(); const expected = { ...f.expected };
    if (fault === 'run') expected.runId = randomUUID();
    if (fault === 'request') expected.requestId = randomUUID();
    if (fault === 'release') expected.releaseDigest = 'c'.repeat(64);
    if (fault === 'host') expected.hostname = 'before.example.test';
    if (fault === 'start') expected.start = '2026-11-04T10:00:00.501Z';
    if (fault === 'end') expected.end = '2026-11-04T10:00:00.499Z';
    expect(readPlatformTlsVerification(f.response, expected)).toBeNull();
  });
  it.each(['status', 'role', 'release', 'type', 'size', 'negative-size', 'nan-size', 'json'] as const)('rejects unsupported response %s', fault => {
    const f = fixture(); const response = { ...f.response, metadata: { ...f.response.metadata } };
    if (fault === 'status') response.status = 403;
    if (fault === 'role') response.metadata.role = 'before';
    if (fault === 'release') response.metadata.releaseDigest = null;
    if (fault === 'type') response.metadata.contentType = 'text/html';
    if (fault === 'size') response.metadata.bodyBytes = 4097;
    if (fault === 'negative-size') response.metadata.bodyBytes = -1;
    if (fault === 'nan-size') response.metadata.bodyBytes = NaN;
    if (fault === 'json') response.excerpt = '{truncated';
    expect(readPlatformTlsVerification(response, f.expected)).toBeNull();
  });
  it('rejects inconsistent statuses and retains strict artifact scope and time', () => {
    const f = fixture();
    expect(TlsClientVerificationSchema.safeParse({ ...f.facts, certificateVerified: false }).success).toBe(false);
    expect(TlsClientVerificationSchema.safeParse({ ...f.facts, privateKey: 'PRIVATE-KEY' }).success).toBe(false);
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: f.scope.runId, scenarioId: 'api-shield' as const,
      targetRole: 'after' as const, requestId: f.scope.requestId, observedAt, source: 'verification' as const, payload: f.facts };
    expect(makeArtifact(artifact).artifact.payload).toEqual(f.facts);
    for (const other of [{ ...artifact, targetRole: 'before' as const }, { ...artifact, requestId: randomUUID() },
      { ...artifact, runId: randomUUID() }, { ...artifact, scenarioId: 'access' as const }, { ...artifact, observedAt: end },
      { ...artifact, source: 'cloudflare' as const }]) expect(() => makeArtifact(other)).toThrow();
  });
});
