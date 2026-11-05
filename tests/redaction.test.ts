import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Redactor } from '../packages/contracts/src/redaction.js';
describe('redaction', () => {
  const secret = 'canary/+super-secret';
  const r = new Redactor([secret]);
  it('scrubs known and encoded secrets throughout nested public records', () => {
    const schema = z.strictObject({ text: z.string(), nested: z.array(z.strictObject({ text: z.string() })) });
    const json = r.serialize(schema, { text: secret, nested: [{ text: encodeURIComponent(secret) }] });
    expect(json).not.toContain('canary');
    expect(json).toContain('[REDACTED]');
    expect(() => r.serialize(schema, { text: '', nested: [], Cookie: secret })).toThrow();
  });
  it('removes headers, identity and private keys from free text', () => {
    for (const text of ['Authorization: Bearer abc', 'Set-Cookie: login=abc', 'token=abc', 'assertion=abc', 'person@example.com', '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----']) {
      const output = r.text(text);
      expect(output).not.toContain('abc');
      expect(output).not.toContain('person@');
    }
  });
  it('caps excerpts by bytes without splitting Unicode', () => {
    const value = r.excerpt('😀'.repeat(5000));
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(4096);
    expect(value).not.toContain('\ufffd');
    expect(r.excerpt(`ok ${secret}`)).not.toContain(secret);
  });
});
