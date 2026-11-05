import { z } from 'zod';
import { Time } from './schemas.js';

/** Authentication audit facts are not a complete Access policy/identity signal. */
export const AccessAuthenticationEvidenceSchema = z.strictObject({
  kind: z.literal('access-authentication'),
  sourceApi: z.literal('access-authentication-audit'),
  join: z.literal('ray-application-time'),
  rayId: z.string().regex(/^[a-f0-9]{16}$/),
  applicationId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  hostname: z.hostname(), path: z.literal('/admin'), eventTime: Time,
  authenticationAction: z.enum(['login', 'logout', 'unknown']), allowed: z.boolean().nullable(),
  complete: z.boolean(),
  // The pinned SDK contract does not expose these bindings. Do not copy them
  // from the desired policy or infer them from an HTTP status or allowed=true.
  policyId: z.null(), audience: z.null(), identity: z.literal('unknown'),
});
export type AccessAuthenticationEvidence = z.infer<typeof AccessAuthenticationEvidenceSchema>;
