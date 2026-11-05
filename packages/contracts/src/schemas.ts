import { z } from 'zod';

export const Version = z.literal(1);
export const Id = z.uuid();
export const Digest = z.string().regex(/^[a-f0-9]{64}$/);
export const Time = z.iso.datetime();
export const Role = z.enum(['before', 'after']);
export const Mode = z.enum(['live', 'saved', 'fixture']);
export const Outcome = z.enum(['verified', 'failed', 'inconclusive', 'unavailable', 'skipped']);
export const CapabilityState = z.enum(['available', 'not-entitled', 'permission-denied', 'misconfigured', 'unknown']);
export const ScenarioId = z.enum(['waf-sqli', 'waf-xss', 'waf-custom', 'rate-limit', 'bot', 'turnstile', 'api-shield', 'access', 'waiting-room', 'ddos-evidence', 'analytics']);
export const Label = z.string().min(1).max(256);
export const BoundedText = z.string().max(4096);
export const RayId = z.string().regex(/^[a-f0-9]{16}(?:-[A-Z]{3})?$/i);
export const UnknownCount = z.union([z.number().int().nonnegative(), z.null()]);

export const BudgetSchema = z.strictObject({
  requests: z.number().int().min(1).max(100),
  concurrency: z.number().int().min(1).max(4),
  sessions: z.number().int().min(0).max(8),
  maxRuntimeMs: z.number().int().min(1).max(120_000),
  cleanupRequests: z.number().int().nonnegative(),
  cleanupMs: z.number().int().nonnegative(),
}).refine(v => v.cleanupRequests <= v.requests && v.cleanupMs <= v.maxRuntimeMs, 'Cleanup must fit the budget');

