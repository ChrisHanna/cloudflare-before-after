import { describe, expect, it, vi } from 'vitest';
import { accessPolicyDispatch } from '../packages/demo-core/src/access-policy-transport.js';
import { accessOptions, token } from './api-shield-fixtures.js';
const clientId = 'fixture-client-id-not-a-real-service-token';
const init = { method: 'GET', redirect: 'manual' as const, signal: new AbortController().signal };
describe('Access credential-scoped dispatch', () => {
  it('uses headers, redacts both token values, and never follows a login redirect', async () => {
    const o = accessOptions(); const resolver = vi.fn(() => ({ clientId, clientSecret: token }));
    const next = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://identity.example/login' } }));
    const transport = accessPolicyDispatch(o.policy, 'service-token:lab-valid', resolver, next);
    const result = await transport.dispatch(`${o.policy.afterOrigin}/admin`, init);
    expect(result.status).toBe(302); expect(next).toHaveBeenCalledOnce(); expect(resolver).toHaveBeenCalledOnce();
    const sent = next.mock.calls as unknown as [string, RequestInit][];
    expect(sent[0]![0]).toBe(`${o.policy.afterOrigin}/admin`);
    expect(new Headers(sent[0]![1].headers).get('cf-access-client-secret')).toBe(token);
    expect(sent[0]![1].redirect).toBe('manual');
    expect(transport.redactor.text(`${clientId} ${token}`)).toBe('[REDACTED] [REDACTED]');
  });
  it('does not resolve or attach a token for unauthenticated observations', async () => {
    const resolver = vi.fn(); const next = vi.fn(async (_url: string, value: RequestInit) => { expect(new Headers(value.headers).has('cf-access-client-secret')).toBe(false); return new Response('synthetic'); });
    const transport = accessPolicyDispatch(accessOptions().policy, null, resolver, next);
    await transport.dispatch('https://after.lab.example/admin', init); expect(resolver).not.toHaveBeenCalled();
  });
  it.each(['https://before.lab.example/admin', 'https://identity.example/login', 'https://after.lab.example/api', 'https://after.lab.example/admin?token=x'])('rejects sending tokens to %s', async url => {
    const next = vi.fn(); const transport = accessPolicyDispatch(accessOptions().policy, 'service-token:lab-valid', () => ({ clientId, clientSecret: token }), next);
    await expect(transport.dispatch(url, init)).rejects.toThrow('scoped'); expect(next).not.toHaveBeenCalled();
  });
  it.each(['cookie', 'cf-access-jwt-assertion', 'cf-access-client-id', 'cf-access-client-secret'])('rejects caller-supplied %s', async name => {
    const next = vi.fn(); const transport = accessPolicyDispatch(accessOptions().policy, null, vi.fn(), next);
    await expect(transport.dispatch('https://after.lab.example/admin', { ...init, headers: { [name]: token } })).rejects.toThrow('forbidden'); expect(next).not.toHaveBeenCalled();
  });
  it('captures scope and strips transport and resolver error secrets', async () => {
    const o = accessOptions(); const next = vi.fn(async () => { throw new Error(token); });
    const t = accessPolicyDispatch(o.policy, null, vi.fn(), next); o.policy.afterOrigin = 'https://evil.example';
    await expect(t.dispatch('https://evil.example/admin', init)).rejects.toThrow('scoped');
    await expect(t.dispatch('https://after.lab.example/admin', init)).rejects.toThrow('Access transport failed');
    expect(() => accessPolicyDispatch(accessOptions().policy, 'service-token:lab-valid', () => { throw new Error(token); }, next)).toThrow('Lab service-token resolution failed');
  });
});
