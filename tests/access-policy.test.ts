import { describe, expect, it } from 'vitest';
import { accessPolicyModule, runAccessPolicy } from '../packages/demo-core/src/access-policy.js';
import { accessOptions, digest, fixtureIO, privateKey, token } from './api-shield-fixtures.js';

describe('Cloudflare Access offline comparison', () => {
  it('does not promote old full-signal fixture callbacks to native identity proof', async () => {
    const o = accessOptions(); const io = fixtureIO(o); const r = await runAccessPolicy(o, io);
    expect(r.decision).toMatchObject({ outcome: 'inconclusive', mode: 'fixture' });
    expect(io.sent.map(q => q.case)).toEqual(['baseline', 'missing', 'authorized']);
    expect(io.sent.every(q => !q.followRedirects && q.method === 'GET' && q.path === '/admin' && !q.origin.includes('?'))).toBe(true);
    expect(io.sent[0]!.credentialRef).toBeNull(); expect(io.sent[1]!.credentialRef).toBeNull();
    expect(io.sent[2]!.credentialRef).toBe('service-token:lab-valid');
    expect(r.flows[2]!.receipts).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(privateKey); expect(JSON.stringify(r)).not.toContain(token);
    expect(accessPolicyModule(o.policy).application.domain).toBe('after.lab.example/admin');
  });
  it.each([302, 403])('rejects generic %i with no Access attribution', async status => {
    const o = accessOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'missing') { f.observation.status = status; f.signal = null; } });
    expect((await runAccessPolicy(o, io)).decision.outcome).toBe('inconclusive');
  });
  it('does not accept fabricated full denial signals without source-specific evidence', async () => {
    const o = accessOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'missing' && f.signal?.product === 'access') { f.observation.status = 403; f.signal.action = 'deny'; } });
    expect((await runAccessPolicy(o, io)).decision.outcome).toBe('inconclusive'); expect(io.sent).toHaveLength(3);
  });
  it.each(['audience', 'hostname', 'applicationId', 'policyId'] as const)('rejects wrong observed %s before dispatch', async field => {
    const o = accessOptions(); o.readback![field] = field === 'hostname' ? 'wrong.lab.example' : 'e'.repeat(field === 'audience' ? 64 : 32);
    const io = fixtureIO(o); expect((await runAccessPolicy(o, io)).decision.outcome).toBe('failed'); expect(io.sent).toHaveLength(0);
  });
  it.each(['audience', 'hostname', 'applicationId', 'policyId'] as const)('rejects wrong signal %s as unproven attribution', async field => {
    const o = accessOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'missing' && f.signal?.product === 'access') f.signal[field] = field === 'hostname' ? 'wrong.lab.example' : 'e'.repeat(field === 'audience' ? 64 : 32); });
    expect((await runAccessPolicy(o, io)).decision.outcome).toBe('inconclusive');
  });
  it('keeps absent service-token controls incomplete', async () => {
    const o = accessOptions(); o.policy.serviceTokenRef = null; const io = fixtureIO(o);
    const r = await runAccessPolicy(o, io); expect(r.decision.outcome).toBe('inconclusive'); expect(io.sent).toHaveLength(2);
    expect(r.decision.missingProof.join()).toContain('Protected allowed control');
  });
  it('does not send traffic with unreadable configuration or missing entitlement', async () => {
    const o = accessOptions(); o.readback = null; const io = fixtureIO(o);
    expect((await runAccessPolicy(o, io)).decision.outcome).toBe('inconclusive'); expect(io.sent).toHaveLength(0);
    o.policy.capability = 'not-entitled'; expect((await runAccessPolicy(o, io)).decision.outcome).toBe('unavailable');
    expect(accessPolicyModule(o.policy, false)).toMatchObject({ included: false, blocked: false });
  });
  it('rejects bypass policies and baseline identity gating', async () => {
    for (const field of ['bypass', 'baselineExcluded'] as const) {
      const o = accessOptions(); o.readback![field] = field === 'bypass'; const io = fixtureIO(o);
      expect((await runAccessPolicy(o, io)).decision.outcome).toBe('failed'); expect(io.sent).toHaveLength(0);
    }
  });
  it('fails known admitted unauthenticated traffic even with missing entitlement', async () => {
    const o = accessOptions(); const io = fixtureIO(o, (f, q) => { if (q.case === 'missing') f.observation.status = 200; });
    expect((await runAccessPolicy(o, io)).decision.outcome).toBe('failed');
  });
  it('does not export assertions, cookies or raw token fields', async () => {
    const o = accessOptions(); const io = fixtureIO(o); const exchange = io.exchange;
    io.exchange = async (q, s) => ({ ...await exchange(q, s) as object, assertion: token, cookie: token });
    const r = await runAccessPolicy(o, io); expect(r.decision.outcome).toBe('inconclusive'); expect(r.flows).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(token);
    o.policy.serviceTokenRef = token; expect(() => accessPolicyModule(o.policy)).toThrow();
    o.policy.serviceTokenRef = 'service-token:lab-valid'; o.policy.afterOrigin += `?token=${token}`; expect(() => accessPolicyModule(o.policy)).toThrow();
  });
  it('checks authenticated control receipts and negative-origin coverage', async () => {
    for (const fault of ['receipt', 'coverage', 'link'] as const) {
      const o = accessOptions(); const io = fixtureIO(o, (f, q) => {
        if (fault === 'receipt' && q.case === 'authorized') f.receipts[0]!.releaseDigest = 'f'.repeat(64);
        if (fault === 'coverage' && q.case === 'missing') f.coverage.complete = false;
        if (fault === 'link' && q.case === 'missing') f.verificationEvidence!.artifactDigest = digest; // A digest alone cannot fix a wrong source.
        if (fault === 'link' && q.case === 'missing') f.verificationEvidence!.source = 'http';
      });
      expect((await runAccessPolicy(o, io)).decision.outcome).toBe('inconclusive');
    }
  });
});
