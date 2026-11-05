import { describe, expect, it } from 'vitest';
import { labOrigin, validateRedirect, validateTarget } from '../packages/demo-core/src/config.js';
import { labConfig } from './fixtures/lab.js';
describe('target-policy', () => {
  const c = labConfig();
  it('validates exact target role and permits only explicit APIs', () => {
    expect(validateTarget(c, 'https://before.example.test/catalog', 'before').pathname).toBe('/catalog');
    expect(() => validateTarget(c, 'https://after.example.test/', 'before')).toThrow();
    expect(validateTarget(c, 'https://api.cloudflare.com/client/v4/zones', 'cloudflare').hostname).toBe('api.cloudflare.com');
  });
  it('rejects wildcard, local, malicious and ambiguous origins', () => {
    for (const value of ['https://*.example.test', 'http://before.example.test', 'https://before.example.test:8443', 'https://user:pass@before.example.test', 'https://127.0.0.1', 'https://2130706433', 'https://[::1]', 'https://localhost', 'https://host.local', 'https://before.example.test/path', 'https://before.example.test?token=x', 'https://before.example.test.']) expect(() => labOrigin(value), value).toThrow();
    for (const value of ['https://before.example.test.evil.test', 'https://before.example.test/%2fadmin', 'https://before.example.test/?token=secret', 'https://before.example.test/#token', 'http://before.example.test']) expect(() => validateTarget(c, value, 'before')).toThrow();
  });
  it('rejects redirects by default and prevents cross-role or credential escape', () => {
    const from = 'https://before.example.test/catalog';
    expect(() => validateRedirect(c, from, '/next', 'before', {})).toThrow('disabled');
    expect(validateRedirect(c, from, '/next', 'before', {}, true).pathname).toBe('/next');
    for (const dest of ['https://evil.test', 'https://after.example.test', 'http://before.example.test', '//evil.test']) expect(() => validateRedirect(c, from, dest, 'before', { Authorization: 'secret' }, true)).toThrow();
  });
});
