import { z } from 'zod';
import { PublicVariantFunctionalSchema, PublicVariantProofSchema, type PublicVariantProof } from '../../contracts/src/public-variant-proof.js';
import { selectedImageVariantId } from './image-variant-selection.js';
import { assertDeclaredPublicVariant, selectedVariantGroupSchema } from './public-variant-readback.js';
import { createHash, randomUUID } from 'node:crypto';
import { sealProviderObservation, type ProviderReadContext } from './provider-observation.js';
import { D1ProbeRowSchema, D1WriteReadReceiptSchema, D1_PROBE_MARKER, type D1WriteReadReceipt } from '../../contracts/src/d1-probe.js';
import { R2ProbeRowSchema, R2WriteReadReceiptSchema, R2_PROBE_MARKER, type R2WriteReadReceipt } from '../../contracts/src/r2-probe.js';
import { WorkerCodeFingerprintSchema, type WorkerCodeFingerprint } from '../../contracts/src/worker-code.js';
import { ServiceReadReceiptSchema, type ServiceReadReceipt } from '../../contracts/src/service-read.js';
import { CoverageSchema, Digest, Id, ReceiptSchema, Role, ScenarioId, Time } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { type BudgetLedger, type RequestReservation } from './budget.js';
import { LabConfigSchema, type LabConfig } from './config.js';
import { CloudflareReader } from './cloudflare.js';
import { apiShieldModule, ApiShieldPolicySchema, ApiShieldReadbackSchema, type ApiShieldPolicy } from './api-shield.js';
import { AccessPolicySchema, type AccessPolicy } from './access-policy.js';
import { PolicySignalSchema, type PolicyRequest } from './api-shield-proof.js';
import { digestValue } from './canonical.js';
import { ImageAssetSchema, type ImageAsset } from '../../../apps/storefront-worker/src/assets.js';
import { AccessAuthenticationEvidenceSchema, type AccessAuthenticationEvidence } from '../../contracts/src/access-authentication.js';
import { AccessApplicationSchema, AccessServiceRuleSchema, AccessTokenMapSchema, evaluateAccessReadback, type AccessTokenMap } from './access-policy-readback.js';
import { AccessSnapshotSchema, type AccessSnapshot } from '../../contracts/src/access-service-identity.js';

class AccessIncompleteInventory extends Error {}
const AccessPage = z.object({ page: z.number().int().positive().optional(), total_pages: z.number().int().nonnegative().optional(),
  cursor: z.string().max(4096).nullable().optional(), count: z.number().int().nonnegative().max(100).optional(),
  total_count: z.number().int().nonnegative().optional(), per_page: z.number().int().positive().max(100).optional(), unqualified: z.boolean().optional(),
}).catchall(z.unknown()).transform(p => ({ page: p.page, total_pages: p.total_pages, cursor: p.cursor, count: p.count,
  total_count: p.total_count, per_page: p.per_page, unqualified: p.unqualified === true || Object.keys(p).some(k => !['page', 'total_pages', 'cursor', 'count', 'total_count', 'per_page', 'unqualified'].includes(k)) }));
function accessEnvelope<S extends z.ZodType>(schema: S) {
  return z.object({ success: z.boolean(), result: schema.nullable().optional(), result_info: AccessPage.optional(),
    messages: z.array(z.unknown()).max(100).optional(), errors: z.array(z.unknown()).max(100).optional(), unqualified: z.boolean().optional(),
  }).catchall(z.unknown()).transform(e => ({ success: e.success, result: e.result, result_info: e.result_info,
    unqualified: e.unqualified === true || !!e.messages?.length || !!e.errors?.length
      || Object.keys(e).some(k => !['success', 'result', 'result_info', 'messages', 'errors', 'unqualified'].includes(k)) }));
}
const accessSnapshots = new WeakMap<object, { digest: string; clientId: string; tokenExpiresAt: string; owner: object; current: () => boolean }>();
/** Only current guarded reads from this collector, never serialized/callback proof. */
export function observedAccessSnapshot(snapshot: AccessSnapshot, owner: object, now: number): { clientId: string; tokenExpiresAt: string } | null {
  try {
    const record = accessSnapshots.get(snapshot);
    if (!record || record.owner !== owner || !record.current() || !AccessSnapshotSchema.safeParse(snapshot).success
      || record.digest !== digestValue(snapshot) || !Number.isSafeInteger(now) || Date.parse(snapshot.startedAt) > Date.parse(snapshot.observedAt)
      || now < Date.parse(snapshot.observedAt) || now - Date.parse(snapshot.startedAt) > 120000 || Date.parse(record.tokenExpiresAt) <= now) return null;
    return { clientId: record.clientId, tokenExpiresAt: record.tokenExpiresAt };
  } catch { return null; }
}

/** Validate the actual private pair, without exposing its Client IDs or minting a source. */
export function isCurrentAccessSnapshotPair(before: AccessSnapshot, after: AccessSnapshot, now: number): boolean {
  const a = accessSnapshots.get(before); const b = accessSnapshots.get(after);
  if (!a || !b || a.owner !== b.owner) return false;
  const pre = observedAccessSnapshot(before, a.owner, now); const post = observedAccessSnapshot(after, b.owner, now);
  return !!pre && !!post && pre.clientId === post.clientId && pre.tokenExpiresAt === post.tokenExpiresAt
    && before.phase === 'before' && after.phase === 'after' && before.runId === after.runId && before.mode === after.mode
    && before.accountId === after.accountId && before.applicationId === after.applicationId && before.configuredPolicyId === after.configuredPolicyId
    && before.audience === after.audience && before.hostname === after.hostname && before.functionalDigest === after.functionalDigest
    && before.observedAt <= after.startedAt && before.readId !== after.readId;
}

export interface TrustedRead<T> {
  state: 'observed' | 'unknown' | 'mismatch' | 'unsupported';
  permission: 'granted' | 'denied' | 'unknown';
  /** Neither a successful configuration read nor a 403 proves entitlement. */
  entitlement: 'unknown';
  mode: 'live' | 'fixture'; observedAt: string; value: T | null; gaps: string[];
}
const Scope = z.strictObject({ role: Role, hostname: z.hostname(), runId: Id, scenarioId: ScenarioId,
  requestId: Id, releaseDigest: Digest, start: Time, end: Time }).refine(s => s.start <= s.end && Date.parse(s.end) - Date.parse(s.start) <= 120000);
export type TrustedScope = z.infer<typeof Scope>;
const OriginRead = z.strictObject({ schemaVersion: z.literal(1), targetRole: Role, runId: Id, scenarioId: ScenarioId,
  originCount: z.number().int().nonnegative().nullable(), receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema });
export interface TrustedOrigin {
  receipts: z.infer<typeof ReceiptSchema>[]; coverage: z.infer<typeof CoverageSchema>;
  originCount: number | null; requestEntered: boolean; requestCompleted: boolean; absenceProven: boolean;
}
const ProviderId = z.string().regex(/^[a-f0-9]{32}$/);
const AccessId = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const Rule = z.object({ id: ProviderId, expression: z.string().max(4096), action: z.string().max(100), enabled: z.boolean().default(true) });
const Rules = z.object({ id: ProviderId, version: z.string().max(128), phase: z.literal('http_request_firewall_custom'), rules: z.array(Rule).max(100) });
const Page = z.object({ page: z.number().int().positive().optional(), total_pages: z.number().int().nonnegative().optional(), cursor: z.string().nullable().optional() });
const publicProofs = new WeakMap<object, string>();
/** Only unchanged in-memory results of actual bounded provider reads are current proof.
 * Serialized artifacts, desired state, and relabelled copies cannot be replayed. */
