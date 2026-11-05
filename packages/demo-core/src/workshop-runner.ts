import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Id, ObservationSchema, ResultSchema, ScenarioId } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { scenario } from '../../../scenarios/catalog.js';
import { BudgetLedger, limitsFor, validatePlan, type Clock, type Limits } from './budget.js';
import { assertLiveReady, validateLabConfig, type LabConfig } from './config.js';
import { observePolicyOwnership, policyOwnershipMinimum } from './ownership.js';
import { LabLease, RunLifecycle } from './lifecycle.js';
import { GuardedClient, type Dispatch, type SafeResponse } from './transport.js';
import { makeArtifact, ReportStore, type Artifact, type Report } from './reports.js';
import { digestValue } from './deployment-plan.js';
import type { DemoCredentials } from './doctor.js';
import type { WafCustomOptions } from './waf-custom.js';
import { runTurnstile } from './turnstile.js';
import { apiShieldComparison, ApiShieldReadbackSchema, type ApiShieldOptions } from './api-shield.js';
import { accessComparison, qualifyAccessControl, AccessReadbackSchema, type AccessOptions } from './access-policy.js';
import { apiShieldDispatch, MtlsDispatchError, type LabClientCertificate } from './api-shield-transport.js';
import { accessPolicyDispatch, type LabAccessServiceToken } from './access-policy-transport.js';
import { PolicySignalSchema, executePolicyComparison, type PolicyRequest, type PolicyFlow, type PolicyComparison } from './api-shield-proof.js';
import { BrowserTransport, type BrowserTransportOptions, type BrowserPreview } from './browser-transport.js';
import { planWaitingRoom, runWaitingRoom, WaitingRoomStateMachine, type WaitingRoomResult } from './waiting-room.js';
import { DdosCaptureSchema, collectDdosEvidence, type DdosSelection, type DdosReview } from './ddos-evidence.js';
import { joinAnalytics, type AnalyticsInput, type AnalyticsSummary } from './analytics.js';
import type { Decision } from './proof.js';
import { ddosEventsBody } from './graphql.js';
import { createTrustedCollectors, type TrustedCollectors } from './trusted-collectors.js';
import { navigateWaitingRoomShopper } from './waiting-room.js';
import type { BrowserFrame, BrowserFrameScope } from './browser-transport.js';
import { createExecutionAudit, type ExecutionAuditEvidence } from './execution-audit.js';
import { readPlatformTlsVerification, bindPlatformTlsAdmission } from './platform-tls.js';
import { AccessServiceIdentityCollector, bindAccessServiceAdmission, bindAccessApplicationRejection, observedAccessExchange } from './access-service-identity.js';
import type { AccessSnapshot, AccessEnforcement } from '../../contracts/src/access-service-identity.js';
export interface OwnedRoomControl {
  scopes(): BrowserFrameScope[];
  capture(scope: BrowserFrameScope): Promise<BrowserFrame>;
  navigate(scope: BrowserFrameScope, path: string, signal?: AbortSignal): Promise<void>;
}

