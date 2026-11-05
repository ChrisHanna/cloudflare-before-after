import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionSchema, AccessServiceIdentitySchema, AccessApplicationRejectionSchema, type AccessAdmission, type AccessApplicationRejection, type AccessEnforcement, type AccessSnapshot } from '../../contracts/src/access-service-identity.js';
import { Id, Time } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { GuardedClient, type Dispatch, type SafeResponse } from './transport.js';
import { BudgetLedger } from './budget.js';
import { LabConfigSchema, type LabConfig } from './config.js';
import { TrustedCollectors, observedAccessSnapshot, type TrustedOrigin } from './trusted-collectors.js';
import { AccessPolicySchema, type AccessPolicy } from './access-policy.js';
import type { PolicyRequest } from './api-shield-proof.js';
import { digestValue } from './canonical.js';

export interface CurrentAccessExchange { response: SafeResponse; origin: TrustedOrigin; before: AccessSnapshot; after: AccessSnapshot; start: string; end: string }
const exchanges = new WeakMap<object, { value: CurrentAccessExchange; digest: string }>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sealExchange(proof: object, value: CurrentAccessExchange): void { freeze(value); exchanges.set(proof, { value, digest: digestValue(value) }); }
const admissions = new WeakMap<object, { digest: string; current: () => boolean; consumed: boolean }>();
/** Read actual exchange metadata only; this does not mint or adopt evidence. */
export function observedAccessExchange(value: AccessEnforcement): CurrentAccessExchange | null {
  try { const record = exchanges.get(value); return record && record.digest === digestValue(record.value) ? record.value : null; } catch { return null; }
}
export function bindAccessApplicationRejection(value: AccessApplicationRejection): AccessApplicationRejection | null {
  try { const proof = admissions.get(value);
    if (!proof || proof.consumed || !proof.current() || !observedAccessExchange(value) || proof.digest !== digestValue(value) || !AccessApplicationRejectionSchema.safeParse(value).success) return null;
    proof.consumed = true; return value;
  } catch { return null; }
}
/** One-shot adoption of the actual current exchange. A clone/body/hash is not proof. */
export function bindAccessServiceAdmission(value: AccessAdmission): AccessAdmission | null {
  try {
    const proof = admissions.get(value);
    if (!proof || proof.consumed || !proof.current() || !observedAccessExchange(value) || proof.digest !== digestValue(value) || !AccessAdmissionSchema.safeParse(value).success) return null;
    proof.consumed = true; return value;
  } catch { return null; }
}
export interface AccessIdentityCollectorOptions {
  config: LabConfig; ledger: BudgetLedger; collectors: TrustedCollectors; mode: 'live' | 'fixture';
  observedOwnedResources: ReadonlySet<string>; runnerCredential: string;
  /** Explicit guarded HTTP boundary, never global fetch or a proof callback. */
  dispatch?: Dispatch; now?: () => number;
}
/** Production bridge path: one real guarded admin response, three post-snapshot
 * reads and two authenticated origin reads. The pre-snapshot costs three more.
 * It returns service admission only. It never mints a denied-policy signal. */
