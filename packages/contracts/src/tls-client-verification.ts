import { z } from 'zod';
import { Digest, Id, Time } from './schemas.js';

export const TlsVerificationStatusSchema = z.enum([
  'SUCCESS', 'NONE', 'FAILED:self signed certificate', 'FAILED:unable to verify the first certificate',
  'FAILED:certificate is not yet valid', 'FAILED:certificate has expired', 'FAILED',
]);
/** Request-scoped platform facts. This record supplies no policy ID or action. */
export const TlsClientVerificationSchema = z.strictObject({
  kind: z.literal('tls-client-verification'), schemaVersion: z.literal(1), source: z.literal('cloudflare-platform-cf'),
  runId: Id, requestId: Id, scenarioId: z.literal('api-shield'), targetRole: z.literal('after'),
  releaseDigest: Digest, hostname: z.hostname(), path: z.literal('/api'), observedAt: Time,
  certificatePresented: z.boolean(), certificateVerified: z.boolean(), certificateRevoked: z.boolean(),
  verificationStatus: TlsVerificationStatusSchema, fingerprintSha256: Digest.nullable(),
}).superRefine((value, ctx) => {
  if (value.certificateVerified !== (value.verificationStatus === 'SUCCESS')) ctx.addIssue({ code: 'custom', message: 'TLS verification status mismatch' });
  if (!value.certificatePresented && (value.verificationStatus !== 'NONE' || value.certificateRevoked || value.fingerprintSha256 !== null)) ctx.addIssue({ code: 'custom', message: 'Absent certificate facts are inconsistent' });
  if (value.certificatePresented && value.verificationStatus === 'NONE') ctx.addIssue({ code: 'custom', message: 'Presented certificate cannot have NONE status' });
  if (value.certificateVerified && value.fingerprintSha256 === null) ctx.addIssue({ code: 'custom', message: 'Verified certificate fingerprint is unavailable' });
});
export type TlsClientVerification = z.infer<typeof TlsClientVerificationSchema>;