export const CoverageSchema = z.strictObject({
  healthy: z.boolean(), complete: z.boolean(),
  windowStart: Time, watermark: Time.nullable(),
  producerSequence: z.number().int().nonnegative().nullable(),
  gaps: z.array(Label).max(100),
});
export const ReceiptSchema = z.strictObject({
  schemaVersion: Version, id: Id, runId: Id, requestId: Id,
  scenarioId: ScenarioId, targetRole: Role, producerId: Label,
  sequence: z.number().int().positive(), observedAt: Time,
  rayId: RayId.nullable(), releaseDigest: Digest,
  stage: z.enum(['entry', 'completion']),
});
export const ObservationSchema = z.strictObject({
  schemaVersion: Version, id: Id, runId: Id, requestId: Id,
  scenarioId: ScenarioId, targetRole: Role, mode: Mode,
  observedAt: Time, method: z.enum(['GET', 'POST', 'HEAD']),
  path: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/).max(256),
  status: z.number().int().min(100).max(599).nullable(),
  latencyMs: z.number().nonnegative(), rayId: RayId.nullable(),
  action: Label.nullable(), ruleId: Label.nullable(),
  originCount: UnknownCount, excerpt: BoundedText,
});
export const EvidenceRefSchema = z.strictObject({
  id: Id, source: z.enum(['http', 'origin', 'cloudflare', 'verification', 'browser', 'configuration']),
  mode: Mode, observedAt: Time, runId: Id, scenarioId: ScenarioId,
  targetRole: Role, requestId: Id.nullable(), rayId: RayId.nullable(), artifactDigest: Digest,
});
export const FingerprintSchema = z.strictObject({
  schemaVersion: Version, observedAt: Time, releaseDigest: Digest,
  observedConfigDigest: Digest.nullable(), inventoryDigest: Digest,
  state: z.enum(['desired', 'observed', 'unknown']),
});
export const ResultSchema = z.strictObject({
  schemaVersion: Version, runId: Id, scenarioId: ScenarioId, outcome: Outcome,
  evidence: z.array(EvidenceRefSchema).max(500),
  missingProof: z.array(Label).max(100), contradictions: z.array(Label).max(100),
  releaseDigest: Digest, observedConfigDigest: Digest.nullable(),
  startedAt: Time, finishedAt: Time,
  requestsUsed: z.number().int().nonnegative(), peakConcurrency: z.number().int().nonnegative().max(4),
  sessionsUsed: z.number().int().nonnegative().max(8),
  cleanup: z.enum(['complete', 'incomplete', 'not-needed']),
}).refine(v => v.finishedAt >= v.startedAt, 'Invalid observation window');
export const ExecutionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('planned'), mode: z.literal('fixture'), targets: z.array(z.url()).max(20), budget: BudgetSchema }),
  z.strictObject({ kind: z.literal('completed'), result: ResultSchema }),
  z.strictObject({ kind: z.literal('cancelled'), result: ResultSchema.refine(v => v.outcome !== 'verified', 'Cancelled run cannot be verified') }),
]);
export const CapabilitySchema = z.strictObject({
  schemaVersion: Version, product: Label, state: CapabilityState,
  accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  observedAt: Time, source: Label, confidence: z.enum(['confirmed', 'partial', 'unknown']),
  dependencies: z.array(Label).max(30), reasons: z.array(Label).max(30),
});
export const ManifestSchema = z.strictObject({
  schemaVersion: Version, id: ScenarioId, version: z.number().int().positive(),
  command: Label, product: Label, entitlements: z.array(Label).max(20), permissions: z.array(Label).max(20),
  configuration: z.array(Label).min(1).max(30),
  targets: z.array(Role).min(1).max(2),
  inputs: z.array(z.strictObject({ method: z.enum(['GET', 'POST', 'HEAD']), path: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/), signature: BoundedText })).max(20),
  controls: z.array(Label).max(20), expectedBefore: Label, expectedAfter: Label,
  proofPredicates: z.array(Label).min(1).max(30),
  evidenceSources: z.array(z.enum(['http', 'origin', 'cloudflare', 'verification', 'browser', 'configuration'])).min(1).max(6),
  budget: BudgetSchema, minimumRequests: z.number().int().min(0).max(100),
  setupState: z.array(Label).max(30), runState: z.array(Label).max(30),
  cleanup: z.array(Label).max(30), cooldownMs: z.number().int().nonnegative(),
  notes: z.strictObject({ problem: Label, solution: Label, limitations: Label, question: Label }),
}).refine(v => v.minimumRequests + v.budget.cleanupRequests <= v.budget.requests, 'Proof must fit request allowance');
export const TurnstileConfigSchema = z.strictObject({ mode: z.enum(['disabled', 'test', 'live']), sitekey: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/).nullable(), hostname: z.string().regex(/^[a-z0-9.-]{1,253}$/), action: z.literal('register') }).refine(c => c.mode === 'disabled' ? c.sitekey === null : c.sitekey !== null, 'Widget key/mode mismatch');
export const TurnstileReceiptSchema = z.strictObject({ schemaVersion: Version, id: Id, runId: Id, requestId: Id, recordId: Id, targetRole: Role, observedAt: Time, verificationMode: z.enum(['disabled', 'test', 'live']), accepted: z.boolean(), reason: z.enum(['accepted', 'baseline-only', 'missing', 'invalid', 'replay', 'unavailable']), siteverifyCalls: z.number().int().min(0).max(1), persisted: z.boolean() });

