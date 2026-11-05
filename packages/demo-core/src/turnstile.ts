import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CoverageSchema, Digest, Id, ObservationSchema, ReceiptSchema, ResultSchema, Role, TurnstileConfigSchema, TurnstileReceiptSchema } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { scenario } from '../../../scenarios/catalog.js';
import { BudgetLedger, limitsFor, validatePlan, type Clock, type Limits } from './budget.js';
import { assertLiveReady, validateLabConfig, type LabConfig } from './config.js';
import { LabLease, RunLifecycle, type Phase } from './lifecycle.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { makeArtifact, type Artifact, type Report } from './reports.js';
import { digestValue } from './deployment-plan.js';
import type { Decision } from './proof.js';
const ConfigResponse = z.strictObject({ role: Role, releaseDigest: Digest, config: TurnstileConfigSchema.nullable() });
const EvidenceResponse = z.strictObject({ schemaVersion: z.literal(1), targetRole: Role, runId: Id, receipts: z.array(TurnstileReceiptSchema).max(100), records: z.array(z.strictObject({ requestId: Id, recordId: Id, exists: z.boolean() })).max(100), truncated: z.boolean() });
const OriginResponse = z.strictObject({ schemaVersion: z.literal(1), targetRole: Role, runId: Id, scenarioId: z.literal('turnstile'), originCount: z.number().int().nonnegative().nullable(), receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema });
export const TURNSTILE_WORK_REQUESTS = 15;
export const TURNSTILE_CLEANUP_REQUESTS = 2;
export const TURNSTILE_TOTAL_REQUESTS = TURNSTILE_WORK_REQUESTS + TURNSTILE_CLEANUP_REQUESTS;
export interface TurnstileOptions {
  projectRoot: string; config: LabConfig; observedOwnedResources?: ReadonlySet<string>;
  ownershipPreflight?: { minimumRequests: number; run: (client: GuardedClient, signal: AbortSignal) => Promise<ReadonlySet<string>> };
  mode: 'live' | 'fixture'; expectedAfter: z.infer<typeof TurnstileConfigSchema>;
  credentials: { runner: string; collector: string }; positiveToken?: string;
  dispatch?: Dispatch; limits?: Partial<Limits>; parent?: BudgetLedger; clock?: Clock; now?: () => number;
  signal?: AbortSignal; idempotencyKey?: string;
  onStarted?: (value: { runId: string; stop: () => void }) => void;
  onPhase?: (phase: Phase) => void; onObservation?: (value: z.infer<typeof ObservationSchema>) => void; onEvidence?: (value: Artifact) => void;
}
export interface TurnstileRun {
  report: Report; artifacts: Artifact[]; decision: Decision;
  verificationMode: 'test' | 'live'; attribution: 'application-side'; verificationReceipts: z.infer<typeof TurnstileReceiptSchema>[];
  leftovers: string[];
}
/** No browser, setup or unguarded transport. A live positive token must be
 * supplied by an authorized lab client; the runner never solves challenges. */