export type WorkshopScenario = Exclude<z.infer<typeof ScenarioId>, 'waf-custom' | 'waf-sqli' | 'waf-xss' | 'rate-limit' | 'bot'>;
export interface WorkshopRunnerOptions {
  projectRoot: string; config: LabConfig; credentials: DemoCredentials; mode: 'live' | 'fixture'; scenarioId: WorkshopScenario;
  limits?: Partial<Limits>; parent?: BudgetLedger; clock?: Clock; signal?: AbortSignal; dispatch?: Dispatch;
  ownershipPreflight: NonNullable<WafCustomOptions['ownershipPreflight']>;
  onStarted?: NonNullable<WafCustomOptions['onStarted']>; onPhase?: NonNullable<WafCustomOptions['onPhase']>; onObservation?: NonNullable<WafCustomOptions['onObservation']>; onEvidence?: NonNullable<WafCustomOptions['onEvidence']>;
  onWaitingRoom?: (value: WaitingRoomResult) => void; onPreview?: (value: BrowserPreview) => void;
  onFrame?: (value: BrowserFrame) => void;
  onRoomControl?: (control: OwnedRoomControl | null) => void;
  browser?: Pick<BrowserTransportOptions, 'launch' | 'fixture' | 'headed'>;
  resolveValue?: (reference: string) => string;
  resolveCertificate?: (reference: string) => LabClientCertificate;
  resolveServiceToken?: (reference: string) => LabAccessServiceToken;
  /** Trusted collectors receive the SAME guarded client. Raw response headers cannot attest product identity. */
  policySignal?: (request: PolicyRequest, response: SafeResponse | null, client: GuardedClient, signal: AbortSignal) => Promise<unknown>;
  policyReadback?: (id: 'api-shield' | 'access', client: GuardedClient, signal: AbortSignal) => Promise<unknown>;
  ddosReader?: (selection: Readonly<DdosSelection>, client: GuardedClient, signal: AbortSignal) => Promise<unknown>;
  analyticsInput?: AnalyticsInput;
}
export interface WorkshopCapture { report: Report; artifacts: Artifact[]; decision: Decision; waitingRoom?: WaitingRoomResult; ddos?: DdosReview; analytics?: AnalyticsSummary; executionAudit?: ExecutionAuditEvidence }
export function analyticsFromCapture(report: Report, artifacts: readonly Artifact[], config: LabConfig): AnalyticsInput {
  const r = report.result;
  const start = r.startedAt; const end = Date.parse(r.finishedAt) > Date.parse(start) ? r.finishedAt : new Date(Date.parse(start) + 1).toISOString();
  const observations = artifacts.flatMap(a => { const p = ObservationSchema.safeParse(a.payload); return p.success ? [p.data] : []; });
  // No collector metadata is invented. Positive rows may be shown, but absent
  // source-completeness evidence keeps totals and negative joins unverified.
  return { scope: { runId: r.runId, scenarioId: r.scenarioId, mode: report.mode, releaseDigest: r.releaseDigest, window: { start, end }, hosts: { before: new URL(config.environments[0].origin).hostname, after: new URL(config.environments[1].origin).hostname } }, observations, artifacts: [...artifacts], sources: [] };
}
export function workshopMinimum(id: WorkshopScenario, ownership: number, config?: LabConfig): number {
  if (config && id !== 'analytics' && id !== 'turnstile') ownership += policyOwnershipMinimum(config);
  if (id === 'waiting-room') {
    const room = config?.demonstrations?.waitingRoom;
    // Every possible navigation may reach the storefront. Each such visit
    // requires a checkpoint and receipt read; include both policy readbacks.
    return ownership + 2 + (4 + (room?.refreshes ?? 1)) * ((room?.perNavigationRequests ?? 1) + 2);
  }
  // Access: prior 22 native / 16 neutral minimum, plus two current reader-grant
  // reads, reused only inside this collector/run's 120-second window. No cap raise.
  return id === 'access' ? (config && !config.demonstrations?.accessIdentity ? 18 : 24) + ownership : id === 'api-shield' ? 18 + ownership : id === 'turnstile' ? 15 + ownership : id === 'analytics' ? 0 : id === 'ddos-evidence' ? 1 + ownership : 16 + ownership;
}
export function workshopWaitingRoomPlan(config: LabConfig, limits: Limits) {
  const room = config.demonstrations?.waitingRoom;
  if (!room) return null;
  if (room.settings.hostname !== new URL(config.environments[1].origin).hostname) throw new Error('Room targets differ');
  const plan = { path: room.settings.path, productId: 'launch-shirt', expectedTransitionMs: room.expectedTransitionMs, perNavigationRequests: room.perNavigationRequests, refreshes: room.refreshes, telemetryRequests: 2 * (4 + room.refreshes), interview: limits.maxRuntimeMs <= 75000 };
  planWaitingRoom(plan, limits);
  return plan;
}
export async function runWorkshopScenario(o: WorkshopRunnerOptions): Promise<WorkshopCapture> {
  const config = validateLabConfig(o.config, o.projectRoot); const settings = config.demonstrations;
  const resolveValue = o.resolveValue ?? (reference => { const value = /^env:[A-Z][A-Z0-9_]{2,100}$/.test(reference) ? process.env[reference.slice(4)] : undefined; if (!value) throw new Error('Configured lab credential is unavailable'); return value; });
  if (o.scenarioId === 'turnstile' && settings?.turnstile) return runTurnstile({ ...o, credentials: { runner: o.credentials.runner, collector: o.credentials.collector }, expectedAfter: settings.turnstile.expectedAfter, ...(settings.turnstile.positiveTokenRef ? { positiveToken: resolveValue(settings.turnstile.positiveTokenRef) } : {}) });
  if (o.mode === 'fixture' && !o.dispatch) throw new Error('Fixture execution requires injected transport');
  const manifest = scenario(o.scenarioId); const limits = limitsFor('scenario', { ...manifest.budget, ...o.limits });
  validatePlan(limits, workshopMinimum(o.scenarioId, o.ownershipPreflight.minimumRequests, config), o.scenarioId === 'waiting-room' ? 3 : 0, 1000);
  const roomPlan = o.scenarioId === 'waiting-room' ? workshopWaitingRoomPlan(config, limits) : null;
  const ledger = new BudgetLedger({ limits, ...(o.parent ? { parent: o.parent } : {}), ...(o.clock ? { clock: o.clock } : {}) });
  let claim: ReturnType<typeof LabLease.claim>;
  try { claim = LabLease.claim({ projectRoot: o.projectRoot, evidenceDirectory: config.evidenceDirectory, labId: config.labId, idempotencyKey: randomUUID() }); } catch (e) { ledger.stop(); throw e; }
  if (claim.kind !== 'claimed') { ledger.stop(); throw new Error('Lab already owns an active run'); }
  const lifecycle = new RunLifecycle(claim.lease, ledger); const runId = lifecycle.runId; const startedAt = new Date().toISOString();
  const audit = createExecutionAudit({ runId, releaseDigest: config.environments[0].releaseDigest, configurationDigest: digestValue(config), mode: o.mode, accountId: config.accountId, zoneId: config.zoneId }, { before: config.environments[0].origin, after: config.environments[1].origin, telemetry: config.telemetryOrigin });
  const rawDispatch: Dispatch = o.dispatch ?? fetch;
  const providerDispatch = audit.hookProviderDispatch(rawDispatch); const runtimeDispatch = audit.hookRuntimeDispatch(rawDispatch);
  const browserDispatch = audit.hookBrowserDispatch(rawDispatch); const wrapNative = audit.hookNativeDispatchFactory();
  o = { ...o, dispatch: (url, init) => new URL(url).origin === config.apiOrigin ? providerDispatch(url, init) : runtimeDispatch(url, init) };
  audit.beginVerification();
  const secrets = Object.values(o.credentials); let redactor = new Redactor(secrets); const artifacts: Artifact[] = []; const refs: ReturnType<typeof makeArtifact>['ref'][] = [];
  const save = (source: Artifact['source'], role: 'before' | 'after', requestId: string | null, payload: Artifact['payload'], observedAt = new Date().toISOString(), id: string = randomUUID()) => {
    const built = makeArtifact({ id, mode: o.mode, runId, scenarioId: o.scenarioId, targetRole: role, requestId, observedAt, source, payload }, redactor);
    if (!artifacts.some(a => a.id === id)) { artifacts.push(built.artifact); refs.push(built.ref); o.onEvidence?.(built.artifact); }
    return built.ref;
  };
  let browser: BrowserTransport | null = null;
  let roomWork: Promise<WaitingRoomResult> | undefined;
  const cancel = () => { lifecycle.cancel(claim.lease.ownerId); void browser?.close().catch(() => {}); };
  if (o.signal?.aborted) cancel(); else o.signal?.addEventListener('abort', cancel, { once: true });
  let client: GuardedClient; let collectors: TrustedCollectors; let owned: ReadonlySet<string> = new Set(); let configDigest: string | null = null;
  let decision: Decision = { mode: o.mode, outcome: 'unavailable', missingProof: ['Required scenario configuration is unavailable'], contradictions: [] };
  let waitingRoom: WaitingRoomResult | undefined; let ddos: DdosReview | undefined; let analytics: AnalyticsSummary | undefined;
  let policyOptions: ApiShieldOptions | AccessOptions | undefined;
  let comparison: PolicyComparison | undefined; const baselineFlows = new Map<string, PolicyFlow>();
  let accessBefore: AccessSnapshot | null = null; let accessLatest: AccessSnapshot | null = null;
  let accessReadState: string = 'unknown'; let accessBridge: AccessServiceIdentityCollector | null = null;
  let accessAuditOnlyDigest: string | null = null;
  const accessTokenId = () => settings?.serviceToken?.id ?? config.optionalResources?.find(r => r.module === 'access')?.serviceTokenId ?? null;
  const observation = (q: PolicyRequest, response: SafeResponse | null, observedAt = new Date().toISOString()) => {
    const value = ObservationSchema.parse({ schemaVersion: 1, id: randomUUID(), runId, requestId: q.requestId, scenarioId: o.scenarioId, targetRole: q.role, mode: o.mode, observedAt, method: 'GET', path: q.path, status: response?.status ?? null, latencyMs: response?.latencyMs ?? 0, rayId: response?.rayId ?? null, action: null, ruleId: null, originCount: null, excerpt: response?.excerpt ?? 'Explicit peer client-certificate rejection' });
    const ref = save('http', q.role, q.requestId, value, value.observedAt); o.onObservation?.(value); return { value, ref };
  };
  const readback = async (id: 'api-shield' | 'access', phase: 'before' | 'after' = 'before') => {
    if (id === 'access') {
      const tokenId = accessTokenId(); accessLatest = null;
      if (!settings?.access || !tokenId) { accessReadState = 'unknown'; return null; }
      if (!settings.accessIdentity) {
        // Explicit neutral-audit compatibility path. No service producer or test
        // callback is promoted; missing native verifier remains a proof gap.
        const auditOnly = await collectors.accessPolicy(settings.access, tokenId, lifecycle.signal);
        accessReadState = auditOnly.state; accessAuditOnlyDigest = auditOnly.value?.functionalDigest ?? null;
        return auditOnly.state === 'observed' ? auditOnly.value?.readback ?? null : null;
      }
      const observed = await collectors.accessIdentitySnapshot(settings.access, tokenId, { runId, phase }, lifecycle.signal);
      accessReadState = observed.state;
      if (observed.state !== 'observed' || !observed.value) return null;
      const snapshot = observed.value; accessLatest = snapshot; if (phase === 'before') accessBefore = snapshot;
      save('configuration', 'after', null, snapshot, snapshot.observedAt, snapshot.readId);
      // These fixed booleans describe the exact successfully observed supported form,
      // not a projection of desired state. The snapshot digests all effective scope.
      return { applicationId: snapshot.applicationId, policyId: snapshot.configuredPolicyId, audience: snapshot.audience,
        hostname: snapshot.hostname, path: snapshot.path, enabled: true, baselineExcluded: true, serviceTokenAllowed: true, decision: 'non_identity', bypass: false };
    }
    if (o.policyReadback) return o.policyReadback(id, client, lifecycle.signal);
    const confirmedAccess = config.optionalResources?.find(resource => resource.module === 'access' && resource.mode === o.mode && settings?.access
      && resource.resourceId === settings.access.applicationId && resource.policyId === settings.access.policyId && resource.audience === settings.access.audience);
    const tokenId = settings?.serviceToken?.id ?? (confirmedAccess?.module === 'access' ? confirmedAccess.serviceTokenId : null);
    const trusted = id === 'api-shield'
      ? await collectors.mtlsPolicy(settings!.apiShield!, lifecycle.signal, runId)
      : await collectors.accessPolicy(settings!.access!, tokenId, lifecycle.signal);
    // Unsupported attribution and unknown service-token identity stay unknown.
    return trusted.state === 'observed' ? trusted.value?.readback ?? null : null;
  };
  const readRoom = async () => {
    const room = settings!.waitingRoom!;
    const response = await client.requestJson({ url: `${config.apiOrigin}/client/v4/zones/${config.zoneId}/waiting_rooms/${room.id}`, kind: 'cloudflare', headers: { authorization: `Bearer ${o.credentials.reader}` } }, z.object({ success: z.literal(true), result: z.object({ id: Id.or(z.string().regex(/^[a-f0-9]{32}$/)), host: z.string(), path: z.string(), total_active_users: z.number(), new_users_per_minute: z.number(), session_duration: z.number(), suspended: z.boolean(), queue_all: z.boolean() }) }), lifecycle.signal);
    if (response.status !== 200) throw new Error('Waiting Room configuration unreadable');
    const observed = response.data.result; const { id, host, ...rest } = observed;
    return { observed, matches: id === room.id && digestValue({ hostname: host, ...rest }) === digestValue(room.settings) };
  };
  const collectOrigin = async (role: 'before' | 'after', requestId: string | null, signal: AbortSignal) => {
    const env = config.environments.find(e => e.role === role)!;
    const end = new Date().toISOString();
    const read = await collectors.origin({ role, hostname: new URL(env.origin).hostname, runId, scenarioId: o.scenarioId, requestId: requestId ?? randomUUID(), releaseDigest: env.releaseDigest, start: startedAt, end }, signal);
    if (!read.value || read.state === 'mismatch') throw new Error('Trusted origin evidence unavailable or foreign');
    const coverage = read.state === 'observed' ? read.value.coverage : { ...read.value.coverage, healthy: false, complete: false };
    const coverageRef = save('origin', role, null, coverage, coverage.watermark ?? end);
    const receipts = read.value.receipts;
    const originRefs = receipts.map(r => save('origin', role, r.requestId, r, r.observedAt, r.id));
    return { receipts, coverage, originEvidence: [coverageRef, ...originRefs] };
  };
  const exchange = async (q: PolicyRequest, signal = lifecycle.signal): Promise<PolicyFlow> => {
    if (o.scenarioId === 'access' && q.role === 'after' && accessBefore && accessBridge) {
      let enforcement: AccessEnforcement | null = null; const tokenId = accessTokenId();
      if (accessBridge && accessBefore && tokenId && settings?.access) {
        if (q.case === 'authorized' && settings.serviceToken && q.credentialRef === settings.serviceToken.ref) {
          try {
            const token = o.resolveServiceToken ? o.resolveServiceToken(settings.serviceToken.ref) : {
              clientId: resolveValue(settings.serviceToken.clientIdRef), clientSecret: resolveValue(settings.serviceToken.clientSecretRef) };
            secrets.push(token.clientId, token.clientSecret); redactor = new Redactor(secrets);
            const current = await accessBridge.collect(q, accessBefore, settings.access, tokenId, token, signal);
            enforcement = current ? bindAccessServiceAdmission(current) : null;
          } catch { /* No fallback producer or redispatch. */ }
        } else if (q.case === 'missing') {
          const current = await accessBridge.collectMissing(q, accessBefore, settings.access, tokenId, signal);
          enforcement = current ? bindAccessApplicationRejection(current) : null;
        }
      }
      const attempt = accessBridge?.attempt(q); const joined = enforcement ? observedAccessExchange(enforcement) : null;
      const http = observation(q, attempt?.response ?? null, attempt?.end);
      const trustedOrigin = joined?.origin ?? attempt?.origin;
      const origin = trustedOrigin ? { receipts: trustedOrigin.receipts, coverage: trustedOrigin.coverage,
        originEvidence: [save('origin', q.role, null, trustedOrigin.coverage, trustedOrigin.coverage.watermark ?? http.value.observedAt),
          ...trustedOrigin.receipts.map(r => save('origin', q.role, r.requestId, r, r.observedAt, r.id))] }
        : await collectOrigin(q.role, q.requestId, signal).catch(() => ({ receipts: [], originEvidence: [],
          coverage: { healthy: false, complete: false, gaps: ['Trusted origin evidence unavailable'], windowStart: startedAt, watermark: null, producerSequence: null } }));
      if (joined) save('configuration', 'after', null, joined.after, joined.after.observedAt, joined.after.readId);
      const accessRef = enforcement ? save('verification', 'after', q.requestId, enforcement,
        enforcement.kind === 'access-service-admission' ? enforcement.completedAt : enforcement.observedAt) : null;
      return { observation: http.value, httpEvidence: http.ref, signal: null, verificationEvidence: null, ...origin,
        ...(enforcement && accessRef ? { accessEnforcement: enforcement, accessEnforcementEvidence: accessRef } : {}) };
    }
    let target = client; let certificateRejected = false;
    const common = { observedOwnedResources: owned, ...(o.dispatch ? { dispatch: o.dispatch } : {}), redactor };
    if (q.role === 'after' && o.scenarioId === 'access') {
      const transport = accessPolicyDispatch(settings!.access!, q.credentialRef, ref => {
        if (o.resolveServiceToken) return o.resolveServiceToken(ref);
        const token = settings?.serviceToken; if (!token || token.ref !== ref) throw new Error('Service token unavailable');
        const values = { clientId: resolveValue(token.clientIdRef), clientSecret: resolveValue(token.clientSecretRef) }; secrets.push(...Object.values(values)); return values;
      }, o.dispatch ?? fetch, { scope: { runId, requestId: q.requestId, scenarioId: 'access' } });
      redactor = new Redactor(secrets); target = new GuardedClient(config, ledger, { ...common, ...transport });
    }
    if (q.role === 'after' && o.scenarioId === 'api-shield' && o.mode === 'live') {
      const transport = apiShieldDispatch(settings!.apiShield!, q.credentialRef, ref => {
        if (o.resolveCertificate) return o.resolveCertificate(ref);
        const cert = settings?.certificates?.find(c => c.ref === ref); if (!cert) throw new Error('Certificate unavailable');
        const value = { certificate: resolveValue(cert.certificateRef), privateKey: resolveValue(cert.privateKeyRef) }; secrets.push(...Object.values(value)); return value;
      }, { scope: { runId, requestId: q.requestId, scenarioId: 'api-shield' }, wrapDispatch: wrapNative });
      redactor = new Redactor(secrets);
      target = new GuardedClient(config, ledger, { ...common, redactor: transport.redactor, dispatch: async (url, init) => { try { return await transport.dispatch(url, init); } catch (e) { certificateRejected = transport.certificateRejected || e instanceof MtlsDispatchError && e.certificateRejected; throw e; } } });
    }
    let response: SafeResponse | null = null;
    try { response = await target.request({ url: `${q.origin}${q.path}`, kind: q.role, headers: { 'x-demo-run-token': o.credentials.runner, 'x-demo-run-id': runId, 'x-demo-request-id': q.requestId, 'x-demo-scenario': q.scenarioId }, ...(q.role === 'after' && q.path === '/admin' ? { observeRedirect: true } : {}) }, signal); } catch (e) { if (!certificateRejected) throw e; }
    const http = observation(q, response);
    const tlsFacts = q.role === 'after' && o.scenarioId === 'api-shield' ? readPlatformTlsVerification(response, {
      runId, requestId: q.requestId, releaseDigest: config.environments[1].releaseDigest,
      hostname: new URL(q.origin).hostname, start: startedAt, end: http.value.observedAt,
    }) : null;
    const platformTlsEvidence = tlsFacts ? save('verification', q.role, q.requestId, tlsFacts, tlsFacts.observedAt) : null;
    // Keep an already-observed contradiction even when the independent origin
    // channel fails. Empty receipts here mean unknown, never proven absence.
    const origin = await collectOrigin(q.role, q.requestId, signal).catch(() => ({ receipts: [], originEvidence: [],
      coverage: { healthy: false, complete: false, gaps: ['Trusted origin evidence unavailable'], windowStart: startedAt, watermark: null, producerSequence: null } }));
    const configurationEvidence = policyOptions?.configurationEvidence ?? null;
    const configuration = configurationEvidence ? artifacts.find(artifact => artifact.id === configurationEvidence.id) ?? null : null;
    let raw: unknown = tlsFacts && policyOptions ? bindPlatformTlsAdmission({ request: q, facts: tlsFacts,
      readback: policyOptions.readback, configuration, configurationEvidence, observation: http.value, httpEvidence: http.ref,
      receipts: origin.receipts, originEvidence: origin.originEvidence }) : null;
    try {
    if (raw === null && !signal.aborted && o.policySignal && o.scenarioId !== 'access') raw = await o.policySignal(q, response, client, signal);
    else if (raw === null && !signal.aborted && q.role === 'after') {
      const env = config.environments.find(e => e.role === q.role)!;
      const attribution = await collectors.policyAttribution(q, { role: q.role, hostname: new URL(q.origin).hostname, runId, scenarioId: q.scenarioId, requestId: q.requestId, releaseDigest: env.releaseDigest, start: startedAt, end: new Date().toISOString() }, response?.rayId ?? null, signal);
      const edge = attribution.value?.edge;
      if (edge) for (const event of edge.events) save('cloudflare', q.role, q.requestId, { kind: 'edge', rayId: event.rayName, action: event.action, ruleId: event.ruleId, product: event.source, hostname: event.clientRequestHTTPHost, eventTime: event.datetime, sampling: 'unknown' }, edge.observedAt);
      if (attribution.value?.accessAuthentication) save('cloudflare', q.role, q.requestId, attribution.value.accessAuthentication, attribution.observedAt);
      raw = attribution.value?.policySignal ?? null;
    }
    } catch { raw = null; }
    const parsedSignal = PolicySignalSchema.safeParse(raw);
    const productSignal = parsedSignal.success ? parsedSignal.data : null;
    const verificationEvidence = productSignal ? save('verification', q.role, q.requestId, { kind: 'verification', accepted: productSignal.action === 'allow', verificationMode: 'live', policyId: productSignal.policyId, reason: productSignal.source, policySignal: productSignal }, http.value.observedAt) : null;
    return { observation: http.value, httpEvidence: http.ref, signal: productSignal, verificationEvidence, ...origin,
      ...(tlsFacts && platformTlsEvidence ? { platformTls: tlsFacts, platformTlsEvidence } : {}) }; 
  };
  try {
    const execution = await lifecycle.execute({
      preflight: async () => {
        o.onPhase?.('preflight'); o.onStarted?.({ runId, stop: cancel }); lifecycle.signal.throwIfAborted();
        if (o.scenarioId === 'analytics') return;
        const configured = o.scenarioId === 'api-shield' ? settings?.apiShield : o.scenarioId === 'access' ? settings?.access : o.scenarioId === 'waiting-room' ? settings?.waitingRoom : o.scenarioId === 'ddos-evidence' ? settings?.ddos : null;
        if (!configured) throw new Error('Scenario configuration unavailable');
        const discovery = new GuardedClient(config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), redactor, ...(o.dispatch ? { dispatch: o.dispatch } : {}) });
        owned = await o.ownershipPreflight.run(discovery, lifecycle.signal);
        owned = await observePolicyOwnership(config, o.credentials.reader, discovery, owned, lifecycle.signal);
        assertLiveReady(config, owned);
        decision = { mode: o.mode, outcome: 'inconclusive', missingProof: ['Required observations have not completed'], contradictions: [] };
        client = new GuardedClient(config, ledger, { observedOwnedResources: owned, redactor, ...(o.dispatch ? { dispatch: o.dispatch } : {}) });
        collectors = createTrustedCollectors({ config, ledger, observedOwnedResources: owned, mode: o.mode, credentials: o.credentials, dispatch: o.dispatch ?? ((url, init) => fetch(url, init)) });
        if (o.scenarioId === 'access') accessBridge = new AccessServiceIdentityCollector({ config, ledger, collectors, mode: o.mode,
          observedOwnedResources: owned, runnerCredential: o.credentials.runner, dispatch: o.dispatch ?? ((url, init) => fetch(url, init)) });
        if (o.scenarioId === 'api-shield' || o.scenarioId === 'access') {
          const p = o.scenarioId === 'api-shield' ? settings!.apiShield! : settings!.access!;
          if (p.beforeOrigin !== config.environments[0].origin || p.afterOrigin !== config.environments[1].origin) throw new Error('Policy targets differ from the lab');
          const observed = await readback(o.scenarioId);
          configDigest = o.scenarioId === 'access' ? accessBefore?.functionalDigest ?? accessAuditOnlyDigest : observed === null ? null : digestValue(observed);
          const evidence = configDigest ? save('configuration', 'after', null, { schemaVersion: 1, observedAt: new Date().toISOString(), releaseDigest: config.environments[1].releaseDigest, observedConfigDigest: configDigest, inventoryDigest: digestValue(config.inventory), state: 'observed' }) : null;
          const base = { runId, mode: o.mode, releaseDigest: config.environments[0].releaseDigest, configurationEvidence: evidence };
          policyOptions = o.scenarioId === 'api-shield' ? { ...base, policy: settings!.apiShield!, readback: observed === null ? null : ApiShieldReadbackSchema.parse(observed) } : { ...base, policy: settings!.access!, readback: observed === null ? null : AccessReadbackSchema.parse(observed) };
        }
      },
      baseline: async () => {
        o.onPhase?.('baseline');
        if (policyOptions) {
          comparison = o.scenarioId === 'api-shield' ? apiShieldComparison(policyOptions as ApiShieldOptions) : accessComparison(policyOptions as AccessOptions);
          if (o.scenarioId === 'access' && accessReadState === 'mismatch') comparison.inspection.matches = false;
          if (!comparison.unavailable.length && comparison.inspection.matches === true) for (const q of comparison.requests.filter(q => q.role === 'before')) baselineFlows.set(q.requestId, await exchange(q));
        }
      },
      protected: async () => {
        o.onPhase?.('protected');
        if (policyOptions && comparison) {
          const result = await executePolicyComparison(comparison, { redactor, exchange: (q, signal) => baselineFlows.has(q.requestId) ? Promise.resolve(baselineFlows.get(q.requestId)!) : exchange(q, signal) }, lifecycle.signal);
          if (o.scenarioId === 'access') {
            qualifyAccessControl(result, (policyOptions as AccessOptions).policy);
            if (!settings?.accessIdentity) result.decision.missingProof.push('Native Access service verifier configuration unavailable; neutral audit only');
          }
          decision = result.decision;
        } else if (o.scenarioId === 'waiting-room') {
          const room = settings!.waitingRoom!;
          if (room.settings.hostname !== new URL(config.environments[1].origin).hostname) throw new Error('Room targets differ');
          const plan = roomPlan!;
          const { observed, matches } = await readRoom();
          configDigest = digestValue(observed);
          save('configuration', 'after', null, { schemaVersion: 1, observedAt: new Date().toISOString(), releaseDigest: config.environments[1].releaseDigest, observedConfigDigest: configDigest, inventoryDigest: digestValue(config.inventory), state: 'observed' });
          if (!matches) {
            decision = { mode: o.mode, outcome: 'failed', missingProof: [], contradictions: ['Observed Waiting Room differs from the declared room'] };
            return;
          }
          browser = await BrowserTransport.create({ mode: o.mode, config, ledger, observedOwnedResources: owned, runnerToken: o.credentials.runner, correlation: { runId, scenarioId: 'waiting-room' }, previewSelectors: [room.queueSelector, room.storefrontSelector], navigationPaths: [room.settings.path, '/catalog'], framePublicText: ['Synthetic shopper', 'Synthetic shopper · Before baseline', 'Synthetic shopper · After custom WAF lab'], dispatch: browserDispatch, ...o.browser });
          if (!browser) throw new Error('Browser unavailable');
          const machine = new WaitingRoomStateMachine(runId, o.mode, { mode: o.mode, state: 'observed', matchesScope: matches, queueContractQualified: room.queueContractQualified, releaseDigest: config.environments[0].releaseDigest });
          lifecycle.trackOwned(`${runId}:browser`, claim.lease.ownerId, async () => { await browser?.close(); });
          let navigating = false;
          const transport = browser;
          o.onRoomControl?.({
            scopes: () => transport.sessions.filter(s => s.state === 'open').map(s => transport.frameScope(s.sessionId)),
            capture: async scope => {
              const session = machine.result().sessions.find(s => s.sessionId === scope.sessionId);
              if (!session || !['queued', 'admitted'].includes(session.state) || navigating || lifecycle.signal.aborted) throw new Error('Current owned surface required');
              return transport.captureFrame(scope, session.state === 'queued' ? room.queueSelector : room.storefrontSelector);
            },
            navigate: async (scope, path, signal) => {
            if (navigating || transport.stopped || lifecycle.signal.aborted) throw new Error('Owned shopper is busy or closed');
            navigating = true;
            try {
              const result = await navigateWaitingRoomShopper({ transport, machine, scope, path,
                selectors: { queue: room.queueSelector, storefront: room.storefrontSelector },
                signal: AbortSignal.any([lifecycle.signal, ...(signal ? [signal] : [])]),
                receipts: async (id, receiptSignal, role) => (await collectOrigin(role, id, receiptSignal)).receipts });
              waitingRoom = result; o.onWaitingRoom?.(result);
              if (o.onFrame) {
                try { o.onFrame(await transport.captureFrame(scope, room.storefrontSelector)); }
                catch { /* Navigation evidence survives an unavailable or rate-limited frame. */ }
              }
            } finally { navigating = false; }
          } });
          roomWork = runWaitingRoom({ transport: browser, ledger, plan, signal: lifecycle.signal, beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin, machine, selectors: { queue: room.queueSelector, storefront: room.storefrontSelector }, receipts: async (id, signal, role) => (await collectOrigin(role, id, signal)).receipts, onSnapshot: value => { waitingRoom = value; o.onWaitingRoom?.(value); }, onPreview: value => { o.onPreview?.(value); }, ...(o.onFrame ? { onFrame: o.onFrame } : {}) });
          waitingRoom = await roomWork;
          for (const s of waitingRoom.sessions) save('browser', s.role, null, { kind: 'browser', sessionLabel: s.sessionId, state: s.lastObservedState === 'queued' || s.lastObservedState === 'admitted' ? s.lastObservedState : 'unknown', cookieContinuity: s.cookieContinuity, source: 'observed-page' });
          decision = { mode: o.mode, outcome: waitingRoom.outcome, missingProof: waitingRoom.missingProof, contradictions: waitingRoom.contradictions };
        } else if (o.scenarioId === 'ddos-evidence') {
          const selection = settings!.ddos!;
          if (selection.mode !== o.mode || selection.zoneId !== config.zoneId || selection.hostname !== new URL(config.environments[1].origin).hostname) throw new Error('DDoS selection differs from execution scope');
          ddos = await collectDdosEvidence(selection, { read: async s => {
            let raw: unknown;
            if (o.ddosReader) raw = await o.ddosReader(s, client, lifecycle.signal);
            else {
              const response = await client.requestJson({ url: `${config.apiOrigin}/client/v4/graphql`, kind: 'cloudflare', method: 'POST', headers: { authorization: `Bearer ${o.credentials.reader}`, 'content-type': 'application/json' }, body: ddosEventsBody({ zoneId: s.zoneId, hostname: s.hostname, start: s.start, end: s.end, limit: s.limit }) }, z.object({ data: z.object({ viewer: z.object({ zones: z.array(z.object({ firewallEventsAdaptive: DdosCaptureSchema.shape.events })).length(1) }) }).nullable().optional(), errors: z.array(z.object({ message: z.string().max(4096) })).max(20).optional() }), lifecycle.signal);
              if (response.status !== 200 || !response.data.data || response.data.errors?.length) throw new Error('Historical DDoS read unavailable');
              const events = response.data.data.viewer.zones[0]!.firewallEventsAdaptive;
              raw = { source: s.source, zoneId: s.zoneId, hostname: s.hostname, start: s.start, end: s.end, mode: o.mode, observedAt: new Date().toISOString(), sampling: 'unknown', complete: events.length < s.limit, ingestionDelayMs: null, events };
            }
            const capture = DdosCaptureSchema.parse(raw);
            save('cloudflare', 'after', null, { kind: 'ddos', capture }); return capture;
          } }, lifecycle.signal);
          configDigest = digestValue(selection); decision = { mode: o.mode, outcome: ddos.outcome, missingProof: ddos.missingProof, contradictions: [] };
        } else if (o.scenarioId === 'analytics') {
          let input = o.analyticsInput;
          if (!input && settings?.analyticsRunId) { const store = new ReportStore(o.projectRoot, config.evidenceDirectory); const report = store.load(settings.analyticsRunId); input = analyticsFromCapture(report, store.loadArtifacts(settings.analyticsRunId), config); }
          if (!input) return;
          // Saved data never becomes current live traffic or a new live pass.
          analytics = joinAnalytics(input); configDigest = digestValue(input.scope);
          decision = { mode: o.mode, outcome: 'inconclusive', missingProof: ['Analytics reuses a separately scoped capture; not new mitigation or readiness proof', ...analytics.missingProof], contradictions: [] };
        }
      },
      correlate: async () => {
        o.onPhase?.('correlate');
        if (waitingRoom) {
          try {
            const final = await readRoom();
            save('configuration', 'after', null, { schemaVersion: 1, observedAt: new Date().toISOString(), releaseDigest: config.environments[1].releaseDigest, observedConfigDigest: digestValue(final.observed), inventoryDigest: digestValue(config.inventory), state: 'observed' });
            if (!final.matches || digestValue(final.observed) !== configDigest) {
              decision.outcome = 'failed'; waitingRoom.outcome = 'failed'; decision.contradictions.push('Waiting Room configuration changed or differs from the declared room');
            }
          } catch {
            if (decision.outcome !== 'failed') { decision.outcome = 'inconclusive'; waitingRoom.outcome = 'inconclusive'; }
            configDigest = null; decision.missingProof.push('Final Waiting Room readback is unavailable');
          }
          waitingRoom.liveReadiness &&= decision.outcome === 'verified';
          waitingRoom.fixtureAssertionsPassed &&= !decision.contradictions.length && configDigest !== null;
          o.onWaitingRoom?.(waitingRoom);
        }
        if (policyOptions && o.scenarioId === 'access') {
          const after = await readback('access', 'after'); const currentDigest = accessLatest?.functionalDigest ?? accessAuditOnlyDigest;
          if (after === null || currentDigest !== configDigest) {
            const contradicted = accessReadState === 'mismatch' || after !== null;
            if (contradicted || decision.outcome !== 'failed') decision.outcome = contradicted ? 'failed' : 'inconclusive';
            decision.missingProof.push('Final Access readback changed or is unavailable');
            if (contradicted) decision.contradictions.push('Access configuration changed during the run');
          }
        } else if (policyOptions && o.scenarioId === 'api-shield') { const after = await readback(o.scenarioId); if (after === null || digestValue(after) !== configDigest) { if (after !== null || decision.outcome !== 'failed') decision.outcome = after === null ? 'inconclusive' : 'failed'; decision.missingProof.push('Final policy readback changed or is unavailable'); if (after !== null) decision.contradictions.push('Policy changed during the run'); } } },
      report: async () => { o.onPhase?.('report'); },
    });
    // A deadline can win the lifecycle race before the browser step unwinds.
    // Close owned I/O and drain that local step before freezing refs and artifacts.
    // Otherwise its late browser artifacts can make ReportStore reject the report.
    if (roomWork) {
      try { await (browser as BrowserTransport | null)?.close(); await roomWork; }
      catch {
        // Cleanup failure is evidence, not permission to discard the report.
        execution.cleanup = 'incomplete'; execution.executionFailed = true;
        await roomWork.catch(() => {});
      }
    }
    if (execution.executionFailed || lifecycle.interrupted.value || execution.cleanup === 'incomplete') { if (decision.outcome !== 'failed' && (decision.outcome !== 'unavailable' || lifecycle.interrupted.value)) decision.outcome = 'inconclusive'; decision.missingProof.push('Execution or owned cleanup is incomplete'); }
    if (execution.executionFailed || lifecycle.interrupted.value) configDigest = null;
    if (waitingRoom) {
      waitingRoom = { ...waitingRoom, outcome: decision.outcome === 'unavailable' ? 'unavailable' : decision.outcome === 'skipped' ? 'inconclusive' : decision.outcome,
        missingProof: [...decision.missingProof], contradictions: [...decision.contradictions],
        liveReadiness: waitingRoom.liveReadiness && decision.outcome === 'verified',
        fixtureAssertionsPassed: waitingRoom.fixtureAssertionsPassed && !execution.executionFailed && !lifecycle.interrupted.value };
      o.onWaitingRoom?.(waitingRoom);
    }
    const report: Report = { schemaVersion: 1, mode: o.mode, manifestVersion: manifest.version, createdAt: new Date().toISOString(), result: ResultSchema.parse({ schemaVersion: 1, runId, scenarioId: o.scenarioId, outcome: decision.outcome, evidence: refs, missingProof: decision.missingProof, contradictions: decision.contradictions, releaseDigest: config.environments[0].releaseDigest, observedConfigDigest: configDigest, startedAt, finishedAt: new Date().toISOString(), requestsUsed: ledger.snapshot.requestsUsed, peakConcurrency: ledger.snapshot.peakConcurrency, sessionsUsed: ledger.snapshot.sessionsUsed, cleanup: execution.cleanup }), notes: manifest.notes, ...(analytics ? { analytics } : {}), ...(waitingRoom ? { waitingRoom } : {}) };
    o.onPhase?.('finished'); return { report, artifacts, decision, ...(waitingRoom ? { waitingRoom } : {}), ...(ddos ? { ddos } : {}), ...(analytics ? { analytics } : {}), executionAudit: audit.finish() };
  } finally { o.onRoomControl?.(null); o.signal?.removeEventListener('abort', cancel); await (browser as BrowserTransport | null)?.close().catch(() => {}); }
}
