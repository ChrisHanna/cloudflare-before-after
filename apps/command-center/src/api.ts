import { z } from 'zod';
import { ImageVariantDeclarationSchema } from '../../../packages/demo-core/src/image-variant-view.js';
import type { BrowserFrameScope } from '../../../packages/demo-core/src/browser-transport.js';
import { AdmittedNavigationSchema, BrowserFrameScopeSchema, BrowserPreviewSchema, InterviewViewSchema, ScopedReadinessSchema, WaitingRoomViewSchema, validateBrowserFrame } from './workshop-views.js';
import { BotSummarySchema, Digest, EvidenceViewSchema, ManifestSchema, Mode, ObservationSchema, Outcome, PolicyViewSchema, RateSummarySchema, ResultSchema } from '../../../packages/contracts/src/schemas.js';
const Text = z.string().max(4096);
const Origin = z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password; });
export const CatalogSchema = z.object({ schemaVersion: z.literal(1), mode: z.enum(['live', 'fixture']), configured: z.boolean(), imageVariant: ImageVariantDeclarationSchema.nullable().optional(), cloudflare: z.object({ accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/), labId: z.string().max(64), workers: z.array(z.object({ role: z.enum(['before', 'after']), name: z.string().max(128) })).max(2) }).nullable().optional(), policies: z.array(PolicyViewSchema).max(11), targets: z.array(z.object({ role: z.enum(['before', 'after']), origin: Origin, releaseDigest: Digest })).max(2), scenarios: z.array(ManifestSchema.safeExtend({ implemented: z.boolean() })).length(11), aggregates: z.object({ interview: z.boolean(), all: z.boolean(), rehearsal: z.boolean() }) });
export type Catalog = z.infer<typeof CatalogSchema>;
const ActivitySchema = z.object({ available: z.boolean(), reason: z.string().max(200).optional(), observedAt: z.string().max(40).optional(), windowMinutes: z.number().optional(), events: z.array(z.object({ role: z.enum(['before', 'after']), time: z.string().max(40), path: z.string().max(256), status: z.number(), action: z.string().max(64).nullable(), reachedOrigin: z.boolean(), rayId: z.string().max(32).nullable() })).max(100) });
export type Activity = z.infer<typeof ActivitySchema>;
const Notes = z.object({ problem: Text, solution: Text, limitations: Text, question: Text });
const Doctor = z.object({ mode: Mode, scope: z.enum(['catalog', 'core-waf']), preflightReady: z.boolean(), observedAt: z.iso.datetime(), checks: z.array(z.object({ id: z.string().max(128), state: z.enum(['passed', 'failed', 'unavailable', 'unknown']), detail: Text, correctiveAction: Text })).max(100), claims: z.object({ deploymentVerified: z.literal(false), mitigationVerified: z.literal(false), interviewVerified: z.literal(false), workshopVerified: z.literal(false) }) });
export const ReadinessSchema = z.object({ scoped: ScopedReadinessSchema.nullable().optional(), policyReadinessBlocked: z.boolean().optional(), report: Doctor.nullable(), freshness: z.enum(['last-checked', 'stale', 'historical', 'unavailable']), automaticallyRefreshed: z.literal(false), currentPreflightReady: z.boolean() });
export type Readiness = z.infer<typeof ReadinessSchema>;
const SequenceOutcome = z.enum(['verified', 'failed', 'inconclusive', 'unavailable', 'skipped']);
const Result = z.union([
  z.object({ kind: z.literal('aggregate'), result: z.object({ command: z.enum(['all', 'rehearsal']), mode: Mode, items: z.array(z.object({ scenarioId: z.string().max(64), outcome: SequenceOutcome, reason: Text.nullable(), cleanup: z.enum(['complete', 'incomplete', 'not-needed']) })).length(11), allRequiredVerified: z.boolean(), cleanRehearsal: z.boolean(), sequenceCompleted: z.boolean(), requestsUsed: z.number().int().min(0).max(300), durationMs: z.number().nonnegative(), blockers: z.array(Text).max(100) }) }),
  z.object({ kind: z.literal('interview'), result: z.object({ mode: Mode, interviewVerified: z.boolean(), sequenceCompleted: z.boolean(), requestsUsed: z.number().int().min(0).max(100), durationMs: z.number().nonnegative(), stages: z.array(z.object({ id: z.string().max(32), outcome: SequenceOutcome, missingProof: z.array(Text).max(100), fallbackLabel: z.literal('SAVED EVIDENCE').nullable() })).length(5) }) }),
  z.object({ kind: z.literal('result'), report: z.object({ mode: Mode, result: ResultSchema, notes: Notes, rateLimitSummary: RateSummarySchema.optional(), botSummary: BotSummarySchema.optional() }), journalComplete: z.boolean() }),
  z.object({ kind: z.literal('doctor'), report: Doctor }),
  z.object({ kind: z.literal('result'), outcome: z.enum(['unavailable', 'failed', 'inconclusive', 'skipped']), reason: Text.optional() }),
]);
const FrameScopes = z.array(BrowserFrameScopeSchema).max(8).refine(scopes => new Set(scopes.map(scope => scope.sessionId)).size === scopes.length && new Set(scopes.map(scope => scope.ownerId)).size <= 1, 'Unique owned session scopes required');
export const JobSchema = z.object({ frameScopes: FrameScopes.optional(), navigationPaths: z.array(z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/).max(256)).max(16).optional(), waitingRoom: WaitingRoomViewSchema.nullable().optional(), interview: InterviewViewSchema.nullable().optional(), policies: z.array(PolicyViewSchema).max(11).optional(), ownership: z.enum(['control', 'cli']), readOnly: z.boolean(), historical: z.boolean(), capturedOutcome: Outcome.nullable().optional(), evidence: EvidenceViewSchema.nullable().optional(), id: z.uuid(), command: z.string().max(128), status: z.enum(['running', 'finished', 'failed', 'cancelled']), phase: z.string().max(32), actualRunId: z.uuid().nullable(), createdAt: z.iso.datetime(), finishedAt: z.iso.datetime().nullable(), exitCode: z.number().int().nullable(), error: Text.nullable(), eventSequence: z.number().int().nonnegative(), truncated: z.boolean(), reportId: z.uuid().nullable(), result: Result.nullable().optional(), observations: z.array(ObservationSchema).max(100).optional() }).refine(job => !job.frameScopes?.some(scope => scope.runId !== job.actualRunId || !job.waitingRoom?.sessions.some(session => session.sessionId === scope.sessionId)), 'Frame scopes must match the actual runner sessions');
export type Job = z.infer<typeof JobSchema>;
export const JobResponse = z.object({ run: JobSchema });
export const RunsSchema = z.object({ activeRunId: z.uuid().nullable(), runs: z.array(JobSchema).max(32) });
export const JournalRunsSchema = z.object({ runs: z.array(JobSchema).max(32), truncated: z.boolean() });
export interface CommandRequest { command: string; scope?: 'catalog' | 'core-waf'; limits: { requests: number; concurrency: number; maxRuntimeSeconds: number; sessions?: number } }
export class ApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class ControlClient {
  #csrf = '';
  clear(): void { this.#csrf = ''; }
  async json(path: string, method = 'GET', body?: unknown, bootstrap = false, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith('/api/')) throw new Error('Only local control API paths are supported');
    const response = await fetch(path, { ...(signal ? { signal } : {}), method, credentials: 'same-origin', cache: 'no-store', headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(!bootstrap && method !== 'GET' ? { 'x-csrf-token': this.#csrf } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status === 401 && !bootstrap) this.clear();
      const message = z.object({ error: Text }).safeParse(result);
      throw new ApiError(response.status, message.success ? message.data.error : 'Local request could not complete');
    }
    return result;
  }
  async session(): Promise<void> {
    const result = z.object({ authenticated: z.literal(true), csrfToken: z.string().regex(/^[a-f0-9]{64}$/), expiresAt: z.number() }).parse(await this.json('/api/session'));
    this.#csrf = result.csrfToken;
  }
  async requestSignIn() { return z.object({ code: z.string().regex(/^[A-F0-9]{8}$/), expiresAt: z.number(), pending: z.literal(true) }).parse(await this.json('/api/bootstrap/request', 'POST', {}, true)); }
  async signInStatus() { return z.object({ pending: z.boolean(), authenticated: z.boolean().optional() }).parse(await this.json('/api/bootstrap/status', 'GET', undefined, true)); }
  async catalog() { return CatalogSchema.parse(await this.json('/api/catalog')); }
  async readiness() { return ReadinessSchema.parse(await this.json('/api/readiness')); }
  async activity() { return ActivitySchema.parse(await this.json('/api/activity')); }
  async runs() { return RunsSchema.parse(await this.json('/api/runs')); }
  async journalRuns() { return JournalRunsSchema.parse(await this.json('/api/journal-runs')); }
  async journalJob(id: string) { return JobResponse.parse(await this.json(`/api/journal-runs/${z.uuid().parse(id)}`)).run; }
  async job(id: string) { return JobResponse.parse(await this.json(`/api/runs/${z.uuid().parse(id)}`)).run; }
  async plan(command: CommandRequest) {
    return z.object({ exitCode: z.number().int(), error: Text.nullable(), plan: z.object({ kind: z.literal('planned'), executable: z.boolean(), verified: z.literal(false), networkCalls: z.literal(0), availability: Text, limits: z.record(z.string(), z.number()) }).nullable() }).parse(await this.json('/api/plans', 'POST', command));
  }
  async start(command: CommandRequest, key: string) { return JobResponse.parse(await this.json('/api/runs', 'POST', { ...command, idempotencyKey: key, liveOptIn: true })).run; }
  async preview(id: string, sessionId: string, signal?: AbortSignal) {
    const session = z.string().regex(/^session-[1-8]$/).parse(sessionId);
    return BrowserPreviewSchema.parse(await this.json(`/api/runs/${z.uuid().parse(id)}/sessions/${session}/preview`, 'GET', undefined, false, signal));
  }
  async frame(id: string, scope: BrowserFrameScope, mode: 'live' | 'fixture', signal?: AbortSignal) {
    const checked = BrowserFrameScopeSchema.parse(scope);
    const value = await this.json(`/api/runs/${z.uuid().parse(id)}/sessions/${checked.sessionId}/capture`, 'POST', checked, false, signal);
    return validateBrowserFrame(value, checked, mode);
  }
  async navigateShopper(id: string, scope: BrowserFrameScope, path: string, signal?: AbortSignal) {
    const body = AdmittedNavigationSchema.parse({ scope, path });
    const result = await this.json(`/api/runs/${z.uuid().parse(id)}/sessions/${body.scope.sessionId}/navigation`, 'POST', body, false, signal);
    return z.strictObject({ waitingRoom: WaitingRoomViewSchema }).parse(result).waitingRoom;
  }
  async advance(id: string) { return this.json(`/api/runs/${z.uuid().parse(id)}/advance`, 'POST', {}); }
  async stop(id: string) { return this.json(`/api/runs/${z.uuid().parse(id)}/stop`, 'POST', {}); }
}