export async function runTurnstile(options: TurnstileOptions): Promise<TurnstileRun> {
  z.enum(['live', 'fixture']).parse(options.mode);
  if (options.mode === 'fixture' && !options.dispatch) throw new Error('Fixture runs require an injected transport');
  validateLabConfig(options.config, options.projectRoot);
  if (!options.config.liveOptIn) throw new Error('Explicit owned-lab run opt-in required');
  if (!options.ownershipPreflight) assertLiveReady(options.config, options.observedOwnedResources ?? new Set());
  const expected = TurnstileConfigSchema.parse(options.expectedAfter);
  if (expected.mode === 'disabled' || expected.hostname !== new URL(options.config.environments[1].origin).hostname) throw new Error('Protected verifier must match After');
  const credentials = z.strictObject({ runner: z.string().min(24), collector: z.string().min(24) }).parse(options.credentials);
  if (credentials.runner === credentials.collector) throw new Error('Separate runner and collector credentials required');
  const manifest = scenario('turnstile');
  // Fifteen work calls and two reserved cleanup calls; internal Siteverify work
  // is recorded in receipts, not counted as another runner boundary dispatch.
  const limits = limitsFor('scenario', { ...manifest.budget, cleanupRequests: TURNSTILE_CLEANUP_REQUESTS, ...options.limits });
  if (limits.cleanupRequests < TURNSTILE_CLEANUP_REQUESTS) throw new Error('Two cleanup permits required');
  validatePlan(limits, TURNSTILE_WORK_REQUESTS + (options.ownershipPreflight?.minimumRequests ?? 0), 0, 1000);
  const now = options.now ?? Date.now; const iso = () => new Date(now()).toISOString(); const startedAt = iso();
  const ledger = new BudgetLedger({ limits, ...(options.parent ? { parent: options.parent } : {}), ...(options.clock ? { clock: options.clock } : {}) });
  let claim: ReturnType<typeof LabLease.claim>;
  try { claim = LabLease.claim({ projectRoot: options.projectRoot, evidenceDirectory: options.config.evidenceDirectory, labId: options.config.labId, idempotencyKey: options.idempotencyKey ?? randomUUID() }); } catch (error) { ledger.stop(); throw error; }
  if (claim.kind !== 'claimed') { ledger.stop(); throw new Error('Lab already owns a run'); }
  const { lease } = claim; const lifecycle = new RunLifecycle(lease, ledger); const runId = lifecycle.runId;
  const positive = options.positiveToken ?? (expected.mode === 'test' ? 'XXXX.DUMMY.TOKEN.XXXX' : '');
  const invalid = `invalid-synthetic-${randomUUID()}`;
  const secrets = [...Object.values(credentials), positive, invalid];
  const redactor = () => new Redactor(secrets);
  let observed = options.observedOwnedResources ?? new Set<string>();
  const client = () => new GuardedClient(options.config, ledger, { observedOwnedResources: observed, ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor: redactor() });
  const artifacts: Artifact[] = []; const refs: ReturnType<typeof makeArtifact>['ref'][] = [];
  const save = (source: Artifact['source'], role: 'before' | 'after', requestId: string | null, payload: Artifact['payload']) => {
    const item = makeArtifact({ id: randomUUID(), mode: options.mode, runId, scenarioId: 'turnstile', targetRole: role, requestId, observedAt: iso(), source, payload }, redactor());
    artifacts.push(item.artifact); refs.push(item.ref); options.onEvidence?.(item.artifact);
  };
  type Case = { role: 'before' | 'after'; kind: 'missing' | 'invalid' | 'positive' | 'replay'; requestId: string; recordId: string; status: number };
  const cases: Case[] = []; const receipts: TurnstileRun['verificationReceipts'] = []; const origins: z.infer<typeof ReceiptSchema>[] = [];
  const missing: string[] = []; const contradictions: string[] = []; let prerequisite = false; let configDigest: string | null = null; let correlated = false;
  const phase = (value: Phase) => options.onPhase?.(value);
  const cancel = () => lifecycle.cancel(lease.ownerId);
  if (options.signal?.aborted) cancel(); else options.signal?.addEventListener('abort', cancel, { once: true });
  const headers = { 'x-demo-run-token': credentials.runner };
  const captureRead = (role: 'before' | 'after', path: string, requestId: string, response: { status: number; latencyMs: number; rayId: string | null; excerpt: string }) => {
    save('http', role, requestId, ObservationSchema.parse({ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'turnstile', targetRole: role, mode: options.mode, observedAt: iso(), method: 'GET', path, status: response.status, latencyMs: response.latencyMs, rayId: response.rayId, action: null, ruleId: null, originCount: null, excerpt: response.excerpt }));
  };
  const readConfig = async () => {
    const configs = [];
    for (const role of ['before', 'after'] as const) {
      const env = options.config.environments.find(e => e.role === role)!;
      const requestId = randomUUID();
      const response = await client().requestJson({ url: `${env.origin}/internal/registration-config`, kind: role, headers: { ...headers, 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'turnstile' } }, ConfigResponse, lifecycle.signal);
      if (response.status !== 200 || response.data.role !== role || response.data.releaseDigest !== env.releaseDigest || !response.data.config) throw new Error('Registration configuration unavailable');
      captureRead(role, '/internal/registration-config', requestId, response);
      const wanted = role === 'after' ? expected : { mode: 'disabled', sitekey: null, hostname: new URL(env.origin).hostname, action: 'register' };
      if (digestValue(response.data.config) !== digestValue(wanted)) { contradictions.push('Deployed registration configuration differs from the declared mode or hostname'); throw new Error('Registration configuration mismatch'); }
      configs.push(response.data);
    }
    const digest = digestValue(configs);
    save('configuration', 'after', null, { schemaVersion: 1, observedAt: iso(), releaseDigest: options.config.environments[1].releaseDigest, observedConfigDigest: digest, inventoryDigest: digestValue(options.config.inventory), state: 'observed' });
    return digest;
  };
  const register = async (role: 'before' | 'after', kind: Case['kind']) => {
    const requestId = randomUUID(); const recordId = randomUUID(); const env = options.config.environments.find(e => e.role === role)!;
    const token = kind === 'missing' ? null : kind === 'invalid' ? invalid : positive;
    const response = await client().request({ url: `${env.origin}/register`, kind: role, method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'turnstile' }, body: JSON.stringify({ record_id: recordId, display_name: 'synthetic-shopper', note: 'Synthetic only', turnstileToken: token }) }, lifecycle.signal);
    cases.push({ role, kind, requestId, recordId, status: response.status });
    const observation = ObservationSchema.parse({ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'turnstile', targetRole: role, mode: options.mode, observedAt: iso(), method: 'POST', path: '/register', status: response.status, latencyMs: response.latencyMs, rayId: response.rayId, action: null, ruleId: null, originCount: null, excerpt: response.excerpt });
    save('http', role, requestId, observation); options.onObservation?.(observation);
    const accepted = role === 'before' || kind === 'positive';
    if (accepted ? response.status === 403 || response.status === 400 : response.status >= 200 && response.status < 300) contradictions.push(`${role} ${kind} registration contradicts the expected application result`);
    if (response.status !== (accepted ? 201 : 403)) missing.push(`${role} ${kind} application response is incomplete`);
  };
  const collect = async () => {
    const end = iso();
    for (const role of ['before', 'after'] as const) {
      const env = options.config.environments.find(e => e.role === role)!;
      const requestId = randomUUID();
      const response = await client().requestJson({ url: `${env.origin}/internal/registration-evidence?runId=${runId}`, kind: role, headers: { ...headers, 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'turnstile' } }, EvidenceResponse, lifecycle.signal);
      const data = response.data;
      if (response.status !== 200 || data.targetRole !== role || data.runId !== runId || data.truncated) throw new Error('Verification evidence scope or completeness failed');
      captureRead(role, '/internal/registration-evidence', requestId, response);
      const own = cases.filter(c => c.role === role);
      if (data.receipts.length !== own.length || data.records.length !== own.length || new Set(data.receipts.map(r => r.requestId)).size !== own.length || new Set(data.records.map(r => r.requestId)).size !== own.length) throw new Error('Verification evidence join is incomplete or ambiguous');
      for (const item of own) {
        const receipt = data.receipts.find(r => r.requestId === item.requestId); const record = data.records.find(r => r.requestId === item.requestId);
        if (!receipt || !record || receipt.runId !== runId || receipt.targetRole !== role || receipt.recordId !== item.recordId || record.recordId !== item.recordId || receipt.observedAt < startedAt || receipt.observedAt > end || receipt.verificationMode !== (role === 'before' ? 'disabled' : expected.mode)) throw new Error('Foreign verification receipt rejected');
        receipts.push(receipt);
        const accepted = role === 'before' || item.kind === 'positive'; const reason = role === 'before' ? 'baseline-only' : item.kind === 'positive' ? 'accepted' : item.kind;
        if (receipt.reason === 'unavailable') missing.push('Server-side Siteverify was unavailable');
        else if (receipt.accepted !== accepted || receipt.reason !== reason || receipt.persisted !== accepted || record.exists !== accepted) contradictions.push(`${role} ${item.kind} verifier or persistence contradicts the proof contract`);
        if (!accepted && (receipt.accepted || receipt.persisted || record.exists)) contradictions.push('Rejected registration was accepted or persisted');
        if (receipt.siteverifyCalls !== (role === 'after' && (item.kind === 'invalid' || item.kind === 'positive') ? 1 : 0)) missing.push('Server-side verification call count is unproven');
        // Full receipts, including disabled mode, are retained in the authenticated
        // evidence-read artifact. The compact verification view is for shared UI.
        if (receipt.verificationMode !== 'disabled') save('verification', role, item.requestId, { kind: 'verification', accepted: receipt.accepted, verificationMode: receipt.verificationMode, policyId: '/register', reason: `${receipt.reason}; persisted=${receipt.persisted}; siteverifyCalls=${receipt.siteverifyCalls}; recordId=${receipt.recordId}` });
      }
      const origin = await client().requestJson({ url: `${options.config.telemetryOrigin}/receipts?${new URLSearchParams({ role, runId, scenarioId: 'turnstile', start: startedAt, end })}`, kind: 'telemetry', headers: { authorization: `Bearer ${credentials.collector}` } }, OriginResponse, lifecycle.signal);
      if (origin.status !== 200 || origin.data.runId !== runId || origin.data.targetRole !== role || origin.data.coverage.windowStart !== startedAt) throw new Error('Origin receipt scope mismatch');
      if (!origin.data.coverage.healthy || origin.data.coverage.gaps.length) missing.push('Origin telemetry health is incomplete');
      for (const receipt of origin.data.receipts) {
        if (receipt.runId !== runId || receipt.scenarioId !== 'turnstile' || receipt.targetRole !== role || receipt.releaseDigest !== env.releaseDigest || receipt.observedAt < startedAt || receipt.observedAt > end || !own.some(c => c.requestId === receipt.requestId)) throw new Error('Foreign origin receipt rejected');
        origins.push(receipt); save('origin', role, receipt.requestId, receipt);
      }
      for (const item of own) {
        const reached = origins.some(r => r.targetRole === role && r.requestId === item.requestId && r.stage === 'entry');
        if (role === 'after' && item.kind !== 'positive' && reached) contradictions.push('Rejected registration reached the Container');
        if ((role === 'before' || item.kind === 'positive') && !reached) missing.push('Accepted registration has no correlated Container receipt');
      }
    }
    correlated = true;
  };
  const evaluate = (): Decision => ({ mode: options.mode, outcome: contradictions.length ? 'failed' : prerequisite ? 'unavailable' : missing.length || !correlated || !configDigest ? 'inconclusive' : 'verified', missingProof: [...new Set(missing)], contradictions: [...new Set(contradictions)] });
  let execution: Awaited<ReturnType<RunLifecycle['execute']>>;
  try {
    execution = await lifecycle.execute({
      preflight: async () => {
        phase('preflight'); options.onStarted?.({ runId, stop: cancel }); lifecycle.signal.throwIfAborted();
        if (options.ownershipPreflight) {
          const discovery = new GuardedClient(options.config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), redactor: redactor(), ...(options.dispatch ? { dispatch: options.dispatch } : {}) });
          observed = await options.ownershipPreflight.run(discovery, lifecycle.signal);
          assertLiveReady(options.config, observed);
        }
        try { configDigest = await readConfig(); } catch { prerequisite = !contradictions.length; missing.push('Current registration configuration is unavailable'); throw new Error('Configuration not ready'); }
        if (!positive || positive.length > 2048) { prerequisite = true; missing.push('Authorized positive control token is unavailable'); throw new Error('Positive control unavailable'); }
        for (const role of ['before', 'after'] as const) lifecycle.trackOwned(`${runId}:${role}:registrations`, lease.ownerId, async signal => {
          phase('cleanup'); const env = options.config.environments.find(e => e.role === role)!;
          const response = await client().requestJson({ url: `${env.origin}/internal/registrations/cleanup`, kind: role, method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ runId }) }, z.strictObject({ cleaned: z.literal(true), runId: Id }), signal);
          if (response.status !== 200 || response.data.runId !== runId) throw new Error('Owned cleanup not acknowledged');
        });
      },
      baseline: async () => { phase('baseline'); for (const kind of ['missing', 'invalid', 'positive'] as const) await register('before', kind); },
      protected: async () => {
        phase('protected');
        for (const kind of ['missing', 'invalid', 'positive', 'replay'] as const) {
          // Cloudflare's always-pass test secret accepts any token, so a live test-mode run cannot observe an invalid-token rejection.
          if (kind === 'invalid' && options.mode === 'live' && expected.mode === 'test') continue;
          await register('after', kind);
        }
      },
      correlate: async () => { phase('correlate'); await collect(); const final = await readConfig(); if (final !== configDigest) contradictions.push('Registration configuration changed during the run'); },
      report: async () => { phase('report'); },
    });
  } finally { options.signal?.removeEventListener('abort', cancel); }
  if (!correlated) missing.push('Complete server-side verification and origin correlation is missing');
  if (execution.executionFailed || lifecycle.interrupted.value) { missing.push('Run stopped before all required checks completed'); configDigest = null; }
  if (execution.cleanup === 'incomplete') missing.push('Owned registration cleanup is incomplete');
  if (options.mode === 'live' && expected.mode === 'test') missing.push('TEST MODE cannot verify live production-mode enforcement');
  const decision = evaluate(); phase('finished');
  const result = ResultSchema.parse({ schemaVersion: 1, runId, scenarioId: 'turnstile', outcome: decision.outcome, missingProof: decision.missingProof, contradictions: decision.contradictions, evidence: refs, releaseDigest: options.config.environments[0].releaseDigest, observedConfigDigest: configDigest, startedAt, finishedAt: iso(), requestsUsed: ledger.snapshot.requestsUsed, peakConcurrency: ledger.snapshot.peakConcurrency, sessionsUsed: 0, cleanup: execution.cleanup });
  const report: Report = { schemaVersion: 1, mode: options.mode, manifestVersion: manifest.version, createdAt: iso(), result, notes: { ...manifest.notes, limitations: `${manifest.notes.limitations} Application-side verification, not an edge block. ${expected.mode === 'test' ? 'TEST MODE; no production-mode enforcement claim.' : 'Live mode requires matching server-side verification.'}` } };
  return { report, artifacts, decision, verificationMode: expected.mode, attribution: 'application-side', verificationReceipts: receipts, leftovers: execution.leftovers };
}
