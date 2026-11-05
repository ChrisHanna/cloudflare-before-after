import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: native.request }));
import { apiShieldDispatch, MtlsDispatchError } from '../packages/demo-core/src/api-shield-transport.js';
import { apiOptions, privateKey } from './api-shield-fixtures.js';
const certificate = '-----BEGIN CERTIFICATE-----\nfixture-only\n-----END CERTIFICATE-----';
const init = { method: 'GET', redirect: 'manual' as const, signal: new AbortController().signal };
beforeEach(() => {
  native.request.mockReset();
  native.request.mockImplementation((_url, _options, callback) => {
    const request = new EventEmitter();
    return Object.assign(request, { end() {
      const message = Object.assign(new PassThrough(), { statusCode: 200, headers: { 'content-type': 'application/json' } });
      callback(message); message.end('{"synthetic":true}');
    } });
  });
});
describe('API Shield native certificate dispatch', () => {
  it('passes in-memory lab credentials to TLS without weakening server verification', async () => {
    const o = apiOptions(); const resolver = vi.fn(() => ({ certificate, privateKey }));
    const transport = apiShieldDispatch(o.policy, 'certificate:lab-valid', resolver);
    const result = await transport.dispatch(`${o.policy.afterOrigin}/api`, init);
    expect(await result.json()).toEqual({ synthetic: true });
    expect(native.request.mock.calls[0]![1]).toMatchObject({ cert: certificate, key: privateKey, rejectUnauthorized: true, agent: false, signal: init.signal });
    expect(resolver).toHaveBeenCalledOnce(); expect(transport.redactor.text(`${certificate} ${privateKey}`)).not.toContain('fixture');
  });
  it('sends the missing-certificate case with no certificate and no resolver call', async () => {
    const o = apiOptions(); const resolve = vi.fn(); const transport = apiShieldDispatch(o.policy, null, resolve);
    await transport.dispatch(`${o.policy.afterOrigin}/api`, init);
    expect(resolve).not.toHaveBeenCalled(); expect(native.request.mock.calls[0]![1]).not.toHaveProperty('cert');
  });
  it.each(['https://before.lab.example/api', 'https://other.example/api', 'https://after.lab.example/admin', 'https://after.lab.example/api?key=x'])('rejects credential forwarding to %s', async url => {
    const transport = apiShieldDispatch(apiOptions().policy, 'certificate:lab-invalid', () => ({ certificate, privateKey }));
    await expect(transport.dispatch(url, init)).rejects.toThrow('scoped'); expect(native.request).not.toHaveBeenCalled();
  });
  it('uses the captured hostname even if a caller mutates policy', async () => {
    const o = apiOptions(); const t = apiShieldDispatch(o.policy, null, vi.fn()); o.policy.afterOrigin = 'https://evil.example';
    await expect(t.dispatch('https://evil.example/api', init)).rejects.toThrow('scoped');
  });
  it('rejects unapproved refs, secret resolver errors and pre-aborted requests', async () => {
    const o = apiOptions(); expect(() => apiShieldDispatch(o.policy, 'certificate:lab-other', vi.fn())).toThrow('Unapproved');
    expect(() => apiShieldDispatch(o.policy, 'certificate:lab-valid', () => { throw new Error(privateKey); })).toThrow('mTLS transport failed');
    const abort = new AbortController(); abort.abort(); const t = apiShieldDispatch(o.policy, null, vi.fn());
    await expect(t.dispatch(`${o.policy.afterOrigin}/api`, { ...init, signal: abort.signal })).rejects.toThrow(); expect(native.request).not.toHaveBeenCalled();
  });
  it('does not mislabel network or server-certificate failures as client-certificate rejection', () => {
    expect(new MtlsDispatchError('ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED').certificateRejected).toBe(true);
    expect(new MtlsDispatchError('ECONNRESET').certificateRejected).toBe(false);
    expect(new MtlsDispatchError('CERT_HAS_EXPIRED').certificateRejected).toBe(false);
  });
});
