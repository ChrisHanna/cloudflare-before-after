import { z } from 'zod';
import { ReceiptSchema, type Receipt } from '../../contracts/src/schemas.js';
import { BudgetLedger, validatePlan, type Limits } from './budget.js';
import { BrowserTransport, isDocumentedQueueObservation, isOwnedBrowserObservation, type BrowserFrame, type BrowserFrameScope, type BrowserRole, type QueueDetection } from './browser-transport.js';

// Setup declaration only. The scenario has no infrastructure writer dependency.
export const WaitingRoomSettingsSchema = z.strictObject({
  hostname: z.string().regex(/^[a-z0-9.-]+\.[a-z]+$/),
  path: z.string().regex(/^\/[a-zA-Z0-9/_-]*$/),
  total_active_users: z.number().int().min(200).max(1000000),
  new_users_per_minute: z.number().int().min(200).max(1000000),
  session_duration: z.number().int().min(1).max(30),
  suspended: z.literal(false), queue_all: z.literal(false),
});
export type WaitingRoomSettings = z.infer<typeof WaitingRoomSettingsSchema>;
/** Reviewed expectations, not observations or a promise of admission. */
export const WaitingRoomExecutionSchema = z.strictObject({
  queueContract: z.literal('cloudflare-json-v1'),
  expectedTransitionMs: z.number().int().positive().max(110000),
  perNavigationRequests: z.number().int().min(1).max(10), refreshes: z.number().int().min(1).max(8),
  queueSelector: z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value)),
  storefrontSelector: z.string().min(1).max(256).refine(value => !/[\r\n\0]/.test(value)),
}).superRefine((value, ctx) => {
  // The actual runner rechecks its full graph. Reject even the maximum scenario
  // envelope here, including paired inventory/policy reads and cleanup.
  const requests = (4 + value.refreshes) * (value.perNavigationRequests + 2) + 16;
  if (requests > 100) ctx.addIssue({ code: 'custom', message: 'Waiting Room execution cannot fit the hard request cap' });
});
export type WaitingRoomExecution = z.infer<typeof WaitingRoomExecutionSchema>;
export function waitingRoomSetupModule(settings: unknown) {
  return Object.freeze({ product: 'waiting-room' as const, optional: true as const, phase: 'setup-only' as const,
    capability: 'waiting-room', settings: Object.freeze(WaitingRoomSettingsSchema.parse(settings)) });
}
export interface WaitingRoomPlan {
  path: string; productId: string; expectedTransitionMs: number;
  perNavigationRequests: number; refreshes: number; telemetryRequests: number;
  interview: boolean;
}
export function planWaitingRoom(plan: WaitingRoomPlan, limits: Limits): { sessions: 3; workRequests: number; minimumWorkMs: number } {
  if (!/^\/[a-zA-Z0-9/_-]*$/.test(plan.path) || !/^[a-zA-Z0-9_-]{1,128}$/.test(plan.productId)) throw new Error('Invalid synthetic launch route/product');
  for (const n of [plan.expectedTransitionMs, plan.perNavigationRequests, plan.refreshes, plan.telemetryRequests]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid Waiting Room plan');
  if (plan.perNavigationRequests < 1 || plan.refreshes < 1 || plan.expectedTransitionMs < 1) throw new Error('Plan must include actual queue refresh and bounded transition');
  const workRequests = (4 + plan.refreshes) * plan.perNavigationRequests + plan.telemetryRequests;
  const minimumWorkMs = plan.expectedTransitionMs;
  validatePlan(limits, workRequests, 3, minimumWorkMs);
  if (limits.maxRuntimeMs > 120000 || (plan.interview && limits.maxRuntimeMs > 75000)) throw new Error('Waiting Room cannot fit its scenario/interview slot');
  return { sessions: 3, workRequests, minimumWorkMs };
}
export type WaitingRoomState = 'created' | 'navigating' | 'queued' | 'admitted' | 'unknown' | 'error' | 'closed';
export interface WaitingRoomSession {
  sessionId: string; role: BrowserRole; state: WaitingRoomState; lastObservedState: WaitingRoomState;
  queuePosition: null; estimatedWaitMs: null; cookieContinuity: boolean;
  transitions: { from: WaitingRoomState; to: WaitingRoomState; observedAt: string; requestId: string | null }[];
}
export interface WaitingRoomObservation {
  sessionId: string; requestId: string | null; observedAt: string;
  queue: boolean; storefront: boolean; queueCookiePresent: boolean;
  cookieContinuity: boolean; receipts: readonly Receipt[];
  queueDetection?: QueueDetection; queueObservation?: object;
}
export interface WaitingRoomResult {
  mode: 'live' | 'fixture'; outcome: 'verified' | 'failed' | 'inconclusive' | 'unavailable';
  fixtureAssertionsPassed: boolean; liveReadiness: boolean;
  sessions: WaitingRoomSession[]; counts: { queued: number; admitted: number; unknown: number };
  missingProof: string[]; contradictions: string[];
  limitation: string;
}
export interface WaitingRoomPolicy {
  mode: 'live' | 'fixture'; state: 'observed' | 'desired' | 'unknown';
  matchesScope: boolean; queueContractQualified: boolean; releaseDigest: string;
}
/** Stateful proof builder: replacement sessions cannot inherit queue history. */
export class WaitingRoomStateMachine {
  readonly #sessions = new Map<string, WaitingRoomSession>();
  readonly #lastTimes = new Map<string, number>();
  readonly #ownership = new Map<string, BrowserFrameScope>();
  readonly #queuedAt = new Map<string, number>();
  readonly #admittedAt = new Map<string, number>();
  readonly #continued = new Set<string>();
  readonly #contradictions = new Set<string>();
  #overlap = false; #transition = false; #interrupted = false;
  constructor(readonly runId: string, readonly mode: 'live' | 'fixture', readonly policy: WaitingRoomPolicy) {}
  register(sessionId: string, role: BrowserRole, scope?: BrowserFrameScope): void {
    if (this.#sessions.has(sessionId) || this.#sessions.size >= 8) throw new Error('Duplicate or excess browser context');
    if (!/^session-[1-8]$/.test(sessionId) || !['before', 'after'].includes(role)) throw new Error('Invalid owned session label');
    if (scope) {
      if (scope.sessionId !== sessionId || scope.runId !== this.runId || scope.releaseDigest !== this.policy.releaseDigest) throw new Error('Foreign browser ownership');
      this.#ownership.set(sessionId, Object.freeze({ ...scope }));
    }
    this.#sessions.set(sessionId, { sessionId, role, state: 'created', lastObservedState: 'created', queuePosition: null, estimatedWaitMs: null, cookieContinuity: true, transitions: [] });
  }
  #move(session: WaitingRoomSession, state: WaitingRoomState, at: string, requestId: string | null): void {
    if (session.transitions.length >= 256 && state !== 'closed') throw new Error('Session observation cap reached');
    session.transitions.push({ from: session.state, to: state, observedAt: at, requestId }); session.state = state;
    if (state !== 'closed') session.lastObservedState = state;
  }
  navigating(id: string): void {
    const s = this.#sessions.get(id); if (!s || s.state === 'closed') throw new Error('Unknown or closed context');
    this.#move(s, 'navigating', new Date().toISOString(), null);
  }
  observe(observation: WaitingRoomObservation): void {
    const o = observation; const s = this.#sessions.get(o.sessionId);
    if (!s || s.state === 'closed') throw new Error('Observation from unknown or closed context');
    const time = Date.parse(o.observedAt);
    if (!Number.isFinite(time) || time < (this.#lastTimes.get(o.sessionId) ?? -Infinity)) throw new Error('Invalid observation time/order');
    this.#lastTimes.set(o.sessionId, time);
    const ownership = this.#ownership.get(o.sessionId);
    const browserScope = { ...(ownership ?? { ownerId: '', runId: this.runId, sessionId: o.sessionId, releaseDigest: this.policy.releaseDigest }), requestId: o.requestId, observedAt: o.observedAt, queue: o.queue, storefront: o.storefront, queueCookiePresent: o.queueCookiePresent, cookieContinuity: o.cookieContinuity };
    if (this.mode === 'live' && (!ownership || !isOwnedBrowserObservation(o.queueObservation ?? o, browserScope))) { this.#move(s, 'unknown', o.observedAt, o.requestId); return; }
    s.cookieContinuity &&= o.cookieContinuity;
    if (!o.cookieContinuity) this.#contradictions.add('Browser cookie continuity broken');
    if (o.queue && o.storefront) { this.#contradictions.add('Queue and storefront markers conflict'); this.#move(s, 'error', o.observedAt, o.requestId); return; }
    const qualifiedQueue = this.mode === 'fixture' ? this.policy.queueContractQualified : isDocumentedQueueObservation(o.queueObservation ?? o, browserScope);
    if (o.queue && o.queueCookiePresent && qualifiedQueue) {
      if (s.role === 'before') this.#contradictions.add('Baseline unexpectedly queued');
      this.#queuedAt.set(s.sessionId, time); this.#move(s, 'queued', o.observedAt, o.requestId);
      return;
    }
    const receipt = o.receipts.filter(r => ReceiptSchema.safeParse(r).success && r.runId === this.runId && r.scenarioId === 'waiting-room' && r.requestId === o.requestId && r.targetRole === s.role && r.stage === 'entry' && r.releaseDigest === this.policy.releaseDigest && Date.parse(r.observedAt) <= time);
    if (o.storefront && receipt.length === 1 && s.cookieContinuity) {
      const previousAdmission = this.#admittedAt.get(s.sessionId);
      if (previousAdmission !== undefined && s.transitions.some(t => t.to === 'admitted' && t.requestId !== o.requestId) && time > previousAdmission) this.#continued.add(s.sessionId);
      if ((this.#queuedAt.get(s.sessionId) ?? Infinity) < time && s.role === 'after') this.#transition = true;
      this.#admittedAt.set(s.sessionId, time); this.#move(s, 'admitted', o.observedAt, o.requestId);
      if (s.role === 'after' && this.#continued.has(s.sessionId) && [...this.#sessions.values()].some(q => q.sessionId !== s.sessionId && q.role === 'after' && q.state === 'queued')) this.#overlap = true;
      return;
    }
    this.#move(s, 'unknown', o.observedAt, o.requestId);
  }
  error(id: string): void { this.#interrupted = true; const s = this.#sessions.get(id); if (s && s.state !== 'closed') this.#move(s, 'error', new Date().toISOString(), null); }
  close(): void { for (const s of this.#sessions.values()) if (s.state !== 'closed') this.#move(s, 'closed', new Date().toISOString(), null); }
  result(): WaitingRoomResult {
    const sessions = structuredClone([...this.#sessions.values()]); const missingProof: string[] = [];
    if (!sessions.some(s => s.role === 'before' && s.transitions.some(t => t.to === 'admitted'))) missingProof.push('Baseline unqueued storefront and Container receipt');
    if (![...this.#queuedAt.keys()].some(id => this.#sessions.get(id)!.role === 'after')) missingProof.push('Qualified protected queue page');
    if (!this.#overlap) missingProof.push('Distinct admitted shopper continuing while another session queues');
    if (!this.#transition) missingProof.push('Same-context queued-to-admitted transition and Container receipt');
    if (this.#interrupted) missingProof.push('Run stopped before planned observations completed');
    if (this.mode === 'live' && !this.#queuedAt.size) missingProof.push('Unqualified queue: documented Cloudflare JSON signal absent; selectors are not live proof');
    if (this.policy.state !== 'observed' || !this.policy.matchesScope || this.policy.mode !== this.mode) missingProof.push('Matching observed Waiting Room policy scope');
    const contradictions = [...this.#contradictions];
    const complete = !missingProof.length && !contradictions.length;
    return { mode: this.mode, outcome: contradictions.length ? 'failed' : complete && this.mode === 'live' ? 'verified' : 'inconclusive', fixtureAssertionsPassed: complete && this.mode === 'fixture', liveReadiness: complete && this.mode === 'live', sessions,
      counts: { queued: sessions.filter(s => s.lastObservedState === 'queued').length, admitted: sessions.filter(s => s.lastObservedState === 'admitted').length, unknown: sessions.filter(s => ['created', 'navigating', 'unknown', 'error'].includes(s.lastObservedState)).length }, missingProof, contradictions,
      limitation: this.mode === 'fixture' ? 'FIXTURE: no live Cloudflare readiness proof. No origin overload claim.' : 'Observed queue and admission only; no origin overload claim.' };
  }
}
export interface WaitingRoomRunOptions {
  transport: BrowserTransport; ledger: BudgetLedger; plan: WaitingRoomPlan; signal?: AbortSignal;
  beforeOrigin: string; afterOrigin: string; machine: WaitingRoomStateMachine;
  selectors: { queue: string; storefront: string };
  receipts: (requestId: string | null, signal: AbortSignal, role: BrowserRole) => Promise<readonly Receipt[]>;
  onSnapshot?: (result: WaitingRoomResult) => void;
  onPreview?: (preview: import('./browser-transport.js').BrowserPreview) => void;
  /** Optional frame delivery; callers must retain at most one expiring frame per owned session. */
  onFrame?: (frame: BrowserFrame) => void;
  /** Optional already-budgeted collector: every remote lookup must use this same ledger. */
}
export interface AdmittedNavigationOptions {
  transport: BrowserTransport; machine: WaitingRoomStateMachine; scope: BrowserFrameScope; path: string;
  selectors: { queue: string; storefront: string }; signal: AbortSignal;
  receipts: (requestId: string | null, signal: AbortSignal, role: BrowserRole) => Promise<readonly Receipt[]>;
}
/** Server hook: no replacement page, context, cookie export, or refresh probe. */
export async function navigateWaitingRoomShopper(options: AdmittedNavigationOptions): Promise<WaitingRoomResult> {
  const { machine, transport, scope } = options;
  const session = machine.result().sessions.find(s => s.sessionId === scope.sessionId);
  if (machine.runId !== scope.runId || machine.policy.releaseDigest !== scope.releaseDigest || session?.state !== 'admitted' || machine.mode !== transport.mode) throw new Error('Admitted runner session required');
  const signal = AbortSignal.any([options.signal, transport.signal]); signal.throwIfAborted();
  await transport.navigateAdmitted(scope, options.path);
  const view = await transport.inspect(scope.sessionId, options.selectors);
  const receipts: readonly Receipt[] = view.storefront ? await new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Receipt wait stopped')); return; }
    const abort = () => reject(new Error('Receipt wait stopped'));
    signal.addEventListener('abort', abort, { once: true });
    void options.receipts(view.requestId, signal, session.role).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  }) : [];
  signal.throwIfAborted();
  machine.observe({ ...view, queueObservation: view, sessionId: scope.sessionId, receipts });
  if (machine.result().sessions.find(s => s.sessionId === scope.sessionId)?.state === 'admitted') await transport.confirmAdmission(scope.sessionId, options.selectors.storefront, receipts);
  return machine.result();
}
/** Real contexts and page inspection. Receipt collector must share this run's permit ledger. */
export async function runWaitingRoom(options: WaitingRoomRunOptions): Promise<WaitingRoomResult> {
  const { transport, ledger, machine, plan } = options;
  try {
    planWaitingRoom(plan, ledger.limits);
    if (machine.mode !== transport.mode) throw new Error('Fixture/live browser mode mismatch');
  } catch (error) { await transport.close(); throw error; }
  const workController = new AbortController();
  const workSignal = AbortSignal.any([ledger.signal, workController.signal, ...(options.signal ? [options.signal] : [])]);
  const cancelDeadline = ledger.clock.schedule(Math.max(0, ledger.workDeadline - ledger.clock.now()), () => workController.abort());
  const ids: string[] = [];
  async function visit(id: string, role: BrowserRole, observeOnly = false): Promise<void> {
    if (!observeOnly) {
      machine.navigating(id);
      await transport.navigate(id, new URL(plan.path, role === 'before' ? options.beforeOrigin : options.afterOrigin).href);
    }
    const view = await transport.inspect(id, options.selectors);
    const receipts: readonly Receipt[] = view.storefront ? await new Promise((resolve, reject) => {
      if (workSignal.aborted) { reject(new Error('Receipt wait stopped')); return; }
      const abort = () => reject(new Error('Receipt wait stopped'));
      workSignal.addEventListener('abort', abort, { once: true });
      void options.receipts(view.requestId, workSignal, role).then(resolve, reject).finally(() => workSignal.removeEventListener('abort', abort));
    }) : [];
    machine.observe({ ...view, queueObservation: view, sessionId: id, receipts });
    if (machine.result().sessions.find(s => s.sessionId === id)?.state === 'admitted') await transport.confirmAdmission(id, options.selectors.storefront, receipts);
    options.onSnapshot?.(machine.result());
    if (options.onFrame) {
      try { options.onFrame(await transport.captureFrame(transport.frameScope(id), view.queue ? options.selectors.queue : options.selectors.storefront)); } catch { /* No raw or unmasked fallback. */ }
    }
    else if (options.onPreview) {
      try { options.onPreview(await transport.preview(id, view.queue ? options.selectors.queue : options.selectors.storefront)); } catch { /* Missing preview never supplies proof. */ }
    }
  }
  try {
    for (const role of ['before', 'after', 'after'] as const) { const id = await transport.open(role); ids.push(id); machine.register(id, role, transport.frameScope(id)); await visit(id, role); }
    // Refresh the admitted shopper while the other protected session is queued.
    const admitted = machine.result().sessions.find(s => s.role === 'after' && s.state === 'admitted');
    if (admitted) await visit(admitted.sessionId, 'after');
    const queued = machine.result().sessions.find(s => s.role === 'after' && s.state === 'queued');
    if (queued) for (let n = 0; n < plan.refreshes; n++) {
      await new Promise<void>((resolve, reject) => {
        if (workSignal.aborted || transport.stopped) { reject(new Error('Waiting Room stopped')); return; }
        const duration = Math.ceil(plan.expectedTransitionMs / plan.refreshes);
        if (ledger.clock.now() + duration >= ledger.workDeadline) { reject(new Error('Transition cannot fit remaining deadline')); return; }
        const abort = () => { cancel(); reject(new Error('Waiting Room stopped')); };
        const cancel = ledger.clock.schedule(duration, () => { workSignal.removeEventListener('abort', abort); resolve(); });
        workSignal.addEventListener('abort', abort, { once: true });
      });
      // Live admission must occur naturally in the owned page; no refresh probes.
      workSignal.throwIfAborted(); await visit(queued.sessionId, 'after', transport.mode === 'live');
      if (machine.result().sessions.find(s => s.sessionId === queued.sessionId)?.state === 'admitted') break;
    }
  } catch { for (const id of ids) machine.error(id); }
  finally {
    cancelDeadline(); workController.abort();
    try { await transport.close(); }
    finally { machine.close(); options.onSnapshot?.(machine.result()); }
  }
  // Retain last observed states and the owned-page close transitions for the UI.
  return machine.result();
}
