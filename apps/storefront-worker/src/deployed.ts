import { Container, type OutboundHandlerContext } from '@cloudflare/containers';
export { ContainerProxy } from '@cloudflare/containers';
import { boundedText, checkpointFor, requestSignal, telemetryAck, telemetryOrigin } from './runtime-transport.js';
import { RuntimeScope, failureRecord, runtimeStep } from './runtime-failure.js';
import { ForwardActivity } from './runtime-forward-lifecycle.js';
import { z } from 'zod';
import { Id, Role, ScenarioId, TurnstileConfigSchema, ReceiptSchema, Time, RayId, Digest } from '../../../packages/contracts/src/schemas.js';
import { createStorefrontWorker } from './worker.js';
import { AccessJwtTrustSchema } from './access-service-identity.js';
import { ServiceResourcesSchema } from '../../../packages/contracts/src/service-read.js';
import { StorefrontData } from './d1.js';
import { OwnedAssets, contentDigest } from './assets.js';
import { ImageAssetSchema } from './assets.js';
import { ProducerIdentity, deriveIngestSecret, matchesSecret, type ProducerIdentity as Identity } from './registry.js';
interface Env {
  ROLE: 'before' | 'after'; ORIGIN: string; LAB_ID: string; RELEASE_DIGEST: string; VIEW_RUN_ID: string;
  IMAGE_ASSET_JSON: string; TELEMETRY_ORIGIN: string; SERVICE_RESOURCES_JSON?: string; TURNSTILE_CONFIG_JSON?: string; TURNSTILE_SECRET?: string;
  /** Server-only trust snapshot, including mapped Client ID. No request-derived URLs/fetch. */
  ACCESS_JWT_TRUST_JSON?: string;
  RUN_SECRET: string; INTERNAL_SECRET: string; INGEST_ROOT_SECRET: string; REGISTRY_SECRET: string; SETUP_SECRET: string;
  DB: D1Database; OBJECTS: R2Bucket; ORIGINS: DurableObjectNamespace<OriginContainer>;
}
const Scope = z.object({ targetRole: Role, scenarioId: ScenarioId, runId: Id });
const SafeSequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const Reservation = ProducerIdentity.extend({ schemaVersion: z.literal(1), requestId: Id, payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime(), entry: z.strictObject({ id: Id, sequence: SafeSequence.positive() }), completion: z.strictObject({ id: Id, sequence: SafeSequence.positive() }) }).strict().refine(v => v.completion.sequence === v.entry.sequence + 1);
const StageReceipt = z.strictObject({ receipt: ReceiptSchema, acceptedAt: Time, acked: z.boolean() });
const StageCall = z.strictObject({ mode: z.enum(['prepare', 'ack']), receipt: ReceiptSchema, encoded: z.string().min(1).max(2048), signature: Digest, authorization: z.string().max(512), ackProof: Digest.optional() });
const Allocation = z.strictObject({ reservation: Reservation, rayId: RayId.nullable(), complete: z.boolean(), settledAt: Time.optional(), entryReceipt: StageReceipt.optional(), completionReceipt: StageReceipt.optional() });
async function acceptanceStamp(receipt: z.infer<typeof ReceiptSchema>, acceptedAt: string, root: string) {
  const encoded = JSON.stringify({ schemaVersion: 1, receiptId: receipt.id, acceptedAt: Time.parse(acceptedAt), receiptDigest: await contentDigest(JSON.stringify(receipt)) });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`origin-stage-acceptance-v1\n${encoded}`)))].map(v => v.toString(16).padStart(2, '0')).join('');
  return { encoded, signature };
}
const KnownRequests = z.array(Id).max(100).refine(ids => new Set(ids).size === ids.length);
const SequenceState = z.strictObject({ schemaVersion: z.literal(1), identity: ProducerIdentity, highWater: SafeSequence, unresolved: SafeSequence, baselineHealthy: z.boolean(), healthy: z.boolean(), knownRequestIds: KnownRequests });
type SequenceState = z.infer<typeof SequenceState>;
const freshSequenceState = (identity: Identity): SequenceState => ({ schemaVersion: 1, identity, highWater: 0, unresolved: 0, baselineHealthy: true, healthy: true, knownRequestIds: [] });
export class OriginContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '2m';
  enableInternet = false;
  interceptHttps = true;
  #identity: Identity | undefined;
  readonly #activeRequests = new Set<string>();
  async #sequenceState(identity: Identity): Promise<SequenceState> {
    // Missing allocator on an existing producer is an upgrade, never proof of zero.
    const result = await this.env.DB.prepare('SELECT o.receipt_id,o.producer_id,o.sequence,o.environment,o.scenario_id,o.run_id,o.request_id,o.stage,o.observed_at,o.payload,a.accepted_at,a.payload_digest FROM origin_receipts o LEFT JOIN origin_receipt_acceptance a ON a.receipt_id=o.receipt_id WHERE o.producer_id=? ORDER BY o.sequence LIMIT 201').bind(identity.producerId).all();
    if (!result.success || !Array.isArray(result.results) || result.results.length === 0 || result.results.length > 200) throw new Error('Receipt history unavailable or exceeds bound');
    const Row = z.strictObject({ receipt_id: Id, producer_id: ProducerIdentity.shape.producerId, sequence: SafeSequence.positive(), environment: Role, scenario_id: ScenarioId, run_id: Id, request_id: Id, stage: ReceiptSchema.shape.stage, observed_at: Time, payload: z.string().max(4096), accepted_at: Time.nullable(), payload_digest: Digest.nullable() });
    let trustedTiming = true; const acceptedTimes = new Map<string, string>();
    const receipts = await Promise.all(result.results.map(async value => {
      const row = Row.parse(value); const receipt = ReceiptSchema.parse(JSON.parse(row.payload));
      if (receipt.id !== row.receipt_id || receipt.producerId !== row.producer_id || receipt.sequence !== row.sequence || receipt.targetRole !== row.environment || receipt.scenarioId !== row.scenario_id || receipt.runId !== row.run_id || receipt.requestId !== row.request_id || receipt.stage !== row.stage || receipt.observedAt !== row.observed_at) throw new Error('Receipt column and payload mismatch');
      if (receipt.producerId !== identity.producerId || receipt.targetRole !== identity.role || receipt.scenarioId !== identity.scenarioId || receipt.runId !== identity.runId || receipt.releaseDigest !== identity.releaseDigest || Date.parse(receipt.observedAt) > Date.now() + 5000) throw new Error('Foreign or unverified receipt history');
      if (row.accepted_at === null && row.payload_digest === null) trustedTiming = false;
      else {
        if (row.accepted_at === null || row.payload_digest !== await contentDigest(JSON.stringify(receipt)) || Date.parse(row.accepted_at) > Date.now() + 5000) throw new Error('Unverified receipt acceptance history');
        acceptedTimes.set(receipt.id, row.accepted_at);
      }
      return receipt;
    }));
    const ids = new Set<string>(); const sequences = new Set<number>(); const stages = new Map<string, z.infer<typeof ReceiptSchema>>();
    for (const receipt of receipts) {
      const key = `${receipt.requestId}:${receipt.stage}`;
      if (ids.has(receipt.id) || sequences.has(receipt.sequence) || stages.has(key)) throw new Error('Duplicate receipt history');
      ids.add(receipt.id); sequences.add(receipt.sequence); stages.set(key, receipt);
    }
    for (const receipt of receipts) if (receipt.stage === 'completion') {
      const entry = stages.get(`${receipt.requestId}:entry`);
      if (!entry || entry.sequence >= receipt.sequence || entry.rayId !== receipt.rayId || (acceptedTimes.has(entry.id) && acceptedTimes.has(receipt.id) && Date.parse(acceptedTimes.get(entry.id)!) > Date.parse(acceptedTimes.get(receipt.id)!))) throw new Error('Unverified receipt stage order');
    }
    const highReceipt = Math.max(...receipts.map(receipt => receipt.sequence));
    const checkpointRow = await this.env.DB.prepare('SELECT environment,scenario_id,run_id,last_attempted_sequence,healthy,watermark FROM producer_checkpoints WHERE producer_id=?').bind(identity.producerId).first();
    const checkpoint = checkpointRow === null ? null : z.strictObject({ environment: Role, scenario_id: ScenarioId, run_id: Id, last_attempted_sequence: SafeSequence, healthy: z.union([z.literal(0), z.literal(1)]), watermark: Time }).parse(checkpointRow);
    if (checkpoint && Date.parse(checkpoint.watermark) > Date.now() + 5000) throw new Error('Unverified checkpoint clock');
    if (checkpoint && (checkpoint.environment !== identity.role || checkpoint.scenario_id !== identity.scenarioId || checkpoint.run_id !== identity.runId)) throw new Error('Foreign sequence checkpoint');
    const registered = z.strictObject({ environment: Role, scenario_id: ScenarioId, run_id: Id, release_digest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await this.env.DB.prepare('SELECT environment,scenario_id,run_id,release_digest FROM producer_registry WHERE producer_id=?').bind(identity.producerId).first());
    if (registered.environment !== identity.role || registered.scenario_id !== identity.scenarioId || registered.run_id !== identity.runId || registered.release_digest !== identity.releaseDigest) throw new Error('Unverified sequence owner');
    const highWater = Math.max(highReceipt, checkpoint?.last_attempted_sequence ?? 0);
    const knownRequestIds = KnownRequests.parse([...new Set(receipts.map(receipt => receipt.requestId))]);
    // Legacy adoption needs the full distinct-request budget, not an inferred
    // count from a checkpoint with missing receipt spans or unpaired stages.
    if (!checkpoint || highWater === 0 || checkpoint.last_attempted_sequence !== highReceipt || receipts.length !== highReceipt || receipts.length !== knownRequestIds.length * 2 || knownRequestIds.some(id => !stages.has(`${id}:entry`) || !stages.has(`${id}:completion`))) throw new Error('Legacy request budget unverified');
    const healthy = checkpoint.healthy === 1 && trustedTiming;
    return { schemaVersion: 1, identity, highWater, unresolved: 0, baselineHealthy: healthy, healthy, knownRequestIds };
  }
  async #reserve(identity: Identity, requestId: string, raw: string) {
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(v => v.toString(16).padStart(2, '0')).join('');
    const reservation = await this.ctx.storage.transaction(async txn => {
      const stored = await txn.get<unknown>('receipt-sequences');
      const state = stored === undefined ? await this.#sequenceState(identity) : SequenceState.parse(stored);
      if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error('Foreign sequence allocator');
      const records = await txn.list<unknown>({ prefix: 'receipt-request:', limit: 101 });
      if (records.size > 100 || records.size > state.knownRequestIds.length) throw new Error('Reservation budget unverified');
      const now = Date.now();
      for (const [recordKey, storedRecord] of records) {
        const record = Allocation.parse(storedRecord);
        if (recordKey !== `receipt-request:${record.reservation.requestId}` || !state.knownRequestIds.includes(record.reservation.requestId) || record.reservation.producerId !== identity.producerId || record.reservation.role !== identity.role || record.reservation.scenarioId !== identity.scenarioId || record.reservation.runId !== identity.runId || record.reservation.releaseDigest !== identity.releaseDigest) throw new Error('Foreign reservation record');
        if (record.complete && record.settledAt !== undefined && now >= Date.parse(record.settledAt) + 15 * 60 * 1000) { await txn.delete(recordKey); records.delete(recordKey); }
      }
      // knownRequestIds is a bounded exact tombstone set as well as the spent
      // budget. Pruning never removes an ID, changes high-water, or heals gaps.
      const key = `receipt-request:${requestId}`; const previous = records.get(key);
      if (previous !== undefined) {
        const allocation = Allocation.parse(previous);
        if (allocation.complete && allocation.settledAt === undefined) return { denied: true };
        const existing = allocation.reservation;
        if (existing.requestId !== requestId || existing.payloadDigest !== digest || existing.producerId !== identity.producerId || existing.role !== identity.role || existing.scenarioId !== identity.scenarioId || existing.runId !== identity.runId || existing.releaseDigest !== identity.releaseDigest || existing.completion.sequence > state.highWater) return { denied: true };
        return { reservation: existing };
      }
      if (state.knownRequestIds.includes(requestId) || state.knownRequestIds.length >= 100 || records.size >= 100) return { denied: true };
      if (state.highWater > Number.MAX_SAFE_INTEGER - 2 || state.unresolved === Number.MAX_SAFE_INTEGER) throw new Error('Receipt allocation exhausted');
      const value = Reservation.parse({ ...identity, schemaVersion: 1, requestId, payloadDigest: digest, observedAt: new Date().toISOString(), entry: { id: crypto.randomUUID(), sequence: state.highWater + 1 }, completion: { id: crypto.randomUUID(), sequence: state.highWater + 2 } });
      await txn.put('receipt-sequences', { ...state, highWater: value.completion.sequence, unresolved: state.unresolved + 1, healthy: false, knownRequestIds: [...state.knownRequestIds, requestId] });
      await txn.put(key, { reservation: value, rayId: RayId.nullable().parse(JSON.parse(raw).rayId ?? null), complete: false });
      return { reservation: value };
    });
    if ('denied' in reservation) throw new Error('Receipt retry expired or budget exhausted');
    const encoded = JSON.stringify(reservation.reservation);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.INTERNAL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`origin-receipt-reservation-v1\n${encoded}`)))].map(v => v.toString(16).padStart(2, '0')).join('');
    return { encoded, signature };
  }
  async #complete(requestId: string): Promise<void> {
    await this.ctx.storage.transaction(async txn => {
      const allocation = Allocation.parse(await txn.get(`receipt-request:${requestId}`));
      if (allocation.complete) return;
      if (!allocation.entryReceipt?.acked || !allocation.completionReceipt?.acked) throw new Error('Receipt stage acknowledgments unavailable');
      const state = SequenceState.parse(await txn.get('receipt-sequences'));
      if (state.unresolved < 1) throw new Error('Receipt allocation state mismatch');
      const unresolved = state.unresolved - 1;
      await txn.put('receipt-sequences', { ...state, unresolved, healthy: state.baselineHealthy && unresolved === 0 });
      await txn.put(`receipt-request:${requestId}`, { ...allocation, complete: true, settledAt: new Date().toISOString() });
    });
  }
  // Capability-only RPC from this Container's SDK proxy. No HTTP route exposes it.
  async receiptStage(value: unknown): Promise<z.infer<typeof StageReceipt> | null> {
    try {
      const input = StageCall.parse(value);
      const identity = ProducerIdentity.parse(await this.ctx.storage.get('producer'));
      if (identity.role !== this.env.ROLE || identity.releaseDigest !== this.env.RELEASE_DIGEST || !(await matchesSecret(input.authorization, `Bearer ${await deriveIngestSecret(identity, this.env.INGEST_ROOT_SECRET)}`))) return null;
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.INTERNAL_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const signature = new Uint8Array(input.signature.match(/../g)!.map(part => parseInt(part, 16)));
      if (!(await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(`origin-receipt-reservation-v1\n${input.encoded}`)))) return null;
      return await this.ctx.storage.transaction(async txn => {
        const recordKey = `receipt-request:${input.receipt.requestId}`;
        const stored = await txn.get<unknown>(recordKey); if (stored === undefined) return null;
        const allocation = Allocation.parse(stored); const reservation = allocation.reservation;
        if (input.encoded !== JSON.stringify(reservation) || reservation.producerId !== identity.producerId || reservation.role !== identity.role || reservation.scenarioId !== identity.scenarioId || reservation.runId !== identity.runId || reservation.releaseDigest !== identity.releaseDigest) return null;
        if (allocation.complete && (allocation.settledAt === undefined || Date.now() >= Date.parse(allocation.settledAt) + 15 * 60 * 1000)) { if (allocation.settledAt !== undefined) await txn.delete(recordKey); return null; }
        const stage = input.receipt.stage; const field = stage === 'entry' ? 'entryReceipt' : 'completionReceipt';
        const expected = ReceiptSchema.parse({ schemaVersion: 1, id: reservation[stage].id, runId: identity.runId, requestId: reservation.requestId, scenarioId: identity.scenarioId, targetRole: identity.role, producerId: identity.producerId, sequence: reservation[stage].sequence, observedAt: reservation.observedAt, rayId: allocation.rayId, releaseDigest: identity.releaseDigest, stage });
        if (JSON.stringify(input.receipt) !== JSON.stringify(expected) || Date.parse(input.receipt.observedAt) > Date.now() + 5000) return null;
        if (stage === 'completion' && !allocation.entryReceipt?.acked) return null;
        const current = allocation[field];
        if (current && JSON.stringify(current.receipt) !== JSON.stringify(expected)) return null;
        if (input.mode === 'ack') {
          if (!current) return null;
          const stamp = await acceptanceStamp(current.receipt, current.acceptedAt, this.env.INGEST_ROOT_SECRET);
          if (!(await matchesSecret(input.ackProof ?? '', stamp.signature))) return null;
          const acknowledged = { ...current, acked: true };
          await txn.put(recordKey, { ...allocation, [field]: acknowledged }); return acknowledged;
        }
        if (current) return current;
        // Only this server clock defines trusted stage arrival. Preserve the
        // container's observedAt as reported data, never as the coverage clock.
        const prepared = StageReceipt.parse({ receipt: expected, acceptedAt: new Date().toISOString(), acked: false });
        await txn.put(recordKey, { ...allocation, [field]: prepared }); return prepared;
      });
    } catch { return null; }
  }
  readonly #forwardActivity = new ForwardActivity(() => this.renewActivityTimeout());
  // Documented SDK hook: the real alarm must not stop pending native headers
  // or a response body still owned by a caller. No SDK private counters change.
  override async onActivityExpired(): Promise<void> {
    if (this.#forwardActivity.active) { this.renewActivityTimeout(); return; }
    await super.onActivityExpired();
  }
  // SDK's default onError logs raw provider errors. Never copy those into logs.
  override onError(): never { throw new Error('Container runtime failed'); }
  override async fetch(request: Request): Promise<Response> {
    if (!(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${this.env.INTERNAL_SECRET}`))) return new Response('Unauthorized service', { status: 401 });
    const url = new URL(request.url);
    if (!((request.method === 'POST' && url.pathname === '/internal/render') || (request.method === 'GET' && url.pathname === '/internal/checkpoint'))) return new Response(null, { status: 404 });
    let diagnosticScope: RuntimeScope | undefined;
    let activeRequest: string | undefined;
    try {
      const raw = request.method === 'POST' ? await boundedText(request.clone(), 8192) : '';
      const payload = request.method === 'POST' ? JSON.parse(raw) : { targetRole: this.env.ROLE, scenarioId: url.searchParams.get('scenarioId'), runId: url.searchParams.get('runId') };
      const scope = Scope.parse(payload);
      if (scope.targetRole !== this.env.ROLE) return new Response('Foreign environment', { status: 403 });
      if (request.method === 'POST') {
        diagnosticScope = RuntimeScope.parse({ ...scope, requestId: Id.parse(payload.requestId), releaseDigest: this.env.RELEASE_DIGEST });
        if (this.#activeRequests.has(diagnosticScope.requestId)) return new Response('Request already active', { status: 503 });
        activeRequest = diagnosticScope.requestId; this.#activeRequests.add(activeRequest);
      }
      const origin = telemetryOrigin(this.env.TELEMETRY_ORIGIN);
      const producer = await this.ctx.blockConcurrencyWhile(async () => {
        // Catch inside the gate: an escaping rejection resets the native DO and
        // discards request-local stage information before this fetch can reply.
        try {
        let owner = await runtimeStep('producer-storage', async () => {
          const stored = this.#identity ?? await this.ctx.storage.get<Identity>('producer');
          if (!stored) return undefined;
          const valid = ProducerIdentity.parse(stored);
          if (valid.role !== scope.targetRole || valid.scenarioId !== scope.scenarioId || valid.runId !== scope.runId || valid.releaseDigest !== this.env.RELEASE_DIGEST) throw new Error('Foreign Container instance');
          return valid;
        });
        if (!owner) {
          owner = ProducerIdentity.parse({ producerId: `p-${crypto.randomUUID()}`, role: scope.targetRole, scenarioId: scope.scenarioId, runId: scope.runId, releaseDigest: this.env.RELEASE_DIGEST });
          // Persist identity before registration: a lost remote ACK must not
          // orphan it or mint a different producer on the next attempt.
          await runtimeStep('producer-storage', () => this.ctx.storage.put({ producer: owner!, 'receipt-sequences': freshSequenceState(owner!), 'producer-registered': false }));
        }
        const registered = await runtimeStep('producer-storage', () => this.ctx.storage.get<unknown>('producer-registered'));
        if (registered !== undefined && typeof registered !== 'boolean') throw new Error('Unverified producer registration state');
        if (registered !== true) {
          await runtimeStep('registry', () => telemetryAck(origin.origin, '/registry', this.env.REGISTRY_SECRET, owner, request.signal));
          await runtimeStep('producer-storage', () => this.ctx.storage.put('producer-registered', true));
        }
        this.#identity = owner; return { identity: owner };
        } catch (failure) { return { failure }; }
      });
      if ('failure' in producer) throw producer.failure;
      const identity = producer.identity;
      const ingestSecret = await runtimeStep('derive', () => deriveIngestSecret(identity, this.env.INGEST_ROOT_SECRET));
      await runtimeStep('egress', async () => {
        // Supported SDK setters activate and persist interception before native start.
        await this.setAllowedHosts([origin.hostname]);
        await this.setOutboundHandler('receipts', identity);
      });
      await runtimeStep('start-ports', () => this.startAndWaitForPorts({ ports: [8080], cancellationOptions: { abort: request.signal, instanceGetTimeoutMS: 8000, portReadyTimeoutMS: 15000 }, startOptions: { enableInternet: false, envVars: {
        PORT: '8080', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt', APP_ROLE: identity.role, APP_SCENARIO: identity.scenarioId, APP_RUN_ID: identity.runId,
        APP_PRODUCER: identity.producerId, APP_RELEASE: identity.releaseDigest, APP_INTERNAL_SECRET: this.env.INTERNAL_SECRET,
        RECEIPT_URL: `${origin.origin}/ingest`, RECEIPT_INGEST_SECRET: ingestSecret,
      } } }));
      // Keep native transport's sanitized errors and explicitly lease activity
      // through pending headers and the caller-owned response stream lifetime.
      // SDK readiness/interception and its documented expiry hook remain active.
      const forwarded = new Request(url.origin + url.pathname, request);
      // Always overwrite caller headers with a durable, scope/body-bound allocation.
      if (diagnosticScope) {
        const reservation = await runtimeStep('producer-storage', () => this.#reserve(identity, diagnosticScope!.requestId, raw));
        forwarded.headers.set('x-origin-receipt-reservation', reservation.encoded);
        forwarded.headers.set('x-origin-receipt-signature', reservation.signature);
      }
      const response = await runtimeStep('forward', () => this.#forwardActivity.forward(forwarded, value => this.ctx.container!.getTcpPort(8080).fetch(value)));
      if (diagnosticScope && response.status === 200) {
        try { await runtimeStep('producer-storage', () => this.#complete(diagnosticScope!.requestId)); }
        catch (error) { await response.body?.cancel(); throw error; }
      }
      if (url.pathname === '/internal/checkpoint' && response.ok) {
        try {
          const checkpoint = await runtimeStep('parse', async () => checkpointFor(JSON.parse(await boundedText(response, 4096)), identity));
          const state = await runtimeStep('producer-storage', async () => SequenceState.parse(await this.ctx.storage.get('receipt-sequences')));
          checkpoint.healthy = checkpoint.healthy && state.healthy && state.unresolved === 0 && checkpoint.lastAttemptedSequence === state.highWater;
          await runtimeStep('registry', () => telemetryAck(origin.origin, '/producer-status', ingestSecret, checkpoint, request.signal));
          return Response.json(checkpoint, { headers: { 'cache-control': 'no-store' } });
        } finally { await response.body?.cancel(); }
      }
      // Never pass arbitrary provider bodies/headers back on a failed native forward.
      if (!response.ok) { await response.body?.cancel(); return new Response('Container unavailable', { status: 503 }); }
      return response;
    } catch (error) {
      if (diagnosticScope) return Response.json(failureRecord(diagnosticScope, error), { status: 503, headers: { 'cache-control': 'no-store' } });
      return new Response('Container unavailable', { status: 503 });
    } finally { if (activeRequest) this.#activeRequests.delete(activeRequest); }
  }
}
// Invoke SDK inherited setters, not shadowing static class fields. Deny by default
// until server-derived producer params are installed through setOutboundHandler.
OriginContainer.outbound = () => new Response(null, { status: 403 });
OriginContainer.outboundHandlers = { receipts: (request, env, ctx) => relayAcceptedReceipt(request, env as Env, ctx) };
async function relayAcceptedReceipt(request: Request, env: Env, ctx: OutboundHandlerContext): Promise<Response> {
  try {
    const origin = telemetryOrigin(env.TELEMETRY_ORIGIN); const url = new URL(request.url);
    if (request.method !== 'POST' || url.href !== `${origin.origin}/ingest` || url.username || url.password || url.port || url.search || url.hash) return new Response(null, { status: 403 });
    const identity = ProducerIdentity.parse(ctx.params);
    if (identity.role !== env.ROLE || identity.releaseDigest !== env.RELEASE_DIGEST) return new Response(null, { status: 403 });
    const authorization = request.headers.get('authorization') ?? '';
    if (!(await matchesSecret(authorization, `Bearer ${await deriveIngestSecret(identity, env.INGEST_ROOT_SECRET)}`))) return new Response(null, { status: 401 });
    const receipt = ReceiptSchema.parse(JSON.parse(await boundedText(request, 4096)));
    const input = StageCall.parse({ mode: 'prepare', receipt, encoded: request.headers.get('x-origin-receipt-reservation'), signature: request.headers.get('x-origin-receipt-signature'), authorization });
    const owner = env.ORIGINS.get(env.ORIGINS.idFromString(ctx.containerId));
    const preparedRaw = await owner.receiptStage(input); if (!preparedRaw) return new Response(null, { status: 503 });
    const prepared = StageReceipt.parse(preparedRaw);
    const stamp = await acceptanceStamp(prepared.receipt, prepared.acceptedAt, env.INGEST_ROOT_SECRET);
    const response = await fetch(`${origin.origin}/ingest`, { method: 'POST', redirect: 'manual', headers: { authorization, 'content-type': 'application/json', 'x-origin-receipt-acceptance': stamp.encoded, 'x-origin-receipt-acceptance-signature': stamp.signature }, body: JSON.stringify(prepared.receipt), signal: requestSignal(request.signal) });
    await response.body?.cancel();
    if (response.status !== 204 || response.redirected || response.headers.get('x-receipt-id') !== prepared.receipt.id) return new Response(null, { status: 503 });
    const acknowledged = await owner.receiptStage({ ...input, mode: 'ack', ackProof: stamp.signature });
    if (!acknowledged?.acked) return new Response(null, { status: 503 });
    return new Response(null, { status: 204, headers: { 'x-receipt-id': prepared.receipt.id } });
  } catch { return new Response(null, { status: 503 }); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.origin !== env.ORIGIN) return new Response('Wrong deployment hostname', { status: 421 });
      if (url.pathname === '/internal/seed') {
        if (request.method !== 'POST' || !(await matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${env.SETUP_SECRET}`))) return new Response('Setup authorization required', { status: 401 });
        await new StorefrontData(env.DB, env.ROLE).seed();
        const digest = await new OwnedAssets(env.OBJECTS, env.ROLE).seedDetail('launch-shirt', 'Synthetic launch shirt. Demo data only.');
        return Response.json({ seeded: true, role: env.ROLE, detailDigest: digest });
      }
      if (url.pathname === '/internal/checkpoint') {
        if (request.method !== 'GET' || !(await matchesSecret(request.headers.get('x-demo-run-token') ?? '', env.RUN_SECRET))) return new Response('Unauthorized lab run', { status: 401 });
        const scenarioId = ScenarioId.parse(url.searchParams.get('scenarioId')); const runId = Id.parse(url.searchParams.get('runId'));
        return env.ORIGINS.getByName(`${env.ROLE}:${scenarioId}:${runId}`).fetch(new Request(`http://container.internal/internal/checkpoint?${new URLSearchParams({ scenarioId, runId })}`, { headers: { authorization: `Bearer ${env.INTERNAL_SECRET}` } }));
      }
      const accessTrust = env.ROLE === 'after' && url.pathname === '/admin' && request.headers.get('x-demo-scenario') === 'access'
        && request.headers.get('x-demo-test')?.startsWith('access-v1:') && env.ACCESS_JWT_TRUST_JSON
        ? AccessJwtTrustSchema.parse(JSON.parse(z.string().max(20000).parse(env.ACCESS_JWT_TRUST_JSON))) : null;
      return await createStorefrontWorker({ ...(accessTrust ? { accessIdentity: { mode: 'live' as const, trust: accessTrust } } : {}), role: env.ROLE, origin: env.ORIGIN, labId: env.LAB_ID, releaseDigest: env.RELEASE_DIGEST, viewRunId: env.VIEW_RUN_ID, runSecret: env.RUN_SECRET, internalSecret: env.INTERNAL_SECRET, db: env.DB, bucket: env.OBJECTS, image: ImageAssetSchema.parse(JSON.parse(env.IMAGE_ASSET_JSON)), ...(env.SERVICE_RESOURCES_JSON ? { serviceResources: ServiceResourcesSchema.parse(JSON.parse(env.SERVICE_RESOURCES_JSON)) } : {}), ...(env.TURNSTILE_CONFIG_JSON ? { turnstile: { config: TurnstileConfigSchema.parse(JSON.parse(env.TURNSTILE_CONFIG_JSON)), ...(env.TURNSTILE_SECRET ? { secret: env.TURNSTILE_SECRET } : {}) } } : {}), containers: env.ORIGINS }).fetch(request);
    } catch { return new Response('Lab request unavailable', { status: 503 }); }
  },
};
