import { z } from 'zod';
import { Digest, Id, Mode, Role, Time } from './schemas.js';
export const WorkerReadbackSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('worker-readback'),
  source: z.literal('independent-provider-reads'), runId: Id, scenarioId: z.literal('waf-custom'), mode: Mode,
  phase: z.enum(['before', 'after']), targetRole: Role, accountId: z.string().regex(/^[a-f0-9]{32}$/), workerName: z.string().min(1).max(128),
  startedAt: Time, observedAt: Time, bindingObservedAt: Time.nullable(), codeObservedAt: Time.nullable(), bindingDigest: Digest.nullable(), codeDigest: Digest.nullable(),
}).superRefine((value, ctx) => {
  if (Date.parse(value.startedAt) > Date.parse(value.observedAt) || Date.parse(value.observedAt) - Date.parse(value.startedAt) > 120000
    || [value.bindingObservedAt, value.codeObservedAt].some(time => time !== null && (Date.parse(time) < Date.parse(value.startedAt) || Date.parse(time) > Date.parse(value.observedAt))))
    ctx.addIssue({ code: 'custom', message: 'Partial readback is outside its run window' });
  if ((value.bindingDigest === null) !== (value.bindingObservedAt === null) || (value.codeDigest === null) !== (value.codeObservedAt === null))
    ctx.addIssue({ code: 'custom', message: 'Partial readback time and digest must agree' });
});
export type WorkerReadback = z.infer<typeof WorkerReadbackSchema>;