export function isObservedPublicVariantProof(input: PublicVariantProof): boolean {
  try { return PublicVariantProofSchema.safeParse(input).success && publicProofs.get(input) === digestValue(input); }
  catch { return false; }
}
export interface TrustedPolicy {
  product: 'mtls' | 'access'; matches: boolean; functionalDigest: string; priority: number;
  readback: Record<string, string | boolean> | null; providerRevision: string | null;
}
export interface TrustedBindings {
  role: 'before' | 'after'; accountId: string; workerName: string;
  bindings: { name: string; type: string; database_id?: string | undefined; bucket_name?: string | undefined; namespace_id?: string | undefined; class_name?: string | undefined; script_name?: string | undefined; environment?: string | undefined }[];
  functionalDigest: string;
  /** Worker settings do not attest the running Container or application release. */
  releaseDigest: null; containerDigest: null;
}
export interface TrustedServiceRead {
  scope: TrustedScope; status: number; container: TrustedOrigin | null; receipt: ServiceReadReceipt;
  operations: ServiceReadReceipt['operations']; serviceStates: { d1: 'observed' | 'unknown'; r2: 'observed' | 'unknown'; images: 'unknown'; container: 'observed' | 'unknown' };
}
export interface TrustedD1WriteRead {
  scope: TrustedScope; status: number; receipt: D1WriteReadReceipt; container: TrustedOrigin | null;
  writeReadConfirmed: boolean; cleanupConfirmed: boolean; isolation: 'unknown';
}
export interface TrustedR2WriteRead extends Omit<TrustedD1WriteRead, 'receipt'> { receipt: R2WriteReadReceipt }
export interface TrustedPolicyAttribution {
  edge: Awaited<ReturnType<CloudflareReader['securityEvents']>> | null;
  policySignal: z.infer<typeof PolicySignalSchema> | null;
  accessAuthentication?: AccessAuthenticationEvidence;
}
export interface TrustedCollectorsOptions {
  config: LabConfig; ledger: BudgetLedger; observedOwnedResources: ReadonlySet<string>;
  mode: 'live' | 'fixture'; credentials: { reader: string; collector: string; runner: string };
  /** No global fetch fallback. The operator must explicitly supply transport. */
  dispatch?: Dispatch; maxReads?: number; now?: () => number;
}

