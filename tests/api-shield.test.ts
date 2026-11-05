import { describe, expect, it } from 'vitest';
import { apiShieldModule, runApiShield } from '../packages/demo-core/src/api-shield.js';
import { apiOptions, digest, evidence, fixtureIO, privateKey, token } from './api-shield-fixtures.js';

describe('API Shield mTLS offline comparison', () => {
  it('runs absent, invalid and authorized certificates with a real origin control', async () => {
    const o = apiOptions(); const io = fixtureIO(o); const r = await runApiShield(o, io);
    expect(r.decision).toMatchObject({ outcome: 'verified', mode: 'fixture' });
    expect(io.sent.map(v => v.case)).toEqual(['baseline', 'missing', 'invalid', 'authorized']);
    expect(io.sent.every(v => v.path === '/api' && v.method === 'GET' && !v.followRedirects)).toBe(true);
    expect(r.flows[3]!.receipts).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(privateKey); expect(JSON.stringify(r)).not.toContain(token);
    const module = apiShieldModule(o.policy);
    expect(module.expression).toContain('cf.tls_client_auth.cert_verified');
    expect(module.expression).toContain('cf.tls_client_auth.cert_revoked');
    expect(module.expression).toContain(digest); expect(module.expression).not.toContain('before.lab.example');
  });
  it.each(['missing', 'invalid'] as const)('does not infer %s mTLS from status or a Ray ID', async kind => {
    const o = apiOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === kind) { f.signal = null; f.observation.rayId = 'a'.repeat(16); } });
    expect((await runApiShield(o, io)).decision.outcome).toBe('inconclusive');
  });
  it('supports a recorded TLS rejection without treating it as a generic transport failure', async () => {
    const o = apiOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'invalid' && f.signal?.product === 'mtls') { f.observation.status = null; f.signal.source = 'tls-handshake'; } });
    expect((await runApiShield(o, io)).decision.outcome).toBe('verified');
  });
  it.each(['hostname', 'requireVerifiedCertificate', 'rejectRevoked', 'baselineExcluded'] as const)('rejects deployed %s drift without target traffic', async field => {
    const o = apiOptions(); if (field === 'hostname') o.readback!.hostname = 'wrong.lab.example'; else o.readback![field] = false;
    const io = fixtureIO(o); expect((await runApiShield(o, io)).decision.outcome).toBe('failed'); expect(io.sent).toHaveLength(0);
  });
  it('rejects foreign certificate scope and private keys in references', () => {
    const o = apiOptions(); o.policy.authorizedCertificate.hostname = 'before.lab.example'; expect(() => apiShieldModule(o.policy)).toThrow('scope');
    o.policy.authorizedCertificate.hostname = 'after.lab.example'; o.policy.invalidCertificateRef = privateKey; expect(() => apiShieldModule(o.policy)).toThrow();
  });
  it.each(['not-entitled', 'permission-denied', 'unknown'] as const)('isolates unavailable %s capability', async capability => {
    const o = apiOptions(); o.policy.capability = capability; const io = fixtureIO(o);
    expect((await runApiShield(o, io)).decision.outcome).toBe('unavailable'); expect(io.sent).toHaveLength(0);
    expect(apiShieldModule(o.policy, false)).toMatchObject({ included: false, blocked: false });
  });
  it.each(['origin', 'coverage', 'control', 'verification-scope', 'mode', 'release'] as const)('rejects incomplete or contrary %s proof', async fault => {
    const o = apiOptions(); const io = fixtureIO(o, (f, q) => {
      if (q.case === 'missing' && fault === 'origin') {
        f.receipts.push({ ...f.receipts[0], schemaVersion: 1, id: evidence('api-shield', o.runId, 'origin', q).id, runId: o.runId, requestId: q.requestId, scenarioId: 'api-shield', targetRole: 'after', producerId: 'container', sequence: 1, observedAt: f.observation.observedAt, rayId: null, releaseDigest: digest, stage: 'entry' });
      }
      if (q.case === 'missing' && fault === 'coverage') f.coverage.healthy = false;
      if (q.case === 'authorized' && fault === 'control') f.receipts = [];
      if (q.case === 'missing' && fault === 'verification-scope') f.verificationEvidence!.requestId = '00000000-0000-4000-8000-000000000001';
      if (fault === 'mode') f.httpEvidence.mode = 'saved';
      if (fault === 'release') for (const r of f.receipts) r.releaseDigest = 'f'.repeat(64);
    });
    expect((await runApiShield(o, io)).decision.outcome).toBe(fault === 'origin' ? 'failed' : 'inconclusive');
  });
  it.each(['revoked', 'wrong-fingerprint'] as const)('rejects a chain-valid but %s invalid control', async kind => {
    const o = apiOptions(); const io = fixtureIO(o, (f, q) => {
      if (q.case === 'invalid' && f.signal?.product === 'mtls') { f.signal.verified = true; f.signal.revoked = kind === 'revoked'; f.signal.fingerprint = kind === 'revoked' ? digest : 'e'.repeat(64); }
    });
    expect((await runApiShield(o, io)).decision.outcome).toBe('verified');
  });
  it('rejects a revoked authorized certificate', async () => {
    const o = apiOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'authorized' && f.signal?.product === 'mtls') f.signal.revoked = true; });
    expect((await runApiShield(o, io)).decision.outcome).toBe('failed');
  });
  it('keeps cancellation during the final exchange incomplete', async () => {
    const o = apiOptions(); const abort = new AbortController(); const io = fixtureIO(o, (_f, q) => { if (q.case === 'authorized') abort.abort(); });
    expect((await runApiShield(o, io, abort.signal)).decision.outcome).toBe('inconclusive');
  });
  it('records unsupported invalid certificates without inventing a flow', async () => {
    const o = apiOptions(); o.policy.invalidCertificateRef = null; const io = fixtureIO(o); const r = await runApiShield(o, io);
    expect(io.sent).toHaveLength(3); expect(r.limitations.join()).toContain('unsupported');
  });
  it('stops on cancellation and sanitizes exchange failures', async () => {
    const o = apiOptions(); const abort = new AbortController(); abort.abort(); const io = fixtureIO(o);
    expect((await runApiShield(o, io, abort.signal)).decision.outcome).toBe('inconclusive'); expect(io.sent).toHaveLength(0);
    const r = await runApiShield(o, { async exchange() { throw new Error(privateKey); } });
    expect(r.decision.outcome).toBe('inconclusive'); expect(JSON.stringify(r)).not.toContain(privateKey);
  });
});
