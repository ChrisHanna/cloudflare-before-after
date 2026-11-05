import { createHash } from 'node:crypto';

// Schema-independent hashing: importing this must never initialize deployment
// intent/config schemas. Keep the existing canonical format byte-for-byte.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const digestValue = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