/** Only named reads exist here. No endpoint, query-language, or shell proxy. */
export class TrustedCollectors {
  readonly #client: GuardedClient; readonly #config: LabConfig; readonly #options: TrustedCollectorsOptions;
  #reads = 0;
  readonly #readReservations = new Map<RequestReservation, number>();
  readonly #accessRefresh = new Map<string, number>();
  #accessLegacyRun = '';
  #accessVisibilityEpoch = 0;
  readonly #accessVisibility = new Map<string, { valid: boolean; expiresAt: number; readAt: number; promise: Promise<boolean> }>();
  #mtlsRefresh = 0;
  #mtlsSnapshot: { readback: z.infer<typeof ApiShieldReadbackSchema>; observedAt: string; runId: string } | null = null;
  constructor(options: TrustedCollectorsOptions) {
    const credentials = z.strictObject({ reader: z.string().min(24).max(256), collector: z.string().min(24).max(256), runner: z.string().min(24).max(256) }).parse(options.credentials);
    if (new Set(Object.values(credentials)).size !== 3) throw new Error('Separate read, collector and runner credentials required');
    z.enum(['live', 'fixture']).parse(options.mode);
    const maxReads = z.number().int().min(1).max(100).parse(options.maxReads ?? 24);
    this.#config = LabConfigSchema.parse(options.config);
    this.#options = { ...options, credentials, maxReads, config: this.#config };
    const dispatch: Dispatch = async (url, init) => {
      if (!options.dispatch) throw new Error('Provider transport denied by default');
      const response = await options.dispatch(url, init);
      // A denial need not have a JSON body. Preserve its status, not its text.
      if ([401, 403].includes(response.status)) {
        await response.body?.cancel();
        return Response.json({ success: false, result: null }, { status: response.status });
      }
      return response;
    };
    this.#client = new GuardedClient(this.#config, options.ledger, { observedOwnedResources: options.observedOwnedResources,
      dispatch, redactor: new Redactor(Object.values(credentials)) });
  }
  get readsUsed(): number { return this.#reads; }
  #time(): string { return new Date((this.#options.now ?? Date.now)()).toISOString(); }
  #result(state: TrustedRead<never>['state'], value: null, gaps: string[], permission?: TrustedRead<never>['permission']): TrustedRead<never>;
  #result<T>(state: TrustedRead<T>['state'], value: T, gaps: string[], permission?: TrustedRead<T>['permission']): TrustedRead<T>;
  #result<T>(state: TrustedRead<T>['state'], value: T | null, gaps: string[], permission: TrustedRead<T>['permission'] = 'unknown'): TrustedRead<T> {
    return { state, permission, entitlement: 'unknown', mode: this.#options.mode, observedAt: this.#time(), value, gaps };
  }
  #permit(signal?: AbortSignal, reservation?: RequestReservation): void {
    signal?.throwIfAborted(); this.#options.ledger.signal.throwIfAborted();
    if (reservation) {
      const remaining = this.#readReservations.get(reservation);
      if (!remaining) throw new Error('Collector reservation unavailable');
      this.#readReservations.set(reservation, remaining - 1);
    } else if (this.#reads + [...this.#readReservations.values()].reduce((a, b) => a + b, 0) >= this.#options.maxReads!) throw new Error('Collector read cap reached');
    this.#reads++;
  }
  #scope(value: TrustedScope): TrustedScope {
    const scope = Scope.parse(value); const env = this.#config.environments.find(e => e.role === scope.role)!;
    const now = this.#time();
    if (scope.hostname !== new URL(env.origin).hostname || scope.releaseDigest !== env.releaseDigest || scope.end > now || Date.parse(now) - Date.parse(scope.end) > 120000) throw new Error('Foreign, stale or future collector scope');
    return scope;
  }
  async #provider<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal): Promise<TrustedRead<z.infer<S>>> {
    try {
      this.#permit(signal);
      const response = await this.#client.requestJson({ kind: 'cloudflare', url: `${this.#config.apiOrigin}/client/v4${path}`,
        headers: { authorization: `Bearer ${this.#options.credentials.reader}` }, retries: 0 },
      z.object({ success: z.boolean(), result: schema.nullable().optional(), result_info: Page.optional() }), signal);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['Provider read permission denied'], 'denied');
      if (response.status !== 200 || !response.data.success || response.data.result == null) return this.#result('unknown', null, ['Provider observation unavailable']);
      const page = response.data.result_info;
      if ((path.includes('?per_page=') && !page) || (page && ((page.page ?? 1) !== 1 || (page.total_pages ?? 1) > 1 || page.cursor))) return this.#result('unknown', null, ['Missing provider pages; no partial state accepted'], 'granted');
      return this.#result('observed', schema.parse(response.data.result), [], 'granted');
    } catch { return this.#result('unknown', null, ['Provider read failed or exceeded its bounds']); }
  }
  async origin(value: TrustedScope, signal?: AbortSignal, reservation?: RequestReservation): Promise<TrustedRead<TrustedOrigin>> {
    const scope = this.#scope(value);
    try {
      this.#permit(signal, reservation);
      const env = this.#config.environments.find(e => e.role === scope.role)!;
      const checkpoint = await this.#client.request({ kind: scope.role,
        url: `${env.origin}/internal/checkpoint?${new URLSearchParams({ runId: scope.runId, scenarioId: scope.scenarioId })}`,
        headers: { 'x-demo-run-token': this.#options.credentials.runner }, retries: 0 }, signal, reservation);
      if ([401, 403].includes(checkpoint.status)) return this.#result('unknown', null, ['Checkpoint read denied'], 'denied');
      if (checkpoint.status !== 200) return this.#result('unknown', null, ['Producer checkpoint unavailable']);
      this.#permit(signal, reservation);
      const response = await this.#client.requestJson({ kind: 'telemetry',
        url: `${this.#config.telemetryOrigin}/receipts?${new URLSearchParams({ role: scope.role, runId: scope.runId, scenarioId: scope.scenarioId, start: scope.start, end: scope.end })}`,
        headers: { authorization: `Bearer ${this.#options.credentials.collector}` }, retries: 0 },
      z.union([OriginRead, z.object({ success: z.literal(false), result: z.null() })]), signal, reservation);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['Receipt read denied'], 'denied');
      if (response.status !== 200 || !('receipts' in response.data)) return this.#result('unknown', null, ['Receipt channel unavailable']);
      const d = response.data;
      if (d.targetRole !== scope.role || d.runId !== scope.runId || d.scenarioId !== scope.scenarioId || d.coverage.windowStart !== scope.start ||
        d.receipts.some(r => r.targetRole !== scope.role || r.runId !== scope.runId || r.scenarioId !== scope.scenarioId || r.releaseDigest !== scope.releaseDigest || r.observedAt < scope.start || r.observedAt > scope.end) ||
        new Set(d.receipts.map(r => r.id)).size !== d.receipts.length || new Set(d.receipts.map(r => `${r.producerId}:${r.sequence}`)).size !== d.receipts.length) {
        return this.#result('mismatch', null, ['Foreign, stale or duplicate origin records'], 'granted');
      }
      const c = d.coverage; const entries = d.receipts.filter(r => r.stage === 'entry');
      const producers = new Map<string, number>(); let contiguous = true;
      for (const receipt of d.receipts) {
        const last = producers.get(receipt.producerId);
        if (last !== undefined && receipt.sequence !== last + 1) contiguous = false;
        if (c.producerSequence !== null && receipt.sequence > c.producerSequence) contiguous = false;
        producers.set(receipt.producerId, receipt.sequence);
      }
      // The deployed endpoint returns a single producer's sequence when it can
      // attest one. Never accept a forged single-sequence summary for many.
      const healthy = contiguous && producers.size <= 1 && c.healthy && c.complete && c.gaps.length === 0 && c.producerSequence !== null && c.watermark !== null && c.watermark >= scope.end && c.watermark <= this.#time() && c.producerSequence >= d.receipts.length && d.originCount === entries.length;
      const joined = d.receipts.filter(r => r.requestId === scope.requestId);
      const requestEntries = joined.filter(r => r.stage === 'entry'); const completions = joined.filter(r => r.stage === 'completion');
      const entry = requestEntries[0]; const completion = completions[0];
      const completeRequest = requestEntries.length === 1 && completions.length === 1 && !!entry && !!completion && entry.producerId === completion.producerId && entry.sequence < completion.sequence && entry.observedAt <= completion.observedAt;
      const origin: TrustedOrigin = { receipts: joined, coverage: c, originCount: healthy ? entries.length : null,
        requestEntered: !!entry, requestCompleted: healthy && completeRequest, absenceProven: healthy && joined.length === 0 };
      return this.#result(healthy ? 'observed' : 'unknown', origin, healthy ? [] : ['Healthy complete origin coverage is missing'], 'granted');
    } catch { return this.#result('unknown', null, ['Origin read failed or exceeded its bounds']); }
  }
  async serviceRead(value: TrustedScope, signal?: AbortSignal): Promise<TrustedRead<TrustedServiceRead>> {
    const scope = this.#scope(value); const env = this.#config.environments.find(e => e.role === scope.role)!;
    try {
      this.#permit(signal);
      const response = await this.#client.requestJson({ kind: scope.role, url: `${env.origin}/internal/service-read`, retries: 0,
        headers: { 'x-demo-run-token': this.#options.credentials.runner, 'x-demo-run-id': scope.runId, 'x-demo-request-id': scope.requestId, 'x-demo-scenario': scope.scenarioId } }, ServiceReadReceiptSchema, signal);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['Service read denied'], 'denied');
      const end = this.#time();
      const origin = await this.origin({ ...scope, end }, signal);
      const receipt = response.data;
      if (receipt.targetRole !== scope.role || receipt.runId !== scope.runId || receipt.requestId !== scope.requestId || receipt.scenarioId !== scope.scenarioId || receipt.releaseDigest !== scope.releaseDigest || receipt.observedAt < scope.start || receipt.observedAt > end || receipt.operations.some(op => op.resourceId !== (op.service === 'd1' ? env.d1Id : op.service === 'r2' ? env.r2Bucket : env.containerBinding))) return this.#result('mismatch', null, ['Foreign or incomplete service-operation receipt'], 'granted');
      const joined = response.status === 200 && response.metadata.role === scope.role && response.metadata.releaseDigest === scope.releaseDigest && origin.state === 'observed' && origin.value?.requestCompleted;
      const state = joined ? 'observed' as const : 'unknown' as const;
      const value: TrustedServiceRead = { scope: { ...scope, end }, status: response.status, container: origin.value, receipt,
        operations: joined ? receipt.operations : [], serviceStates: { d1: state, r2: state, images: 'unknown', container: state } };
      return this.#result(state, value, ['Write/read and isolation checks remain unproven', 'Resource binding and Container release require independent provider readback', 'Image delivery/decode requires the image collector'], response.status === 200 ? 'granted' : 'unknown');
    } catch { return this.#result('unknown', null, ['Service read failed or exceeded its bounds']); }
  }
  /** Explicit effectful probe; never called by default read-only verification.
   * execute=true is a caller opt-in, not a substitute for reviewed live approval. */
  async d1WriteRead(value: TrustedScope, execute = false, signal?: AbortSignal): Promise<TrustedRead<TrustedD1WriteRead>> {
    const scope = this.#scope(value); const env = this.#config.environments.find(env => env.role === scope.role)!;
    if (execute !== true || scope.scenarioId !== 'waf-custom') return this.#result('unsupported', null, ['Explicit scoped D1 write/read execution required']);
    let reservation: RequestReservation | undefined;
    try {
      const reservedReads = [...this.#readReservations.values()].reduce((a, b) => a + b, 0);
      if (this.#reads + reservedReads + 3 > this.#options.maxReads!) throw new Error('D1 probe reads do not fit');
      reservation = this.#options.ledger.reserveRequests(3); this.#readReservations.set(reservation, 3);
      this.#permit(signal, reservation);
      const response = await this.#client.requestJson({ kind: scope.role, url: `${env.origin}/internal/d1-write-read`, method: 'POST', retries: 0,
        headers: { 'content-type': 'application/json', 'x-demo-run-token': this.#options.credentials.runner, 'x-demo-run-id': scope.runId,
          'x-demo-request-id': scope.requestId, 'x-demo-scenario': scope.scenarioId }, body: JSON.stringify({ action: 'd1-write-read' }) }, z.union([D1WriteReadReceiptSchema, z.object({ success: z.literal(false), result: z.null() })]), signal, reservation);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['D1 probe authorization denied'], 'denied');
      if (!('kind' in response.data)) return this.#result('unknown', null, ['D1 probe response unavailable; do not retry']);
      const receipt = response.data; const end = this.#time();
      if (receipt.targetRole !== scope.role || receipt.runId !== scope.runId || receipt.requestId !== scope.requestId || receipt.releaseDigest !== scope.releaseDigest
        || receipt.resourceId !== env.d1Id || receipt.observedAt < scope.start || receipt.observedAt > end) return this.#result('mismatch', null, ['Foreign D1 write/read receipt']);
      const expectedRow = D1ProbeRowSchema.parse({ environment: scope.role, scenario_id: 'waf-custom', run_id: scope.runId,
        request_id: scope.requestId, probe_id: receipt.probeId, marker: D1_PROBE_MARKER });
      const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRow)).digest('hex');
      if (receipt.read === 'observed' && receipt.contentDigest !== expectedDigest) return this.#result('mismatch', null, ['D1 readback digest differs from the controlled marker']);
      const origin = await this.origin({ ...scope, end }, signal, reservation);
      const joined = response.metadata.role === scope.role && response.metadata.releaseDigest === scope.releaseDigest && origin.state === 'observed' && origin.value?.requestCompleted === true;
      const writeReadConfirmed = joined && receipt.write === 'observed' && receipt.read === 'observed';
      const cleanupConfirmed = joined && receipt.cleanup === 'observed';
      return this.#result(response.status === 200 && writeReadConfirmed && cleanupConfirmed ? 'observed' : 'unknown', {
        scope: { ...scope, end }, status: response.status, receipt, container: origin.value, writeReadConfirmed, cleanupConfirmed, isolation: 'unknown',
      }, [...origin.gaps, 'Independent binding, runtime release and storage isolation proof remain required'], origin.permission);
    } catch { return this.#result('unknown', null, ['D1 probe incomplete; mutation may have occurred, do not automatically retry']); }
    finally { if (reservation) { this.#readReservations.delete(reservation); reservation.release(); } }
  }
  /** Explicit non-default operation, not a substitute for reviewed live approval. */
  async r2WriteRead(value: TrustedScope, execute = false, signal?: AbortSignal): Promise<TrustedRead<TrustedR2WriteRead>> {
    const scope = this.#scope(value); const env = this.#config.environments.find(env => env.role === scope.role)!;
    if (execute !== true || scope.scenarioId !== 'waf-custom') return this.#result('unsupported', null, ['Explicit scoped R2 write/read execution required']);
    let reservation: RequestReservation | undefined;
    try {
      const reservedReads = [...this.#readReservations.values()].reduce((a, b) => a + b, 0);
      if (this.#reads + reservedReads + 3 > this.#options.maxReads!) throw new Error('R2 probe reads do not fit');
      reservation = this.#options.ledger.reserveRequests(3); this.#readReservations.set(reservation, 3);
      this.#permit(signal, reservation);
      const response = await this.#client.requestJson({ kind: scope.role, url: `${env.origin}/internal/r2-write-read`, method: 'POST', retries: 0,
        headers: { 'content-type': 'application/json', 'x-demo-run-token': this.#options.credentials.runner, 'x-demo-run-id': scope.runId,
          'x-demo-request-id': scope.requestId, 'x-demo-scenario': scope.scenarioId }, body: JSON.stringify({ action: 'r2-write-read' }) },
        z.union([R2WriteReadReceiptSchema, z.object({ success: z.literal(false), result: z.null() })]), signal, reservation);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['R2 probe authorization denied'], 'denied');
      if (!('kind' in response.data)) return this.#result('unknown', null, ['R2 probe response unavailable; do not retry']);
      const receipt = response.data; const end = this.#time();
      if (receipt.targetRole !== scope.role || receipt.runId !== scope.runId || receipt.requestId !== scope.requestId || receipt.releaseDigest !== scope.releaseDigest
        || receipt.resourceId !== env.r2Bucket || receipt.observedAt < scope.start || receipt.observedAt > end) return this.#result('mismatch', null, ['Foreign R2 write/read receipt']);
      const expectedRow = R2ProbeRowSchema.parse({ environment: scope.role, scenario_id: 'waf-custom', run_id: scope.runId,
        request_id: scope.requestId, probe_id: receipt.probeId, marker: R2_PROBE_MARKER });
      const expectedDigest = createHash('sha256').update(JSON.stringify(expectedRow)).digest('hex');
      if (receipt.read === 'observed' && receipt.contentDigest !== expectedDigest) return this.#result('mismatch', null, ['R2 readback digest differs from the controlled marker']);
      const origin = await this.origin({ ...scope, end }, signal, reservation);
      const joined = response.metadata.role === scope.role && response.metadata.releaseDigest === scope.releaseDigest && origin.state === 'observed' && origin.value?.requestCompleted === true;
      const writeReadConfirmed = joined && receipt.write === 'observed' && receipt.read === 'observed';
      const cleanupConfirmed = joined && receipt.cleanup === 'observed';
      return this.#result(response.status === 200 && writeReadConfirmed && cleanupConfirmed ? 'observed' : 'unknown', {
        scope: { ...scope, end }, status: response.status, receipt, container: origin.value, writeReadConfirmed, cleanupConfirmed, isolation: 'unknown',
      }, [...origin.gaps, 'Independent binding, runtime release and storage isolation proof remain required'], origin.permission);
    } catch { return this.#result('unknown', null, ['R2 probe incomplete; mutation may have occurred, do not automatically retry']); }
    finally { if (reservation) { this.#readReservations.delete(reservation); reservation.release(); } }
  }
  async imageAsset(role: 'before' | 'after', signal?: AbortSignal): Promise<TrustedRead<ImageAsset>> {
    Role.parse(role); const env = this.#config.environments.find(e => e.role === role)!;
    const read = await this.#provider(`/accounts/${this.#config.accountId}/workers/scripts/${encodeURIComponent(env.workerName)}/settings`,
      z.object({ bindings: z.array(z.object({ name: z.string().max(128), type: z.string().max(100), text: z.string().max(4096).optional() }).transform(b => ({ name: b.name, type: b.type, text: b.name === 'IMAGE_ASSET_JSON' && b.type === 'plain_text' ? b.text : undefined }))).max(100) }), signal);
    if (!read.value) return { ...read, value: null };
    try {
      const bindings = read.value.bindings.filter(b => b.name === 'IMAGE_ASSET_JSON');
      if (bindings.length !== 1 || bindings[0]!.type !== 'plain_text') throw new Error('Missing or ambiguous image binding');
      const image = ImageAssetSchema.parse(JSON.parse(bindings[0]!.text ?? 'null'));
      if (image.role !== role || image.labId !== this.#config.labId || !env.imageIds.includes(image.id) || image.variant !== selectedImageVariantId(this.#config.labId, this.#config.imageVariant) || !this.#config.imageOrigins.includes(image.deliveryOrigin)) return this.#result('mismatch', null, ['Foreign image binding'], 'granted');
      return this.#result('observed', image, ['Delivery and decode remain unobserved'], 'granted');
    } catch { return this.#result('unknown', null, ['Owned image binding unavailable'], 'granted'); }
  }
  /** Three fresh account-scoped reads per phase: group plus both actual Worker assets. */
  async publicVariantProof(context: { runId: string; phase: 'before' | 'after'; startedAt: string }, signal?: AbortSignal): Promise<TrustedRead<PublicVariantProof>> {
    const scope = z.strictObject({ runId: Id, phase: z.enum(['before', 'after']), startedAt: Time }).parse(context);
    const selection = this.#config.imageVariant;
    if (!selection) return this.#result('unsupported', null, ['No public dependency was selected']);
    try {
      const elapsed = Date.parse(this.#time()) - Date.parse(scope.startedAt);
      if (elapsed < 0 || elapsed > 120000) return this.#result('unknown', null, ['Public dependency read scope is stale or future']);
      const group = await this.#provider(`/accounts/${this.#config.accountId}/images/v1/variants`, selectedVariantGroupSchema(selection.id), signal);
      if (group.state !== 'observed' || !group.value) return { ...group, value: null };
      const actual = group.value.variants.public;
      if (!actual) return this.#result('unknown', null, ['Selected public dependency is missing'], 'granted');
      const observedVariant = PublicVariantFunctionalSchema.shape.variant.parse({ source: 'existing-public-readonly', ...actual });
      let matches = true;
      try { assertDeclaredPublicVariant(group.value, selection); } catch { matches = false; }
      const assets: PublicVariantProof['functional']['assets'][number][] = [];
      const assetReads: PublicVariantProof['assetReads'][number][] = [];
      for (const role of ['before', 'after'] as const) {
        const env = this.#config.environments.find(env => env.role === role)!;
        const settings = await this.#provider(`/accounts/${this.#config.accountId}/workers/scripts/${env.workerName}/settings`,
          z.object({ bindings: z.array(z.object({ name: z.string().max(128), type: z.string().max(100), text: z.string().max(4096).optional() }).transform(binding => ({ name: binding.name, type: binding.type,
            text: binding.type === 'plain_text' && ['IMAGE_ASSET_JSON', 'ROLE', 'LAB_ID', 'ORIGIN', 'RELEASE_DIGEST'].includes(binding.name) ? binding.text : undefined }))).max(100) }), signal);
        if (settings.state !== 'observed' || !settings.value) return { ...settings, value: null };
        const bindings = settings.value.bindings;
        if (new Set(bindings.map(binding => binding.name)).size !== bindings.length) return this.#result('unknown', null, ['Ambiguous Worker asset bindings'], 'granted');
        const plain = (name: string) => bindings.find(binding => binding.name === name && binding.type === 'plain_text')?.text;
        const asset = ImageAssetSchema.parse(JSON.parse(plain('IMAGE_ASSET_JSON') ?? 'null'));
        const origin = z.url().parse(plain('ORIGIN')); const releaseDigest = Digest.parse(plain('RELEASE_DIGEST'));
        if (plain('ROLE') !== role || plain('LAB_ID') !== this.#config.labId || asset.role !== role || asset.labId !== this.#config.labId || !env.imageIds.includes(asset.id) || !this.#config.imageOrigins.includes(asset.deliveryOrigin)) return this.#result('mismatch', null, ['Foreign Worker image asset'], 'granted');
        if (asset.variant !== selection.id || origin !== env.origin || releaseDigest !== env.releaseDigest) matches = false;
        assets.push({ role, workerName: env.workerName, origin, releaseDigest, imageId: asset.id, variant: asset.variant,
          deliveryOrigin: asset.deliveryOrigin, accountHash: asset.accountHash, expectedDigest: asset.expectedDigest });
        assetReads.push({ role, readId: randomUUID(), observedAt: settings.observedAt });
      }
      const proof = PublicVariantProofSchema.parse({ schemaVersion: 1, kind: 'public-variant-proof', source: 'cloudflare-images-group-and-worker-bindings',
        ...scope, scenarioId: 'waf-custom', accountId: this.#config.accountId, labId: this.#config.labId, mode: this.#options.mode,
        observedAt: this.#time(), variantObservedAt: group.observedAt, readId: randomUUID(), assetReads,
        functional: { variant: observedVariant, assets } });
      publicProofs.set(proof, digestValue(proof));
      return this.#result(matches ? 'observed' : 'mismatch', proof, matches ? [] : ['Observed public dependency or Worker variant differs from declared selection'], 'granted');
    } catch { return this.#result('unknown', null, ['Public dependency observation failed or exceeded its current scope']); }
  }
  async workerBindings(role: 'before' | 'after', signal?: AbortSignal, context?: ProviderReadContext): Promise<TrustedRead<TrustedBindings>> {
    Role.parse(role); const env = this.#config.environments.find(e => e.role === role)!;
    const observation = context ? { runId: Id.parse(context.runId), phase: z.enum(['before', 'after']).parse(context.phase), accountId: this.#config.accountId, targetRole: role, workerName: env.workerName, readId: randomUUID() } : null;
    const schema = z.object({ bindings: z.array(z.object({ name: z.string().regex(/^[A-Za-z0-9_]{1,128}$/), type: z.string().max(100),
      database_id: z.string().max(128).optional(), bucket_name: z.string().max(128).optional(), namespace_id: z.string().max(128).optional(), class_name: z.string().max(128).optional(), script_name: z.string().max(128).optional(), environment: z.string().max(128).optional() })).max(100) });
    const read = await this.#provider(`/accounts/${this.#config.accountId}/workers/scripts/${encodeURIComponent(env.workerName)}/settings`, schema, signal);
    if (!read.value) return { ...read, value: null };
    const bindings = read.value.bindings.filter(b => ['d1', 'r2_bucket', 'durable_object_namespace'].includes(b.type)).sort((a, b) => a.name.localeCompare(b.name));
    if (new Set(bindings.map(b => b.name)).size !== bindings.length) return this.#result('mismatch', null, ['Duplicate functional bindings'], 'granted');
    const result = this.#result('observed', { role, accountId: this.#config.accountId, workerName: env.workerName, bindings, functionalDigest: digestValue(bindings), releaseDigest: null, containerDigest: null }, ['Worker settings cannot attest application or Container digests'], 'granted');
    return observation ? sealProviderObservation(result, observation) : result;
  }
  async workerCode(role: 'before' | 'after', signal?: AbortSignal, context?: ProviderReadContext): Promise<TrustedRead<WorkerCodeFingerprint>> {
    Role.parse(role); const env = this.#config.environments.find(env => env.role === role)!;
    const observation = context ? { runId: Id.parse(context.runId), phase: z.enum(['before', 'after']).parse(context.phase), accountId: this.#config.accountId, targetRole: role, workerName: env.workerName, readId: randomUUID() } : null;
    try {
      this.#permit(signal);
      const response = await this.#client.requestWorkerCode(role, this.#options.credentials.reader, signal);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['Worker content read denied'], 'denied');
      if (response.status !== 200) return this.#result('unknown', null, ['Worker content unavailable']);
      if (!response.code) return this.#result('unsupported', null, ['Worker representation or entrypoint is not qualified'], 'granted');
      const observedAt = this.#time();
      const value = WorkerCodeFingerprintSchema.parse({ schemaVersion: 1, kind: 'worker-code-fingerprint', source: 'cloudflare-workers-content-v2',
        observedAt, targetRole: role, accountId: this.#config.accountId, workerName: env.workerName, ...response.code, runtimeRelease: null, containerDigest: null });
      const result = { ...this.#result('observed', value, ['Code bytes do not attest runtime release, bindings or Container image'], 'granted'), observedAt };
      return observation ? sealProviderObservation(result, observation) : result;
    } catch { return this.#result('unknown', null, ['Worker code read failed or exceeded its bounds']); }
  }
  async mtlsPolicy(input: ApiShieldPolicy, signal?: AbortSignal, runId?: string): Promise<TrustedRead<TrustedPolicy>> {
    const generation = ++this.#mtlsRefresh; this.#mtlsSnapshot = null;
    if (runId !== undefined) Id.parse(runId);
    const p = ApiShieldPolicySchema.parse(input); this.#targets(p.beforeOrigin, p.afterOrigin);
    const expected = apiShieldModule(p);
    const read = await this.#provider(`/zones/${this.#config.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`, Rules, signal);
    if (!read.value) return { ...read, value: null };
    const rules = read.value.rules; const matching = rules.filter(r => r.id === p.policyId);
    if (matching.length !== 1 || rules.length === 100) return this.#result('unknown', null, ['Missing, duplicate or bounded-out mTLS rule'], 'granted');
    const rule = matching[0]!; const priority = rules.indexOf(rule);
    const matches = rule.expression === expected.expression && rule.enabled && rule.action === 'block' && p.enabled && p.baselineExcluded;
    const readback = { policyId: rule.id, hostname: expected.hostname, path: '/api', enabled: rule.enabled,
      baselineExcluded: matches, action: rule.action, requireVerifiedCertificate: matches, rejectRevoked: matches, authorizedFingerprint: p.authorizedCertificate.fingerprint };
    if (generation !== this.#mtlsRefresh) return this.#result('unknown', null, ['Superseded mTLS policy observation']);
    if (matches && runId !== undefined) this.#mtlsSnapshot = { readback: Object.freeze(ApiShieldReadbackSchema.parse(readback)), observedAt: this.#time(), runId };
    // Host/path/fingerprint fields are meaningful only when the exact expression matches.
    return this.#result(matches ? 'observed' : 'mismatch', { product: 'mtls', matches, priority, readback: matches ? readback : null,
      providerRevision: read.value.version, functionalDigest: digestValue({ rule, priority }) }, matches ? [] : ['mTLS rule differs from the declared exact expression/action'], 'granted');
  }
  async accessPolicy(input: AccessPolicy, serviceTokenId: string | null, signal?: AbortSignal): Promise<TrustedRead<TrustedPolicy>> {
    const p = AccessPolicySchema.parse(input); this.#targets(p.beforeOrigin, p.afterOrigin);
    if (serviceTokenId !== null) AccessId.parse(serviceTokenId);
    let reservation: RequestReservation | undefined;
    try {
      if (!this.#config.credentials.accessReaderTokenKind) return this.#result('unknown', null, ['Access reader token kind and visibility qualification unavailable']);
      const runId = this.#accessLegacyRun || (this.#accessLegacyRun = randomUUID());
      const reads = this.#accessVisibility.has(runId) ? 2 : 4;
      const reservedReads = [...this.#readReservations.values()].reduce((a, b) => a + b, 0);
      if (this.#reads + reservedReads + reads > this.#options.maxReads!) return this.#result('unknown', null, ['Access inventory reads do not fit']);
      reservation = this.#options.ledger.reserveRequests(reads); this.#readReservations.set(reservation, reads);
      if (!await this.#qualifyAccessVisibility(runId, reservation, signal)) return this.#result('unknown', null, ['Account-wide Access reader visibility is unqualified']);
      const apps = await this.#accessProvider(`/accounts/${this.#config.accountId}/access/apps?per_page=100&page=1`, z.array(AccessApplicationSchema).max(100), reservation, signal);
      const rules = apps && await this.#accessProvider(`/accounts/${this.#config.accountId}/access/apps/${p.applicationId}/policies?per_page=100&page=1`, z.array(AccessServiceRuleSchema).max(100), reservation, signal);
      if (!apps || !rules) return this.#result('unknown', null, ['Complete Access application and policy inventory unavailable']);
      const result = evaluateAccessReadback(p, serviceTokenId, apps, rules);
      if (!result.value) return this.#result(result.state, null, result.gaps, 'granted');
      return this.#result(result.state, result.value, result.gaps, 'granted');
    } catch (error) { return this.#result('unknown', null, [error instanceof AccessIncompleteInventory
      ? 'Missing provider pages; no partial state accepted' : 'Access inventory read failed or exceeded its bounds']); }
    finally { if (reservation) { this.#readReservations.delete(reservation); reservation.release(); } }
  }
  /** Reject cross-ledger/mode/config collectors at the Access-only bridge seam. */
  accessBridgeContext(config: LabConfig, ledger: BudgetLedger, mode: 'live' | 'fixture', runner: string): boolean {
    try { return ledger === this.#options.ledger && mode === this.#options.mode && runner === this.#options.credentials.runner
      && digestValue(LabConfigSchema.parse(config)) === digestValue(this.#config); } catch { return false; }
  }
  #currentAccessVisibility(runId: string): boolean {
    const proof = this.#accessVisibility.get(runId); const now = Date.parse(this.#time());
    return !!proof?.valid && now >= proof.readAt && now < proof.expiresAt;
  }
  /** Once per collector/run, with the same private reader/account/kind/mode. No
   * serialized flag, callback or failed/expired proof can authorize a list. */
  async #qualifyAccessVisibility(runId: string, reservation: RequestReservation, signal?: AbortSignal): Promise<boolean> {
    const old = this.#accessVisibility.get(runId);
    if (old) { await old.promise; return this.#currentAccessVisibility(runId); }
    const kind = this.#config.credentials.accessReaderTokenKind;
    if (!kind || this.#accessVisibility.size >= 16) return false;
    const epoch = this.#accessVisibilityEpoch;
    const proof = { valid: false, expiresAt: 0, readAt: Date.parse(this.#time()), promise: Promise.resolve(false) };
    proof.promise = (async () => {
      try {
        const prefix = kind === 'account' ? `/accounts/${this.#config.accountId}/tokens` : '/user/tokens';
        const times = { expires_on: Time.nullable().optional(), not_before: Time.nullable().optional() };
        const verify = await this.#accessProvider(`${prefix}/verify`, z.strictObject({ id: ProviderId, status: z.literal('active'), ...times }), reservation, signal);
        if (!verify) return false;
        const group = z.strictObject({ id: ProviderId, name: z.string().max(128).optional() });
        const policy = z.strictObject({ id: ProviderId.optional(), effect: z.enum(['allow', 'deny']), permission_groups: z.array(group).min(1).max(100), resources: z.record(z.string().max(256), z.unknown()) });
        const raw = z.object({ id: ProviderId, status: z.literal('active'), ...times, condition: z.record(z.string(), z.unknown()).optional(),
          policies: z.array(policy).min(1).max(100), name: z.string().max(256).optional(), issued_on: Time.optional(), modified_on: Time.optional(), last_used_on: Time.optional() }).strict();
        let captured: { id: string; qualified: boolean } | null = null; let expiresAt = Math.min(verify.expires_on ? Date.parse(verify.expires_on) : Infinity, proof.readAt + 120000);
        const safe = z.strictObject({ id: ProviderId, qualified: z.boolean() });
        const projection = z.unknown().transform((value, ctx) => {
          const detail = raw.safeParse(value);
          if (detail.success) {
            const d = detail.data; const now = Date.parse(this.#time());
            expiresAt = Math.min(expiresAt, d.expires_on ? Date.parse(d.expires_on) : Infinity);
            // User-issued tokens also inherit their user's permissions. Nominal
            // token policy alone cannot establish that effective principal scope.
            // Only the documented account-owned service-principal path qualifies.
            captured = { id: d.id, qualified: kind === 'account' && d.id === verify.id && (!d.condition || Object.keys(d.condition).length === 0)
              && (!verify.not_before || Date.parse(verify.not_before) <= now) && (!d.not_before || Date.parse(d.not_before) <= now) && expiresAt > now
              && d.policies.every(p => p.effect === 'allow') && d.policies.some(p => Object.hasOwn(p.resources, `com.cloudflare.api.account.${this.#config.accountId}`) && p.resources[`com.cloudflare.api.account.${this.#config.accountId}`] === '*'
                && p.permission_groups.some(g => g.name === 'Access: Apps and Policies Read')) };
            return captured;
          }
          const projected = safe.safeParse(value);
          if (captured && projected.success && digestValue(projected.data) === digestValue(captured)) return projected.data;
          ctx.addIssue({ code: 'custom', message: 'Access visibility detail unavailable' }); return z.NEVER;
        });
        const detail = await this.#accessProvider(`${prefix}/${verify.id}`, projection, reservation, signal);
        if (!detail?.qualified || detail.id !== verify.id || epoch !== this.#accessVisibilityEpoch) return false;
        proof.expiresAt = expiresAt; proof.valid = true; return this.#currentAccessVisibility(runId);
      } catch { return false; }
    })().then(qualified => {
      if (!qualified && epoch === this.#accessVisibilityEpoch) {
        this.#accessVisibilityEpoch++;
        for (const previous of this.#accessVisibility.values()) previous.valid = false;
      }
      return qualified;
    });
    this.#accessVisibility.set(runId, proof); await proof.promise; return this.#currentAccessVisibility(runId);
  }
  /** Separate Access-only read path consumes the reserved collector AND HTTP permits. */
  async #accessProvider<S extends z.ZodType>(path: string, schema: S, reservation: RequestReservation, signal?: AbortSignal): Promise<z.infer<S> | null> {
    this.#permit(signal, reservation);
    const response = await this.#client.requestJson({ kind: 'cloudflare', url: `${this.#config.apiOrigin}/client/v4${path}`,
      headers: { authorization: `Bearer ${this.#options.credentials.reader}` }, retries: 0 },
    accessEnvelope(schema), signal, reservation);
    if (response.status !== 200 || !response.data.success || response.data.result == null || response.data.unqualified) return null;
    const page = response.data.result_info; const rows = response.data.result;
    if (page && (page.unqualified || page.cursor != null || (page.page ?? 1) !== 1 || (page.total_pages ?? 1) !== 1)) throw new AccessIncompleteInventory();
    if (path.includes('?per_page=') && (!page || page.unqualified || page.page !== 1 || page.total_pages !== 1 || page.cursor != null
      || Array.isArray(rows) && (page.count !== undefined && page.count !== rows.length
        || page.total_count !== undefined && page.total_count !== rows.length || page.per_page !== undefined && rows.length > page.per_page))) throw new AccessIncompleteInventory();
    return response.data.result;
  }
  /** Three reads reserved before dispatch. No token UUID/Client-ID guessing, raw
   * identity excerpt, serialized snapshot adoption, extra retry or budget change. */
  async accessIdentitySnapshot(input: AccessPolicy, serviceTokenId: string, context: { runId: string; phase: 'before' | 'after' }, signal?: AbortSignal): Promise<TrustedRead<AccessSnapshot>> {
    const scope = z.strictObject({ runId: Id, phase: z.enum(['before', 'after']) }).parse(context);
    const key = `${scope.runId}:${scope.phase}`; const generation = (this.#accessRefresh.get(key) ?? 0) + 1;
    // Bound lifetime state; never evict a live entry into apparent current proof.
    if (!this.#accessRefresh.has(key) && this.#accessRefresh.size >= 16) return this.#result('unknown', null, ['Access snapshot scope cap reached']);
    this.#accessRefresh.set(key, generation); const startedAt = this.#time();
    let reservation: RequestReservation | undefined;
    try {
      const p = AccessPolicySchema.parse(input); AccessId.parse(serviceTokenId); this.#targets(p.beforeOrigin, p.afterOrigin);
      const configured = this.#config.demonstrations?.access;
      const ownedToken = this.#config.demonstrations?.serviceToken?.id ?? this.#config.optionalResources?.find(r => r.module === 'access')?.serviceTokenId;
      if (!configured || digestValue(configured) !== digestValue(p) || ownedToken !== serviceTokenId || !p.serviceTokenRef) return this.#result('unknown', null, ['Approved runtime Access policy/token scope missing']);
      if (!this.#config.credentials.accessReaderTokenKind) return this.#result('unknown', null, ['Access reader token kind and visibility qualification unavailable']);
      const reads = this.#accessVisibility.has(scope.runId) ? 3 : 5;
      const reservedReads = [...this.#readReservations.values()].reduce((a, b) => a + b, 0);
      if (this.#reads + reservedReads + reads > this.#options.maxReads!) return this.#result('unknown', null, ['Access snapshot reads do not fit']);
      reservation = this.#options.ledger.reserveRequests(reads); this.#readReservations.set(reservation, reads);
      if (!await this.#qualifyAccessVisibility(scope.runId, reservation, signal)) return this.#result('unknown', null, ['Account-wide Access reader visibility is unqualified']);
      const apps = await this.#accessProvider(`/accounts/${this.#config.accountId}/access/apps?per_page=100&page=1`, z.array(AccessApplicationSchema).max(100), reservation, signal);
      if (!apps) return this.#result('unknown', null, ['Access application inventory unavailable']);
      const rules = await this.#accessProvider(`/accounts/${this.#config.accountId}/access/apps/${p.applicationId}/policies?per_page=100&page=1`, z.array(AccessServiceRuleSchema).max(100), reservation, signal);
      if (!rules) return this.#result('unknown', null, ['Access policy inventory unavailable']);
      const evaluation = evaluateAccessReadback(p, serviceTokenId, apps, rules);
      if (!evaluation.value?.matches) return this.#result(evaluation.state, null, evaluation.gaps);
      let map: AccessTokenMap | null = null;
      const safeMap = z.strictObject({ id: AccessId, expires_at: Time, mapped: z.literal(true) });
      // requestJson validates twice around redaction. Its first projection captures
      // the private Client ID; only safeMap can ever reach excerpts or artifacts.
      const mapSchema = z.unknown().transform((value, ctx) => {
        const raw = AccessTokenMapSchema.safeParse(value);
        if (raw.success) {
          if (map !== null && digestValue(map) !== digestValue(raw.data)) { ctx.addIssue({ code: 'custom', message: 'Ambiguous token map' }); return z.NEVER; }
          map = raw.data; return { id: raw.data.id, expires_at: raw.data.expires_at, mapped: true as const };
        }
        const projected = safeMap.safeParse(value);
        if (map !== null && projected.success && projected.data.id === map.id && projected.data.expires_at === map.expires_at) return projected.data;
        ctx.addIssue({ code: 'custom', message: 'Token map unavailable' }); return z.NEVER;
      });
      const token = await this.#accessProvider(`/accounts/${this.#config.accountId}/access/service_tokens/${serviceTokenId}`, mapSchema, reservation, signal);
      const mapped = map as AccessTokenMap | null; const observedAt = this.#time();
      if (!token || !mapped || token.id !== serviceTokenId || mapped.id !== serviceTokenId || Date.parse(mapped.expires_at) <= Date.parse(observedAt)
        || Date.parse(observedAt) - Date.parse(startedAt) > 120000 || observedAt < startedAt || this.#accessRefresh.get(key) !== generation) return this.#result('unknown', null, ['Expired, foreign or superseded Access token mapping']);
      const snapshot = Object.freeze(AccessSnapshotSchema.parse({ schemaVersion: 1, kind: 'access-config-snapshot', source: 'guarded-access-app-policy-token-reads',
        ...scope, scenarioId: 'access', targetRole: 'after', mode: this.#options.mode, readId: randomUUID(), generation, startedAt, observedAt, accountId: this.#config.accountId,
        applicationId: p.applicationId, configuredPolicyId: p.policyId, audience: p.audience, hostname: new URL(p.afterOrigin).hostname,
        path: '/admin', functionalDigest: evaluation.value.functionalDigest, tokenMapped: true }));
      accessSnapshots.set(snapshot, { digest: digestValue(snapshot), clientId: mapped.client_id, tokenExpiresAt: mapped.expires_at,
        owner: this, current: () => this.#accessRefresh.get(key) === generation && this.#currentAccessVisibility(scope.runId) });
      return this.#result('observed', snapshot, [], 'granted');
    } catch { return this.#result('unknown', null, ['Access snapshot read failed or exceeded its reserved bounds']); }
    finally { if (reservation) { this.#readReservations.delete(reservation); reservation.release(); } }
  }
  #targets(before: string, after: string): void {
    if (before !== this.#config.environments[0].origin || after !== this.#config.environments[1].origin) throw new Error('Foreign policy targets');
  }
  async #accessAuthentication(scope: TrustedScope, rayId: string | null, signal?: AbortSignal): Promise<TrustedRead<TrustedPolicyAttribution>> {
    const policy = this.#config.demonstrations?.access;
    if (!rayId || scope.role !== 'after' || !policy || !policy.enabled || policy.capability !== 'available') return this.#result('unsupported', null, ['Access authentication correlation or configured scope unavailable']);
    this.#targets(policy.beforeOrigin, policy.afterOrigin);
    if (!/^[a-f0-9]{16}(?:-[a-z]{3})?$/i.test(rayId)) return this.#result('unknown', null, ['Invalid Access authentication correlation']);
    const ray = rayId.slice(0, 16).toLowerCase(); const domain = `${scope.hostname}/admin`;
    // These are the fields documented by the pinned Cloudflare SDK 5.2.0.
    // Strip personal/unmatched fields before GuardedClient creates an excerpt.
    // Nullable catch outputs are idempotent under Redactor's second validation.
    const Row = z.object({
      ray_id: z.string().regex(/^[a-f0-9]{16}(?:-[a-z]{3})?$/i).nullable().refine(value => value === null || value.slice(0, 16).toLowerCase() === ray).catch(null),
      app_uid: z.literal(policy.applicationId).nullable().catch(null),
      app_domain: z.enum([domain, `https://${domain}`]).nullable().catch(null),
      created_at: Time.nullable().refine(value => value === null || Date.parse(value) >= Date.parse(scope.start) && Date.parse(value) <= Date.parse(scope.end)).catch(null),
      allowed: z.boolean().nullable().catch(null), action: z.enum(['login', 'logout', 'unknown']).catch('unknown'),
    });
    try {
      this.#permit(signal);
      const query = new URLSearchParams({ since: scope.start, until: scope.end, direction: 'asc', limit: '100', page: '1', per_page: '100' });
      const response = await this.#client.requestJson({ kind: 'cloudflare', url: `${this.#config.apiOrigin}/client/v4/accounts/${this.#config.accountId}/access/logs/access_requests?${query}`,
        headers: { authorization: `Bearer ${this.#options.credentials.reader}` }, retries: 0 },
        accessEnvelope(z.array(Row).max(100)), signal);
      if ([401, 403].includes(response.status)) return this.#result('unknown', null, ['Access authentication log read denied'], 'denied');
      if (response.status !== 200 || !response.data.success || !response.data.result || response.data.unqualified) return this.#result('unknown', null, ['Access authentication log source unavailable']);
      const rows = response.data.result; const matches = rows.filter(row => row.ray_id !== null);
      if (matches.length > 1) return this.#result('mismatch', null, ['Ambiguous Access authentication Ray join'], 'granted');
      const row = matches[0];
      if (!row || row.app_uid === null || row.app_domain === null || row.created_at === null) return this.#result('unknown', null, ['No exact Access authentication app, Ray, domain and time join'], 'granted');
      const page = response.data.result_info; const complete = !!page && !page.unqualified && page.page === 1 && page.total_pages === 1 && page.cursor == null && rows.length < 100
        && (page.count === undefined || page.count === rows.length) && (page.total_count === undefined || page.total_count === rows.length);
      const event = AccessAuthenticationEvidenceSchema.parse({ kind: 'access-authentication', sourceApi: 'access-authentication-audit', join: 'ray-application-time',
        rayId: ray, applicationId: row.app_uid, hostname: scope.hostname, path: '/admin', eventTime: row.created_at,
        authenticationAction: row.action, allowed: row.allowed, complete, policyId: null, audience: null, identity: 'unknown' });
      return this.#result(complete ? 'unsupported' : 'unknown', { edge: null, policySignal: null, accessAuthentication: event }, [
        'Access authentication logs omit policy ID, audience and lab service-token identity; no enforcement signal inferred',
        ...(!complete ? ['Access authentication log pages are incomplete or reach the read cap'] : []),
      ], 'granted');
    } catch { return this.#result('unknown', null, ['Access authentication read failed or exceeded its bounds']); }
  }
  async policyAttribution(request: PolicyRequest, value: TrustedScope, rayId: string | null, signal?: AbortSignal): Promise<TrustedRead<TrustedPolicyAttribution>> {
    const scope = this.#scope(value);
    if (request.runId !== scope.runId || request.requestId !== scope.requestId || request.role !== scope.role || request.scenarioId !== scope.scenarioId || request.origin !== `https://${scope.hostname}` || request.path !== (scope.scenarioId === 'api-shield' ? '/api' : '/admin') || request.method !== 'GET' || request.followRedirects !== false) throw new Error('Foreign policy attribution join');
    if (!['api-shield', 'access'].includes(scope.scenarioId)) throw new Error('Unsupported policy scenario');
    if (scope.scenarioId === 'access') return this.#accessAuthentication(scope, rayId, signal);
    if (!rayId) return this.#result('unsupported', null, ['Product request attribution is unavailable; status codes and redirects are not proof']);
    const ray = /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.exec(rayId);
    if (!ray) return this.#result('unknown', null, ['Invalid event correlation']);
    try {
      this.#permit(signal);
      const reader = new CloudflareReader(this.#client, this.#options.credentials.reader);
      const edge = await reader.securityEvents({ zoneId: this.#config.zoneId, hostname: scope.hostname, rayId: rayId.slice(0, 16), start: scope.start, end: scope.end, limit: 100 }, signal);
      // An observed block by the exact read-back mTLS rule is not a TLS
      // handshake observation. Its certificate fields remain explicitly unknown.
      const snapshot = this.#mtlsSnapshot; const event = edge.events.length === 1 ? edge.events[0] : null;
      if (scope.role === 'after' && snapshot && snapshot.runId === scope.runId
        && snapshot.readback.hostname === scope.hostname && Date.parse(snapshot.observedAt) >= Date.parse(scope.start)
        && Date.parse(snapshot.observedAt) <= Date.parse(scope.end) && edge.complete && !edge.ambiguous
        && event?.source === 'firewallrules' && event.action === 'block' && event.ruleId === snapshot.readback.policyId) {
        const policySignal = PolicySignalSchema.parse({ product: 'mtls', policyId: event.ruleId, hostname: event.clientRequestHTTPHost,
          path: request.path, certificate: 'unknown', verified: null, revoked: null, fingerprint: null, action: event.action,
          source: 'cloudflare-mtls-rule-event', rayId: event.rayName, eventTime: event.datetime, observedConfigDigest: digestValue(snapshot.readback) });
        return this.#result('observed', { edge, policySignal }, ['Rule event does not attest individual TLS flags or a fingerprint'], 'granted');
      }
      return this.#result('unsupported', { edge, policySignal: null }, [!edge.complete || edge.ambiguous ? 'Incomplete or ambiguous edge observations' : 'No fresh exact mTLS rule observation joins this event'], 'granted');
    } catch (error) {
      return this.#result('unknown', null, ['Product event read unavailable'], error instanceof Error && 'state' in error && error.state === 'permission-denied' ? 'denied' : 'unknown');
    }
  }
}
export function createTrustedCollectors(options: TrustedCollectorsOptions): TrustedCollectors { return new TrustedCollectors(options); }

/** Compare independent authorized reads, not a desired-state object. No repair
 * hook exists. Fixture reads never become live readiness. */
export function compareTrustedReadbacks(before: readonly TrustedRead<TrustedBindings | TrustedPolicy>[], after: readonly TrustedRead<TrustedBindings | TrustedPolicy>[], window: { start: string; end: string }) {
  Time.parse(window.start); Time.parse(window.end);
  if (window.start > window.end || Date.parse(window.end) - Date.parse(window.start) > 120000) throw new Error('Invalid readback window');
  const key = (v: TrustedBindings | TrustedPolicy) => 'role' in v ? `worker:${v.role}:${v.workerName}` : `policy:${v.product}`;
  const valid = (reads: readonly TrustedRead<TrustedBindings | TrustedPolicy>[]) => reads.length > 0 && reads.every(r => r.state === 'observed' && r.permission === 'granted' && r.value !== null && r.observedAt >= window.start && r.observedAt <= window.end && (!('matches' in r.value) || r.value.matches)) && new Set(reads.map(r => r.value && key(r.value))).size === reads.length;
  const complete = valid(before) && valid(after) && before.length === after.length;
  const unchanged = complete && before.every(a => after.some(b => a.value && b.value && key(a.value) === key(b.value) && a.value.functionalDigest === b.value.functionalDigest && a.mode === b.mode && a.observedAt <= b.observedAt));
  return { unchanged, historical: !unchanged, liveReadbackStable: unchanged && [...before, ...after].every(r => r.mode === 'live'), deploymentVerified: false as const };
}
