import { z } from 'zod';

// Schema selection happens at each public boundary. Never serialize an arbitrary adapter object.
export class Redactor {
  readonly #secrets: string[];
  constructor(secrets: readonly string[] = []) {
    this.#secrets = [...new Set(secrets.filter(v => v.length > 0))].sort((a, b) => b.length - a.length);
  }
  text(value: string): string {
    let output = value;
    for (const secret of this.#secrets) {
      for (const variant of new Set([secret, encodeURIComponent(secret)])) output = output.split(variant).join('[REDACTED]');
    }
    return output
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
      .replace(/\b(?:authorization|cookie|set-cookie|client[_-]?secret|password|token|assertion)\s*[:=]\s*[^\r\n<]+/gi, '[REDACTED]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
  }
  excerpt(value: string): string {
    const bytes = Buffer.from(this.text(value));
    // Avoid a partial UTF-8 code point at the byte boundary.
    let end = Math.min(bytes.length, 4096);
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    return bytes.subarray(0, end).toString('utf8');
  }
  serialize<T extends z.ZodType>(schema: T, input: unknown): string {
    const validated = schema.parse(input);
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return this.text(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      return value;
    };
    // Revalidate after redaction: if a secret contaminates an identifier, fail closed.
    return JSON.stringify(schema.parse(walk(validated)));
  }
}
