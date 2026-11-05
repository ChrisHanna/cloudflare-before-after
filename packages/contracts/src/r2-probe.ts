import { z } from 'zod';
import { Digest, Id, Role, Time } from './schemas.js';
export const R2_PROBE_MARKER = 'synthetic-r2-probe-v1';
export const R2ProbeRowSchema = z.strictObject({ environment: Role, scenario_id: z.literal('waf-custom'), run_id: Id,
  request_id: Id, probe_id: Id, marker: z.literal(R2_PROBE_MARKER) });
export function r2ProbeKey(row: z.infer<typeof R2ProbeRowSchema>): string {
  const value = R2ProbeRowSchema.parse(row);
  return `verification/${value.environment}/${value.scenario_id}/${value.run_id}/${value.request_id}/${value.probe_id}.json`;
}
export const R2WriteReadReceiptSchema = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('r2-write-read'), source: z.literal('owned-worker-r2'),
  targetRole: Role, scenarioId: z.literal('waf-custom'), runId: Id, requestId: Id, probeId: Id, releaseDigest: Digest, observedAt: Time,
  resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), write: z.enum(['observed', 'unknown']), read: z.enum(['observed', 'unknown']),
  cleanup: z.enum(['observed', 'unknown']), contentDigest: Digest.nullable(),
}).superRefine((value, ctx) => {
  if ((value.read === 'observed') !== (value.contentDigest !== null) || value.read === 'observed' && value.write !== 'observed')
    ctx.addIssue({ code: 'custom', message: 'R2 read proof requires observed new-object ownership and actual bytes' });
});
export type R2WriteReadReceipt = z.infer<typeof R2WriteReadReceiptSchema>;
