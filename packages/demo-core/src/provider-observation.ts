import { z } from 'zod';
import { Id, Role } from '../../contracts/src/schemas.js';
import { digestValue } from './canonical.js';
const Scope = z.strictObject({ runId: Id, phase: z.enum(['before', 'after']), accountId: z.string().regex(/^[a-f0-9]{32}$/),
  targetRole: Role, workerName: z.string().min(1).max(128), readId: Id });
export interface ProviderReadContext { runId: string; phase: 'before' | 'after' }
export type ProviderObservation = Readonly<z.infer<typeof Scope>>;
const observations = new WeakMap<object, { scope: ProviderObservation; digest: string }>();
/** Attach context at the actual provider read, not later at comparison/capture.
 * Object identity and contents must survive; serialized/relabelled DTOs are not
 * fresh provider reads. This is provenance, not a cryptographic account receipt. */
export function sealProviderObservation<T extends object>(read: T, scope: ProviderObservation): T {
  if (observations.has(read)) throw new Error('Provider observation is already bound');
  observations.set(read, { scope: Object.freeze(Scope.parse(scope)), digest: digestValue(read) }); return read;
}
export function providerObservation(read: object): ProviderObservation | null {
  const value = observations.get(read);
  try { return value && value.digest === digestValue(read) ? value.scope : null; }
  catch { return null; }
}
