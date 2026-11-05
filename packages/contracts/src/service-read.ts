import { z } from 'zod';
import { Digest, Id, Role, ScenarioId, Time } from './schemas.js';
const Resource = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const ServiceResourcesSchema = z.strictObject({ d1: Resource, r2: Resource, container: Resource });
/** Authenticated observation of actual reads. Not write/read, isolation or image proof. */
export const ServiceReadReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), targetRole: Role, runId: Id, requestId: Id, scenarioId: ScenarioId,
  releaseDigest: Digest, observedAt: Time,
  operations: z.array(z.strictObject({ service: z.enum(['d1', 'r2', 'container']),
    operation: z.enum(['read', 'execute']), resourceId: Resource.nullable(), contentDigest: Digest,
  })).length(3),
}).superRefine((value, ctx) => {
  for (const service of ['d1', 'r2', 'container'] as const) {
    const rows = value.operations.filter(row => row.service === service);
    if (rows.length !== 1 || rows[0]!.operation !== (service === 'container' ? 'execute' : 'read')) ctx.addIssue({ code: 'custom', message: 'Exact service reads required' });
  }
});
export type ServiceReadReceipt = z.infer<typeof ServiceReadReceiptSchema>;
