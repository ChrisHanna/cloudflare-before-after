import { z } from 'zod';
import { Digest, Role, Time } from './schemas.js';

// Target role names the requested owned script, not a reflected runtime header.
export const WorkerCodeFingerprintSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('worker-code-fingerprint'),
  source: z.literal('cloudflare-workers-content-v2'), observedAt: Time, targetRole: Role,
  accountId: z.string().regex(/^[a-f0-9]{32}$/), workerName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/),
  format: z.enum(['javascript', 'multipart']), moduleCount: z.number().int().min(1).max(32),
  contentBytes: z.number().int().min(1).max(4 * 1024 * 1024), codeDigest: Digest,
  runtimeRelease: z.null(), containerDigest: z.null(),
});
export type WorkerCodeFingerprint = z.infer<typeof WorkerCodeFingerprintSchema>;
