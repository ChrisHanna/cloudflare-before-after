import { z } from 'zod';
import { Digest, Id, Role, ScenarioId } from '../../../packages/contracts/src/schemas.js';
import { RuntimeHttpError } from './runtime-transport.js';
export const RuntimeStage = z.enum(['d1', 'product', 'r2', 'namespace', 'producer-storage', 'registry', 'derive', 'egress', 'start-ports', 'forward', 'parse']);
export const RuntimeCode = z.enum(['failed', 'http-rejected', 'invalid', 'cancelled', 'timeout', 'unknown']);
export const RuntimeScope = z.strictObject({ targetRole: Role, scenarioId: ScenarioId, runId: Id, requestId: Id, releaseDigest: Digest });
export type RuntimeScope = z.infer<typeof RuntimeScope>;
const Failure = RuntimeScope.extend({ schemaVersion: z.literal(1), stage: RuntimeStage, code: RuntimeCode, httpStatus: z.number().int().min(100).max(599).optional() }).strict();
export class RuntimeFailure extends Error {
  constructor(readonly stage: z.infer<typeof RuntimeStage>, readonly code: z.infer<typeof RuntimeCode>, readonly httpStatus?: number) { super('Runtime operation failed'); }
}
export async function runtimeStep<T>(stage: z.infer<typeof RuntimeStage>, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    if (error instanceof RuntimeHttpError) throw new RuntimeFailure(stage, 'http-rejected', error.status);
    if (error instanceof z.ZodError) throw new RuntimeFailure(stage === 'd1' ? 'product' : stage, 'invalid');
    // Never inspect or copy error messages, stack, cause, or provider payloads.
    if (error instanceof DOMException && error.name === 'AbortError') throw new RuntimeFailure(stage, 'cancelled');
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new RuntimeFailure(stage, 'timeout');
    throw new RuntimeFailure(stage, 'unknown');
  }
}
export function failureRecord(scope: RuntimeScope, error: unknown) {
  const known = error instanceof RuntimeFailure ? error : new RuntimeFailure('namespace', 'unknown');
  const record = Failure.parse({ ...RuntimeScope.parse(scope), schemaVersion: 1, stage: known.stage, code: known.code, ...(known.httpStatus === undefined ? {} : { httpStatus: known.httpStatus }) });
  if (new TextEncoder().encode(JSON.stringify(record)).byteLength > 512) throw new Error('Failure record exceeds cap');
  return record;
}
export function readFailure(text: string, scope: RuntimeScope): RuntimeFailure | null {
  if (new TextEncoder().encode(text).byteLength > 512) return null;
  try {
    const record = Failure.parse(JSON.parse(text));
    const expected = RuntimeScope.parse(scope);
    if (Object.entries(expected).some(([key, value]) => record[key as keyof typeof record] !== value)) return null;
    return new RuntimeFailure(record.stage, record.code, record.httpStatus);
  } catch { return null; }
}
