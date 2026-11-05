import { z } from 'zod';
import { Digest, Id, Time } from './schemas.js';
import { AccessAuthenticationEvidenceSchema } from './access-authentication.js';
const ResourceId = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);

/** An authenticated current HTTPS response, NOT an independent producer signature.
 * JWT possession is service identity, NOT fresh per-request Access evaluation. */
export const AccessServiceIdentitySchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('access-service-identity'), source: z.literal('verified-rs256-service-jwt'),
  channel: z.literal('authenticated-same-request-https'), mode: z.enum(['live', 'fixture']),
  targetRole: z.literal('after'), scenarioId: z.literal('access'), runId: Id, requestId: Id, nonce: Id,
  releaseDigest: Digest, hostname: z.hostname(), path: z.literal('/admin'), method: z.literal('GET'), observedAt: Time,
  audience: Digest, issuer: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/), issuerMatched: z.literal(true), clientIdMatched: z.literal(true),
  identity: z.literal('lab-service-token'), signatureVerified: z.literal(true), policyId: z.null(),
  perRequestEvaluation: z.literal('unknown'),
});
export type AccessServiceIdentity = z.infer<typeof AccessServiceIdentitySchema>;
export const AccessSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('access-config-snapshot'), source: z.literal('guarded-access-app-policy-token-reads'),
  runId: Id, scenarioId: z.literal('access'), targetRole: z.literal('after'), phase: z.enum(['before', 'after']), mode: z.enum(['live', 'fixture']), readId: Id,
  observedAt: Time, startedAt: Time, generation: z.number().int().positive(),
  accountId: z.string().regex(/^[a-f0-9]{32}$/), applicationId: ResourceId,
  configuredPolicyId: ResourceId, audience: Digest, hostname: z.hostname(),
  path: z.literal('/admin'), functionalDigest: Digest, tokenMapped: z.literal(true),
}).refine(s => s.startedAt <= s.observedAt && Date.parse(s.observedAt) - Date.parse(s.startedAt) <= 120000);
export type AccessSnapshot = z.infer<typeof AccessSnapshotSchema>;
export const AccessAdmissionSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('access-service-admission'),
  channel: z.literal('authenticated-same-request-https'), facts: AccessServiceIdentitySchema,
  beforeReadId: Id, afterReadId: Id, configurationDigest: Digest,
  configuredPolicyId: ResourceId, approvingPolicyId: z.null(),
  receiptId: Id, completedAt: Time, fullRuntimeState: z.null(),
}).refine(a => a.beforeReadId !== a.afterReadId && a.facts.observedAt <= a.completedAt
  && Date.parse(a.completedAt) - Date.parse(a.facts.observedAt) <= 120000);
export type AccessAdmission = z.infer<typeof AccessAdmissionSchema>;
/** Source-specific application rejection. Configured references are NOT observed
 * denied policy/audience/identity. Only an explicit failed login event can bind. */
export const AccessApplicationRejectionSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('access-application-rejection'),
  channel: z.literal('authenticated-same-request-https'), mode: z.enum(['live', 'fixture']),
  runId: Id, requestId: Id, scenarioId: z.literal('access'), targetRole: z.literal('after'),
  releaseDigest: Digest, hostname: z.hostname(), path: z.literal('/admin'), method: z.literal('GET'), observedAt: Time,
  event: AccessAuthenticationEvidenceSchema.refine(e => e.allowed === false && e.authenticationAction === 'login' && e.complete),
  beforeReadId: Id, afterReadId: Id, configurationDigest: Digest,
  configuredApplicationId: ResourceId, configuredPolicyId: ResourceId, configuredAudience: Digest,
  independentOriginAbsence: z.literal(true), originWatermark: Time, fullRuntimeState: z.null(),
  credentialCaseCoverage: z.literal('unqualified'),
}).refine(e => e.beforeReadId !== e.afterReadId && e.event.applicationId === e.configuredApplicationId && e.event.hostname === e.hostname
  && e.event.path === e.path && e.event.eventTime <= e.observedAt && Date.parse(e.observedAt) - Date.parse(e.event.eventTime) <= 120000
  && e.originWatermark >= e.observedAt && Date.parse(e.originWatermark) - Date.parse(e.observedAt) <= 120000);
export type AccessApplicationRejection = z.infer<typeof AccessApplicationRejectionSchema>;
export const AccessEnforcementSchema = z.union([AccessAdmissionSchema, AccessApplicationRejectionSchema]);
export type AccessEnforcement = z.infer<typeof AccessEnforcementSchema>;
