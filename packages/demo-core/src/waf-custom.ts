import { z } from 'zod';
import { readBotConfiguration, BOT_USER_AGENT } from './bot-policy.js';
import { randomUUID } from 'node:crypto';
import { CoverageSchema, ObservationSchema, ReceiptSchema, ResultSchema, type Receipt } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { scenario } from '../../../scenarios/catalog.js';
import { BudgetLedger, limitsFor, validatePlan, type Clock, type Limits } from './budget.js';
import { LabLease, RunLifecycle, type Phase } from './lifecycle.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { CloudflareReader } from './cloudflare.js';
import { desiredCustomWaf, inspectCustomWaf, CUSTOM_WAF_SOURCES } from './custom-waf.js';
import { evaluateEdgeProof, type Decision, type EdgeProof } from './proof.js';
import { makeArtifact, type Artifact, type Report } from './reports.js';
import { digestValue } from './deployment-plan.js';
import { desiredRateLimit, inspectRateLimit, rateReader, RATE_SOURCES } from './rate-policy.js';
import { planRateBurst, RateCooldown } from './rate-window.js';
import { PolicyModule, WafModule } from './product-state.js';
import { observedWafPolicies } from './waf-modules.js';
import { assertLiveReady, validateLabConfig, type LabConfig } from './config.js';
const OriginResponse = z.strictObject({ schemaVersion: z.literal(1), targetRole: z.enum(['before', 'after']), runId: z.uuid(), scenarioId: PolicyModule, originCount: z.number().int().nonnegative().nullable(), receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema });
export interface WafCustomOptions {
  scenarioId?: z.infer<typeof PolicyModule>;
  projectRoot: string; config: LabConfig; observedOwnedResources?: ReadonlySet<string>;
  ownershipPreflight?: { minimumRequests: number; run: (client: GuardedClient, signal: AbortSignal) => Promise<ReadonlySet<string>> };
  signal?: AbortSignal;
  mode: 'live' | 'fixture'; credentials: { reader: string; collector: string; runner: string };
  limits?: Partial<Limits>; parent?: BudgetLedger; dispatch?: Dispatch; clock?: Clock; now?: () => number;
  idempotencyKey?: string;
  onStarted?: (value: { runId: string; stop: () => void }) => void;
  onPhase?: (phase: Phase) => void;
  onObservation?: (observation: z.infer<typeof ObservationSchema>) => void;
  onEvidence?: (artifact: Artifact) => void;
}
function pause(ledger: BudgetLedger, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Stopped')); return; }
    const abort = () => { cancel(); signal.removeEventListener('abort', abort); reject(new Error('Stopped')); };
    const cancel = ledger.clock.schedule(ms, () => { signal.removeEventListener('abort', abort); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function runWafCustom(options: WafCustomOptions): Promise<{ report: Report; artifacts: Artifact[]; decision: Decision }> {
  z.enum(['live', 'fixture']).parse(options.mode);
  const scenarioId = PolicyModule.parse(options.scenarioId ?? 'waf-custom'); const MANIFEST = scenario(scenarioId); const isRate = scenarioId === 'rate-limit'; const isBot = scenarioId === 'bot';
  const credentials = z.strictObject({ reader: z.string().min(24), collector: z.string().min(24), runner: z.string().min(24) }).parse(options.credentials);
  if (options.mode === 'fixture' && !options.dispatch) throw new Error('Fixture runs require an injected transport');
  const values = Object.values(credentials);
  if (values.some(v => v.length < 24) || new Set(values).size !== values.length) throw new Error('Separate reader, collector and runner credentials required');
  validateLabConfig(options.config, options.projectRoot);
  if (!options.config.liveOptIn) throw new Error('Explicit owned-lab run opt-in required');
  if (!options.ownershipPreflight) {
    if (!options.observedOwnedResources) throw new Error('Observed ownership or a fresh read-only preflight is required');
    assertLiveReady(options.config, options.observedOwnedResources);
  }
  const ownershipRequests = z.number().int().min(0).max(100).parse(options.ownershipPreflight?.minimumRequests ?? 0);
  const wafDesired = desiredCustomWaf(options.config.labId, options.config.environments[1].origin, isRate ? 'waf-custom' : WafModule.parse(scenarioId));
  const rateDesired = desiredRateLimit(options.config.labId, options.config.environments[1].origin);
  const desired = isRate ? rateDesired : wafDesired;
  const limits = limitsFor('scenario', { ...MANIFEST.budget, ...options.limits }); validatePlan(limits, MANIFEST.minimumRequests + ownershipRequests, 0, 1000);
  const now = options.now ?? Date.now; const iso = () => new Date(now()).toISOString(); const startedAt = iso();
  const ledger = new BudgetLedger({ limits, ...(options.clock ? { clock: options.clock } : {}), ...(options.parent ? { parent: options.parent } : {}) });
  let claim: ReturnType<typeof LabLease.claim>;
  try { claim = LabLease.claim({ projectRoot: options.projectRoot, evidenceDirectory: options.config.evidenceDirectory, labId: options.config.labId, idempotencyKey: options.idempotencyKey ?? randomUUID() }); }
  catch (error) { ledger.stop(); throw error; }
  if (claim.kind !== 'claimed') { ledger.stop(); throw new Error('Run already owns the lab; no duplicate traffic was sent'); }
  const lease = claim.lease;
  const lifecycle = new RunLifecycle(lease, ledger); const runId = lifecycle.runId;
  const redactor = new Redactor(values);
  const client = new GuardedClient(options.config, ledger, { purpose: options.ownershipPreflight ? 'discovery' : 'runtime', observedOwnedResources: options.observedOwnedResources ?? new Set(), ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor });
  let traffic: GuardedClient | undefined = options.ownershipPreflight ? undefined : client;
  const cancel = () => lifecycle.cancel(lease.ownerId);
  if (options.signal?.aborted) cancel(); else options.signal?.addEventListener('abort', cancel, { once: true });
  const cloudflare = new CloudflareReader(client, credentials.reader);
  const artifacts = new Map<string, Artifact>(); const refs: ReturnType<typeof makeArtifact>['ref'][] = [];
  const save = (source: Artifact['source'], role: 'before' | 'after', requestId: string | null, payload: Artifact['payload'], observedAt = iso(), id: string = randomUUID()) => {
    const item = makeArtifact({ id, source, mode: options.mode, runId, scenarioId, targetRole: role, requestId, observedAt, payload }, redactor);
    if (!artifacts.has(id)) { artifacts.set(id, item.artifact); refs.push(item.ref); options.onEvidence?.(item.artifact); }
    return item.ref;
  };
  const observations: z.infer<typeof ObservationSchema>[] = [];
  const controls: z.infer<typeof ObservationSchema>[] = [];
  let baseline: z.infer<typeof ObservationSchema> | undefined; let protectedRequest: z.infer<typeof ObservationSchema> | undefined;
  const inspectPolicy = () => isRate ? inspectRateLimit(rateReader(client, credentials.reader), rateDesired, lifecycle.signal) : inspectCustomWaf({ entrypoint: signal => cloudflare.customWafEntrypoint(signal) }, wafDesired, lifecycle.signal);
  let configuration: Awaited<ReturnType<typeof inspectPolicy>> | undefined;
  let botConfig: Awaited<ReturnType<typeof readBotConfiguration>> | null = null; let botScore: number | null = null; let botAction: string | null = null;
  const rateSignals: { before: z.infer<typeof ObservationSchema>[]; after: z.infer<typeof ObservationSchema>[] } = { before: [], after: [] };
  let burst: ReturnType<typeof planRateBurst> | undefined; let cooldown: RateCooldown | undefined; let cooldownUntil: string | null = null;
  const captureConfiguration = (value: Awaited<ReturnType<typeof inspectPolicy>>) => value.rule && value.ruleset ? save('configuration', 'after', null, { kind: 'configuration', product: isRate ? 'Rate limiting' : 'Custom WAF rules', ...(isBot && botConfig ? { botManagement: botConfig } : {}), ...('ratelimit' in value.rule ? { rateLimit: value.rule.ratelimit } : {}), rulesetId: value.ruleset.id, rulesetVersion: value.ruleset.version, ruleId: value.rule.id, ref: value.rule.ref ?? desired.ref, enabled: value.rule.enabled ?? true, action: value.rule.action, expression: value.rule.expression, afterHostname: desired.hostname, order: value.ruleset.rules.findIndex(rule => rule.id === value.rule!.id) + 1 }) : undefined;
  let configRef: ReturnType<typeof save> | undefined; let configChanged = false; let finalConfigUnknown = false;
  let receipts: Receipt[] = [];
  let coverage = CoverageSchema.parse({ healthy: false, complete: false, windowStart: startedAt, watermark: null, producerSequence: null, gaps: ['No complete origin observation'] });
  let events: EdgeProof['events'] = [];
  let preflightOutcome: 'failed' | 'unavailable' | undefined;
  const problems: string[] = [];
  let decision: Decision = { outcome: 'inconclusive', mode: options.mode, missingProof: ['No completed comparison'], contradictions: [] };
  const phase = (value: Phase) => options.onPhase?.(value);
  const target = async (role: 'before' | 'after', signature: boolean) => {
    const requestId = randomUUID(); const headers: Record<string, string> = { 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': scenarioId, 'x-demo-run-token': credentials.runner };
    if (isBot) headers['user-agent'] = BOT_USER_AGENT;
    if (signature) { headers['x-demo-test'] = desired.marker; if (isRate && role === 'after' && cooldown && burst) cooldownUntil = cooldown.note(runId, burst.quietMs); }
    const origin = options.config.environments.find(e => e.role === role)!.origin;
    const response = await traffic!.request({ url: `${origin}${isRate ? '/api' : '/catalog'}`, kind: role, headers }, lifecycle.signal);
    const observation = ObservationSchema.parse({ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId, targetRole: role, mode: options.mode, observedAt: iso(), method: 'GET', path: isRate ? '/api' : '/catalog', status: response.status, latencyMs: response.latencyMs, rayId: response.rayId, action: null, ruleId: null, originCount: null, excerpt: response.excerpt });
    observations.push(observation); save('http', role, requestId, observation, observation.observedAt, observation.id); options.onObservation?.(observation);
    return observation;
  };
  const collect = async () => {
    const end = iso(); const collected: Receipt[] = [];
    for (const role of ['before', 'after'] as const) {
      const environment = options.config.environments.find(e => e.role === role)!;
      await traffic!.request({ url: `${environment.origin}/internal/checkpoint?${new URLSearchParams({ scenarioId, runId })}`, kind: role, headers: { 'x-demo-run-token': credentials.runner } }, lifecycle.signal);
      const response = await traffic!.requestJson({ url: `${options.config.telemetryOrigin}/receipts?${new URLSearchParams({ role, runId, scenarioId, start: startedAt, end })}`, kind: 'telemetry', headers: { authorization: `Bearer ${credentials.collector}` } }, OriginResponse, lifecycle.signal);
      const data = response.data;
      if (response.status !== 200 || data.targetRole !== role || data.runId !== runId || data.scenarioId !== scenarioId || data.coverage.windowStart !== startedAt) throw new Error('Origin receipt scope mismatch');
      for (const receipt of data.receipts) {
        if (receipt.runId !== runId || receipt.scenarioId !== scenarioId || receipt.targetRole !== role || receipt.releaseDigest !== environment.releaseDigest || receipt.observedAt < startedAt || receipt.observedAt > end) throw new Error('Foreign or stale receipt rejected');
        collected.push(receipt); save('origin', role, receipt.requestId, receipt, receipt.observedAt, receipt.id);
      }
      save('origin', role, null, data.coverage);
      if (role === 'after') coverage = data.coverage;
    }
    receipts = collected;
    events = []; botScore = null; botAction = null;
    if (protectedRequest?.rayId) {
      const query = await cloudflare.securityEvents({ zoneId: options.config.zoneId, start: startedAt, end, rayId: protectedRequest.rayId.split('-')[0]!, hostname: desired.hostname, limit: 10, ...(isBot ? { botScore: true } : {}) }, lifecycle.signal);
      if (!query.ambiguous && query.complete) for (const event of query.events) {
        const evidence = save('cloudflare', 'after', protectedRequest.requestId, { kind: 'edge', rayId: event.rayName, action: event.action, ruleId: event.ruleId, product: event.source, hostname: event.clientRequestHTTPHost, eventTime: event.datetime, sampling: 'unknown', ...(isBot ? { botScore: event.botScore ?? null } : {}) }, event.datetime);
        if (isBot && event.ruleId === configuration?.rule?.id && (CUSTOM_WAF_SOURCES as readonly string[]).includes(event.source)) { botScore = event.botScore && event.botScore > 0 ? event.botScore : null; botAction = event.action; }
        events.push({ rayId: event.rayName, action: event.action, ruleId: event.ruleId, source: event.source, observedAt: event.datetime, evidence });
      }
    }
  };
  const evaluate = (): Decision => {
    if (preflightOutcome) return { outcome: preflightOutcome, mode: options.mode, missingProof: [...problems], contradictions: preflightOutcome === 'failed' ? ['Configured policy differs from the owned contract'] : [] };
    if (!baseline || !protectedRequest || controls.length !== 2 || !configuration?.rule || !configRef) return { outcome: 'inconclusive', mode: options.mode, missingProof: [...problems, 'Comparison or configuration proof is incomplete'], contradictions: [] };
    const sources = isRate ? RATE_SOURCES : CUSTOM_WAF_SOURCES;
    const allowed = events.find(e => e.ruleId === configuration!.rule!.id && (sources as readonly string[]).includes(e.source));
    const base = evaluateEdgeProof({ runId, scenarioId, mode: options.mode, baseline, protected: protectedRequest, controls, receipts, coverage, expectedRuleId: configuration.rule.id, expectedAction: 'block', expectedSource: allowed?.source ?? sources[0], config: finalConfigUnknown ? null : { enabled: configuration.rule.enabled ?? true, scopeMatches: configuration.state.owned && !configChanged, ruleId: configuration.rule.id, action: configuration.rule.action, evidence: configRef }, events, httpEvidence: refs.filter(r => r.source === 'http'), originEvidence: refs.filter(r => r.source === 'origin'), unavailable: [], skipped: false });
    if (isBot && base.outcome === 'verified' && (botScore === null || botScore >= 30)) return { ...base, outcome: botScore === null ? 'inconclusive' : 'failed', missingProof: [...base.missingProof, 'Matching Bot Management classification score is unavailable or outside the declared threshold'] };
    if (isRate && burst) {
      const early = rateSignals.after.slice(0, -1).some(o => o.status === 429);
      const receiptFor = (o: z.infer<typeof ObservationSchema>) => receipts.some(r => r.stage === 'entry' && r.requestId === o.requestId && r.targetRole === o.targetRole);
      const admitted = [...rateSignals.before, ...rateSignals.after.slice(0, -1)];
      const colos = rateSignals.after.map(o => o.rayId?.split('-')[1]);
      const withinWindow = rateSignals.after.length === burst.signals && Date.parse(rateSignals.after.at(-1)!.observedAt) - Date.parse(rateSignals.after[0]!.observedAt) < burst.windowMs && colos.every(c => !!c && c === colos[0]);
      if (base.outcome !== 'failed' && (early || !withinWindow || !admitted.every(o => o.status === 200 && receiptFor(o)) || protectedRequest.status !== 429)) return { ...base, outcome: 'inconclusive', missingProof: [...base.missingProof, early ? 'Shared IP counting key may contain foreign traffic; threshold proof is contaminated' : 'Admitted signals, stable colo/window or expected threshold crossing are unproven'] };
    }
    return { ...base, missingProof: [...base.missingProof, ...(base.outcome === 'verified' ? [] : problems)] };
  };
  const execution = await lifecycle.execute({
    preflight: async () => {
      options.onStarted?.({ runId, stop: () => lifecycle.cancel(lease.ownerId) }); phase('preflight');
      let owned: ReadonlySet<string> | undefined = options.observedOwnedResources;
      try {
        if (options.ownershipPreflight) owned = await options.ownershipPreflight.run(client, lifecycle.signal);
        if (isBot) botConfig = await readBotConfiguration(client, credentials.reader, lifecycle.signal);
        configuration = await inspectPolicy();
      }
      catch { if (!lifecycle.signal.aborted) { preflightOutcome = 'unavailable'; problems.push('Current lab ownership or selected policy readback is unavailable'); } throw new Error('Preflight stopped'); }
      if (!configuration.rule || !configuration.ruleset) { preflightOutcome = 'unavailable'; problems.push('Expected owned policy rule is absent'); throw new Error('Preflight stopped'); }
      configRef = captureConfiguration(configuration);
      if (!configuration.state.owned || !configuration.state.enabled) { preflightOutcome = 'failed'; problems.push('Rule ownership, scope or enabled action differs'); throw new Error('Preflight stopped'); }
      const known = new Set(owned);
      const waf = isRate ? await cloudflare.customWafEntrypoint(lifecycle.signal) : configuration.ruleset;
      if (waf && waf.phase === 'http_request_firewall_custom') for (const id of observedWafPolicies(options.config, waf)) known.add(id);
      if (isRate) known.add(`policy:after:${configuration.rule.id}`);
      else if (options.config.rateLimitRuleId) { const sibling = await inspectRateLimit(rateReader(client, credentials.reader), rateDesired, lifecycle.signal); if (sibling.state.owned && sibling.rule?.id === options.config.rateLimitRuleId) known.add(`policy:after:${sibling.rule.id}`); }
      if (isRate && 'ratelimit' in configuration.rule) try {
        burst = planRateBurst(configuration.rule.ratelimit, limits, ledger.snapshot.requestsUsed);
        cooldown = new RateCooldown(options.projectRoot, options.config.evidenceDirectory, options.config.labId, now);
        const wait = cooldown.remaining(); if (ledger.clock.now() + wait + 1000 >= ledger.workDeadline) throw new Error('Cooldown cannot fit the remaining runtime');
        if (wait) await pause(ledger, wait, lifecycle.signal);
      } catch { preflightOutcome = 'unavailable'; problems.push('Rate threshold, counting key or shared-IP cooldown cannot fit the bounded plan'); throw new Error('Rate preflight stopped'); }
      assertLiveReady(options.config, known);
      if (!traffic) traffic = new GuardedClient(options.config, ledger, { observedOwnedResources: known, ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor });
    },
    baseline: async () => { phase('baseline'); controls.push(await target('before', false)); for (let i = 0; i < (burst?.signals ?? 1); i++) { baseline = await target('before', true); if (isRate) rateSignals.before.push(baseline); } },
    protected: async () => { phase('protected'); controls.push(await target('after', false)); for (let i = 0; i < (burst?.signals ?? 1); i++) { protectedRequest = await target('after', true); if (isRate) rateSignals.after.push(protectedRequest); } },
    correlate: async () => {
      phase('correlate');
      if (options.mode === 'live' && ledger.clock.now() + 2000 < ledger.workDeadline) await pause(ledger, 2000, lifecycle.signal);
      // Cloudflare's adaptive firewall-event log lags the request by tens of seconds to minutes.
      const step = options.mode === 'live' ? 8000 : 1000;
      for (let round = 0; round < (options.mode === 'live' ? 5 : 4); round++) {
        try { await collect(); } catch { problems.push('An evidence source is incomplete or unavailable'); }
        decision = evaluate();
        if (decision.outcome === 'verified' || decision.outcome === 'failed' || !protectedRequest?.rayId || ledger.snapshot.requestsUsed + 6 + ledger.limits.cleanupRequests > ledger.limits.requests || ledger.clock.now() + step * 2 ** round >= ledger.workDeadline) break;
        await pause(ledger, step * 2 ** round, lifecycle.signal);
      }
      try {
        const final = await inspectPolicy();
        configChanged = final.state.digest !== configuration!.state.digest;
        if (isBot) { const latest = await readBotConfiguration(client, credentials.reader, lifecycle.signal); configChanged ||= digestValue(latest) !== digestValue(botConfig); botConfig = latest; }
        captureConfiguration(final);
      } catch { finalConfigUnknown = true; problems.push('Final policy readback is unavailable'); }
    },
    report: async () => { phase('report'); decision = evaluate(); },
  });
  options.signal?.removeEventListener('abort', cancel);
  if ((execution.executionFailed || lifecycle.interrupted.value) && decision.outcome === 'verified') decision = { ...decision, outcome: 'inconclusive', missingProof: [...decision.missingProof, 'Run interrupted before complete reporting'] };
  if (execution.cleanup === 'incomplete') decision = { ...decision, outcome: decision.outcome === 'failed' ? 'failed' : 'inconclusive', missingProof: [...decision.missingProof, 'Owned cleanup incomplete'] };
  phase('finished');
  const result = ResultSchema.parse({ schemaVersion: 1, runId, scenarioId, outcome: decision.outcome, evidence: refs, missingProof: [...new Set(decision.missingProof)], contradictions: decision.contradictions, releaseDigest: options.config.environments[0].releaseDigest, observedConfigDigest: configuration?.state.owned && !configChanged && !finalConfigUnknown ? isBot ? digestValue({ rule: configuration.state.digest, bot: botConfig }) : configuration.state.digest : null, startedAt, finishedAt: iso(), requestsUsed: ledger.snapshot.requestsUsed, peakConcurrency: ledger.snapshot.peakConcurrency, sessionsUsed: 0, cleanup: execution.cleanup });
  const report: Report = { schemaVersion: 1, mode: options.mode, manifestVersion: MANIFEST.version, createdAt: iso(), result, ...(isBot ? { botSummary: { userAgent: BOT_USER_AGENT, score: botScore, action: botAction, classification: botScore !== null && botScore < 30 ? 'automated' as const : 'unknown' as const, subscriptionReadback: botConfig ? 'available' as const : 'unavailable' as const } } : {}), ...(isRate ? { rateLimitSummary: { admitted: rateSignals.after.length ? rateSignals.after.filter(o => o.status === 200 && receipts.some(r => r.stage === 'entry' && r.requestId === o.requestId)).length : null, mitigated: protectedRequest && decision.outcome === 'verified' ? 1 : null, unknown: rateSignals.after.length ? rateSignals.after.filter(o => o.status !== 200 || !receipts.some(r => r.stage === 'entry' && r.requestId === o.requestId)).length - (decision.outcome === 'verified' ? 1 : 0) : null, sharedKeyContamination: rateSignals.after.slice(0, -1).some(o => o.status === 429) ? 'suspected' as const : decision.outcome === 'verified' ? 'not-observed' as const : 'unknown' as const, cooldownUntil } } : {}), notes: { problem: MANIFEST.notes.problem, solution: MANIFEST.notes.solution, limitations: MANIFEST.notes.limitations, question: MANIFEST.notes.question } };
  return { report, artifacts: [...artifacts.values()], decision };
}