export class AccessServiceIdentityCollector {
  readonly #options: AccessIdentityCollectorOptions; readonly #config: LabConfig;
  readonly #requests = new Set<string>();
  readonly #attempts = new Map<string, { response: SafeResponse; origin: TrustedOrigin | null; start: string; end: string }>();
  attempt(request: PolicyRequest) { return this.#attempts.get(`${request.runId}:${request.requestId}`) ?? null; }
  constructor(options: AccessIdentityCollectorOptions) {
    if (!(options.collectors instanceof TrustedCollectors) || !(options.ledger instanceof BudgetLedger)) throw new Error('Current guarded collectors required');
    z.enum(['live', 'fixture']).parse(options.mode); z.string().min(24).max(256).parse(options.runnerCredential);
    this.#config = LabConfigSchema.parse(options.config);
    if (!options.collectors.accessBridgeContext(this.#config, options.ledger, options.mode, options.runnerCredential)) throw new Error('Access bridge context differs from collectors');
    this.#options = { ...options, config: this.#config };
  }
  async collect(request: PolicyRequest, before: AccessSnapshot, policy: AccessPolicy, tokenId: string,
    credentials: { clientId: string; clientSecret: string }, signal?: AbortSignal): Promise<AccessAdmission | null> {
    try {
      policy = AccessPolicySchema.parse(policy); request = { ...request }; credentials = { ...credentials };
      const now = this.#options.now ?? Date.now; const start = new Date(now()).toISOString(); Time.parse(start);
      Id.parse(request.runId); Id.parse(request.requestId);
      const mapping = observedAccessSnapshot(before, this.#options.collectors, now());
      const configured = this.#config.demonstrations?.access;
      if (!configured || digestValue(configured) !== digestValue(policy) || !mapping || mapping.clientId !== credentials.clientId
        || !z.string().regex(/^[A-Za-z0-9._-]{8,256}$/).safeParse(credentials.clientId).success
        || !z.string().min(16).max(256).regex(/^[A-Za-z0-9._-]+$/).safeParse(credentials.clientSecret).success
        || before.phase !== 'before' || before.mode !== this.#options.mode || before.runId !== request.runId
        || before.applicationId !== policy.applicationId || before.configuredPolicyId !== policy.policyId
        || before.audience !== policy.audience || before.accountId !== this.#config.accountId
        || before.hostname !== new URL(this.#config.environments[1].origin).hostname
        || request.role !== 'after' || request.scenarioId !== 'access' || request.method !== 'GET' || request.path !== '/admin'
        || request.origin !== this.#config.environments[1].origin || request.case !== 'authorized'
        || request.credentialRef !== policy.serviceTokenRef || request.followRedirects !== false) return null;
      const requestKey = `${request.runId}:${request.requestId}`;
      if (this.#requests.has(requestKey) || this.#requests.size >= 100) return null;
      this.#requests.add(requestKey); // Burn even on failure. No hidden retries.
      const nonce = randomUUID();
      const client = new GuardedClient(this.#config, this.#options.ledger, { observedOwnedResources: this.#options.observedOwnedResources,
        redactor: new Redactor([credentials.clientId, credentials.clientSecret, this.#options.runnerCredential]),
        dispatch: async (url, init) => {
          if (!this.#options.dispatch) throw new Error('Explicit Access bridge transport required');
          const response = await this.#options.dispatch(url, init);
          if (response.status === 200 && !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) { await response.body?.cancel(); throw new Error('Access bridge must not be cached'); }
          return response;
        } });
      const response = await client.request({ kind: 'after', url: `${request.origin}/admin`, method: 'GET', retries: 0,
        followRedirects: false, observeRedirect: true, headers: { accept: 'application/json', 'x-demo-run-token': this.#options.runnerCredential,
          'x-demo-run-id': request.runId, 'x-demo-request-id': request.requestId, 'x-demo-scenario': 'access',
          'x-demo-test': `access-v1:${this.#options.mode}:${nonce}`, 'cf-access-client-id': credentials.clientId,
          'cf-access-client-secret': credentials.clientSecret } }, signal);
      const end = new Date(now()).toISOString();
      let facts: z.infer<typeof AccessServiceIdentitySchema> | null = null;
      try { facts = AccessServiceIdentitySchema.parse(JSON.parse(response.excerpt)); } catch { /* No raw body retention. */ }
      response.excerpt = facts ? JSON.stringify(facts) : 'Access service observation unavailable';
      freeze(response); this.#attempts.set(requestKey, Object.freeze({ response, origin: null, start, end }));
      if (!facts) return null;
      if (end < start || Date.parse(end) - Date.parse(start) > 120000 || response.status !== 200 || response.metadata.role !== 'after'
        || response.metadata.releaseDigest !== this.#config.environments[1].releaseDigest || response.metadata.contentType !== 'application/json'
        || response.metadata.bodyBytes > 4096 || facts.runId !== request.runId || facts.requestId !== request.requestId || facts.nonce !== nonce
        || facts.mode !== this.#options.mode || facts.releaseDigest !== this.#config.environments[1].releaseDigest
        || facts.hostname !== before.hostname || facts.audience !== before.audience
        || (this.#config.demonstrations?.accessIdentity && facts.issuer !== this.#config.demonstrations.accessIdentity.issuer)
        || facts.observedAt < start || facts.observedAt > end
        || !observedAccessSnapshot(before, this.#options.collectors, now())) return null;
      const afterRead = await this.#options.collectors.accessIdentitySnapshot(policy, tokenId, { runId: request.runId, phase: 'after' }, signal);
      const after = afterRead.value; const afterMap = after && observedAccessSnapshot(after, this.#options.collectors, now());
      if (afterRead.state !== 'observed' || !after || !afterMap || afterMap.clientId !== mapping.clientId
        || afterMap.tokenExpiresAt !== mapping.tokenExpiresAt || after.mode !== before.mode || after.runId !== before.runId
        || after.startedAt < end || after.functionalDigest !== before.functionalDigest || after.readId === before.readId) return null;
      const origin = await this.#options.collectors.origin({ role: 'after', scenarioId: 'access', runId: request.runId, requestId: request.requestId,
        hostname: facts.hostname, releaseDigest: facts.releaseDigest, start, end }, signal);
      this.#attempts.set(requestKey, Object.freeze({ response, origin: freeze(origin.value), start, end }));
      if (origin.state !== 'observed' || origin.mode !== before.mode || !origin.value?.requestCompleted || !origin.value.requestEntered) return null;
      const entries = origin.value.receipts.filter(r => r.stage === 'entry');
      if (entries.length !== 1) return null;
      const entry = entries[0]!;
      if (entry.runId !== request.runId || entry.requestId !== request.requestId || entry.scenarioId !== 'access' || entry.targetRole !== 'after'
        || entry.releaseDigest !== facts.releaseDigest || entry.observedAt < start || entry.observedAt > end
        || (entry.rayId && response.rayId && entry.rayId.split('-')[0]!.toLowerCase() !== response.rayId.split('-')[0]!.toLowerCase())) return null;
      if (!observedAccessSnapshot(before, this.#options.collectors, now()) || !observedAccessSnapshot(after, this.#options.collectors, now())) return null;
      const result = AccessAdmissionSchema.parse({ schemaVersion: 1, kind: 'access-service-admission', channel: 'authenticated-same-request-https', facts,
        beforeReadId: before.readId, afterReadId: after.readId, configurationDigest: before.functionalDigest,
        configuredPolicyId: before.configuredPolicyId, approvingPolicyId: null, receiptId: entry.id, completedAt: new Date(now()).toISOString(), fullRuntimeState: null });
      // Freeze every nested member. Private provenance also detects any mutation.
      Object.freeze(result.facts); Object.freeze(result);
      admissions.set(result, { digest: digestValue(result), consumed: false,
        current: () => !!observedAccessSnapshot(before, this.#options.collectors, now()) && !!observedAccessSnapshot(after, this.#options.collectors, now()) });
      sealExchange(result, { response, origin: origin.value, before, after, start, end });
      return result;
    } catch { return null; }
  }
  /** Supplementary application login-failure observation only. REST does not
   * qualify missing/invalid non-identity credential-case coverage. Even with an
   * exact Ray/app/time/config/healthy-origin join, this cannot complete T29. */
  async collectMissing(request: PolicyRequest, before: AccessSnapshot, policy: AccessPolicy, tokenId: string, signal?: AbortSignal): Promise<AccessApplicationRejection | null> {
    try {
      policy = AccessPolicySchema.parse(policy); request = { ...request };
      const now = this.#options.now ?? Date.now; const start = new Date(now()).toISOString();
      const map = observedAccessSnapshot(before, this.#options.collectors, now());
      if (!map || before.phase !== 'before' || before.mode !== this.#options.mode || before.runId !== request.runId
        || before.accountId !== this.#config.accountId || before.applicationId !== policy.applicationId || before.configuredPolicyId !== policy.policyId
        || before.audience !== policy.audience || before.hostname !== new URL(this.#config.environments[1].origin).hostname
        || digestValue(policy) !== digestValue(this.#config.demonstrations?.access) || request.role !== 'after' || request.scenarioId !== 'access'
        || request.origin !== this.#config.environments[1].origin || request.path !== '/admin' || request.method !== 'GET'
        || request.case !== 'missing' || request.credentialRef !== null || request.followRedirects !== false) return null;
      Id.parse(request.runId); Id.parse(request.requestId);
      const key = `${request.runId}:${request.requestId}`; if (this.#requests.has(key) || this.#requests.size >= 100) return null; this.#requests.add(key);
      const client = new GuardedClient(this.#config, this.#options.ledger, { observedOwnedResources: this.#options.observedOwnedResources,
        redactor: new Redactor([this.#options.runnerCredential]), dispatch: async (url, init) => {
          if (!this.#options.dispatch) throw new Error('Explicit Access bridge transport required'); return this.#options.dispatch(url, init);
        } });
      const response = await client.request({ kind: 'after', url: `${request.origin}/admin`, method: 'GET', retries: 0, followRedirects: false, observeRedirect: true,
        headers: { 'x-demo-run-token': this.#options.runnerCredential, 'x-demo-run-id': request.runId, 'x-demo-request-id': request.requestId, 'x-demo-scenario': 'access' } }, signal);
      const end = new Date(now()).toISOString(); response.excerpt = 'Access response body not retained';
      freeze(response); this.#attempts.set(key, Object.freeze({ response, origin: null, start, end }));
      if (![302, 303, 307, 401, 403].includes(response.status) || !response.rayId || end < start || Date.parse(end) - Date.parse(start) > 120000) return null;
      const afterRead = await this.#options.collectors.accessIdentitySnapshot(policy, tokenId, { runId: request.runId, phase: 'after' }, signal);
      const after = afterRead.value; const afterMap = after && observedAccessSnapshot(after, this.#options.collectors, now());
      if (afterRead.state !== 'observed' || !after || !afterMap || afterMap.clientId !== map.clientId || afterMap.tokenExpiresAt !== map.tokenExpiresAt
        || after.startedAt < end || after.mode !== before.mode || after.runId !== before.runId || after.functionalDigest !== before.functionalDigest) return null;
      const scope = { role: 'after' as const, scenarioId: 'access' as const, runId: request.runId, requestId: request.requestId,
        hostname: before.hostname, releaseDigest: this.#config.environments[1].releaseDigest, start, end };
      const origin = await this.#options.collectors.origin(scope, signal);
      this.#attempts.set(key, Object.freeze({ response, origin: freeze(origin.value), start, end }));
      const audit = await this.#options.collectors.policyAttribution(request, scope, response.rayId, signal);
      const event = audit.value?.accessAuthentication;
      if (origin.state !== 'observed' || origin.mode !== before.mode || !origin.value?.absenceProven || origin.value.receipts.length !== 0
        || !origin.value.coverage.watermark || !event || !event.complete || event.allowed !== false || event.authenticationAction !== 'login'
        || event.applicationId !== policy.applicationId || event.hostname !== before.hostname || event.path !== '/admin'
        || event.rayId.toLowerCase() !== response.rayId.slice(0, 16).toLowerCase() || event.eventTime < start || event.eventTime > end
        || !observedAccessSnapshot(before, this.#options.collectors, now()) || !observedAccessSnapshot(after, this.#options.collectors, now())) return null;
      const value = AccessApplicationRejectionSchema.parse({ schemaVersion: 1, kind: 'access-application-rejection', channel: 'authenticated-same-request-https', mode: before.mode,
        runId: request.runId, requestId: request.requestId, scenarioId: 'access', targetRole: 'after', releaseDigest: scope.releaseDigest,
        hostname: before.hostname, path: '/admin', method: 'GET', observedAt: end, event,
        beforeReadId: before.readId, afterReadId: after.readId, configurationDigest: before.functionalDigest,
        configuredApplicationId: before.applicationId, configuredPolicyId: before.configuredPolicyId, configuredAudience: before.audience,
        independentOriginAbsence: true, originWatermark: origin.value.coverage.watermark, fullRuntimeState: null, credentialCaseCoverage: 'unqualified' });
      Object.freeze(value.event); Object.freeze(value);
      admissions.set(value, { digest: digestValue(value), consumed: false,
        current: () => !!observedAccessSnapshot(before, this.#options.collectors, now()) && !!observedAccessSnapshot(after, this.#options.collectors, now()) });
      sealExchange(value, { response, origin: origin.value, before, after, start, end }); return value;
    } catch { return null; }
  }
}