export const BotSettingsSchema = z.object({ auto_update_model: z.boolean(), bm_cookie_enabled: z.boolean(), enable_js: z.boolean(), suppress_session_score: z.boolean(), using_latest_model: z.boolean() });
export const BotSummarySchema = z.strictObject({ userAgent: Label, score: z.number().int().min(1).max(99).nullable(), action: Label.nullable(), classification: z.enum(['automated', 'unknown']), subscriptionReadback: z.enum(['available', 'unavailable']) });
export const RateSettingsSchema = z.strictObject({ period: z.number().int().positive().max(3600), requests_per_period: z.number().int().positive().max(100000), mitigation_timeout: z.number().int().nonnegative().max(86400), characteristics: z.array(z.string().max(128)).min(1).max(10), requests_to_origin: z.boolean().optional(), counting_expression: BoundedText.optional() });
export const RateSummarySchema = z.strictObject({ admitted: UnknownCount, mitigated: UnknownCount, unknown: UnknownCount, sharedKeyContamination: z.enum(['suspected', 'not-observed', 'unknown']), cooldownUntil: Time.nullable() });
export const DashboardPage = z.enum(['/:account/:zone/security/security-rules', '/:account/:zone/security/settings', '/:account/turnstile', '/:account/:zone/ssl-tls/client-certificates', '/:account/:zone/traffic/waiting-rooms', '/:account/:zone/security/analytics']);
export const PolicyViewSchema = z.strictObject({
  scenarioId: ScenarioId, product: Label, desired: z.array(BoundedText).max(31), before: Label, after: Label,
  targets: z.array(z.strictObject({ role: Role, hostname: z.string().max(253), paths: z.array(z.string().max(256)).max(20) })).length(2),
  inspection: z.strictObject({ url: z.url().refine(value => { const url = new URL(value); return !url.username && !url.password && !url.hash && url.pathname === '/' && (url.origin === 'https://one.dash.cloudflare.com' ? !url.search : url.origin === 'https://dash.cloudflare.com' && url.searchParams.size === 1 && DashboardPage.safeParse(url.searchParams.get('to')).success); }), navigation: z.array(Label).max(12), accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/), resourceId: Label.nullable(), selector: z.literal(true) }),
  observed: z.strictObject({ state: z.enum(['unknown', 'fixture', 'saved', 'last-checked', 'stale', 'mismatch']), runId: Id.nullable(), observedAt: Time.nullable(), digest: Digest.nullable(), name: Label.nullable(), resourceId: Label.nullable(), rulesetId: Label.nullable(), version: Label.nullable(), enabled: z.boolean().nullable(), action: Label.nullable(), expression: BoundedText.nullable(), priority: z.number().int().nullable(), order: z.number().int().positive().nullable(), mode: Mode.nullable() }),
  settings: z.array(z.strictObject({ name: Label, value: Label.nullable() })).max(12),
  mismatches: z.array(Label).max(30), readinessBlocked: z.boolean(), mitigationVerified: z.literal(false), reason: Label,
});
export type PolicyView = z.infer<typeof PolicyViewSchema>;

export const EvidenceViewSchema = z.strictObject({
  runId: Id, scenarioId: ScenarioId, mode: Mode, startedAt: Time, endedAt: Time,
  roles: z.array(z.strictObject({
    role: Role, requests: UnknownCount, originReceived: UnknownCount, originAbsent: UnknownCount, originUnknown: UnknownCount,
    edgeEvents: UnknownCount, rules: UnknownCount,
    sources: z.array(z.strictObject({ source: z.enum(['http', 'origin', 'cloudflare']), state: z.enum(['pending', 'last-checked', 'stale', 'sampled', 'unavailable']), observedAt: Time.nullable(), sampling: z.enum(['unknown', 'sampled', 'complete']).nullable() })).length(3),
    actions: z.array(z.strictObject({ product: Label, action: Label, ruleId: Label.nullable(), count: z.number().int().positive() })).max(200),
    evidenceIds: z.array(Id).max(200),
  })).length(2),
});
export type EvidenceView = z.infer<typeof EvidenceViewSchema>;

export const AcceptanceSchema = z.strictObject({
  schemaVersion: Version, id: Label, mode: Mode, requirements: z.array(Label).min(1).max(50),
  runId: Id, releaseDigest: Digest, observedConfigDigest: Digest.nullable(),
  assertions: z.array(z.strictObject({ name: Label, passed: z.boolean(), evidenceIds: z.array(Id).max(100) })).min(1).max(100),
  requestsUsed: z.number().int().nonnegative(), durationMs: z.number().nonnegative(),
  outcome: z.enum(['passed', 'failed', 'unavailable']),
}).refine(v => v.outcome !== 'passed' || v.assertions.every(a => a.passed), 'Every assertion must pass');

export type Budget = z.infer<typeof BudgetSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ScenarioResult = z.infer<typeof ResultSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;
