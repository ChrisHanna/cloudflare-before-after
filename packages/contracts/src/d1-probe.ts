import { z } from 'zod';
import { Digest, Id, Role, Time } from './schemas.js';
export const D1_PROBE_MARKER = 'synthetic-d1-probe-v1';
export const D1ProbeRowSchema = z.strictObject({ environment: Role, scenario_id: z.literal('waf-custom'), run_id: Id,
  request_id: Id, probe_id: Id, marker: z.literal(D1_PROBE_MARKER) });
export const D1WriteReadReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('d1-write-read'),
  source: z.literal('owned-worker-d1'), targetRole: Role, scenarioId: z.literal('waf-custom'), runId: Id, requestId: Id,
  probeId: Id, releaseDigest: Digest, observedAt: Time, resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  write: z.enum(['observed', 'unknown']), read: z.enum(['observed', 'unknown']), cleanup: z.enum(['observed', 'unknown']), contentDigest: Digest.nullable(),
}).superRefine((value, ctx) => {
  if ((value.read === 'observed') !== (value.contentDigest !== null) || value.read === 'observed' && value.write !== 'observed')
    ctx.addIssue({ code: 'custom', message: 'D1 read proof requires observed write and actual row digest' });
});
export type D1WriteReadReceipt = z.infer<typeof D1WriteReadReceiptSchema>;
