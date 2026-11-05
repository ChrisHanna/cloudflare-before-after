import { performance } from 'node:perf_hooks';
import { z } from 'zod';

export type Scope = 'scenario' | 'interview' | 'all' | 'rehearsal';
export interface Limits { requests: number; concurrency: number; sessions: number; maxRuntimeMs: number; cleanupRequests: number; cleanupMs: number }
export interface Clock { now(): number; schedule(ms: number, fn: () => void): () => void }
export const realClock: Clock = { now: () => performance.now(), schedule: (ms, fn) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); } };
const Numbers = z.strictObject({ requests: z.number().int().positive(), concurrency: z.number().int().positive(), sessions: z.number().int().nonnegative(), maxRuntimeMs: z.number().int().positive(), cleanupRequests: z.number().int().nonnegative(), cleanupMs: z.number().int().nonnegative() });
export class BudgetError extends Error { override name = 'BudgetError'; }
export function limitsFor(scope: Scope = 'scenario', overrides: Partial<Limits> = {}): Limits {
  const requests = scope === 'scenario' ? 30 : scope === 'interview' ? 100 : 300;
  const runtime = scope === 'scenario' ? 60000 : scope === 'interview' ? 300000 : 900000;
  const l = Numbers.parse({ requests, concurrency: 2, sessions: 8, maxRuntimeMs: runtime, cleanupRequests: 1, cleanupMs: 1000, ...overrides });
  const requestCap = scope === 'scenario' ? 100 : requests;
  const runtimeCap = scope === 'scenario' ? 120000 : runtime;
  if (l.requests > requestCap || l.concurrency > 4 || l.sessions > 8 || l.maxRuntimeMs > runtimeCap || l.cleanupRequests > l.requests || l.cleanupMs > l.maxRuntimeMs) throw new BudgetError('Plan exceeds hard limits');
  return l;
}
export function validatePlan(limits: Limits, workRequests: number, sessions: number, minimumWorkMs = 0): void {
  for (const n of [workRequests, sessions, minimumWorkMs]) if (!Number.isSafeInteger(n) || n < 0) throw new BudgetError('Invalid plan quantity');
  if (workRequests + limits.cleanupRequests > limits.requests || sessions > limits.sessions || minimumWorkMs + limits.cleanupMs > limits.maxRuntimeMs) throw new BudgetError('Proof and cleanup cannot fit limits');
}
export interface RequestReservation { release(): void }
interface Waiter { reservation?: RequestReservation; ledger: BudgetLedger; resolve: (release: () => void) => void; reject: (error: unknown) => void; signal?: AbortSignal; remove: () => void }
export class BudgetLedger {
  readonly limits: Readonly<Limits>;
  readonly scope: Scope;
  readonly deadline: number;
  readonly workDeadline: number;
  readonly clock: Clock;
  readonly #parent: BudgetLedger | undefined;
  readonly #controller = new AbortController();
  readonly #waiters: Waiter[];
  readonly #cancelTimers: (() => void)[] = [];
  #used = 0; #active = 0; #peak = 0; #sessions = 0; #cleanup = false; #closed = false;
  #reserved = 0;
  readonly #reservations = new Map<RequestReservation, { remaining: number }>();
  constructor(options: { scope?: Scope; limits?: Partial<Limits>; parent?: BudgetLedger; clock?: Clock } = {}) {
    this.scope = options.scope ?? 'scenario'; this.limits = Object.freeze(limitsFor(this.scope, options.limits));
    this.#parent = options.parent; this.clock = options.clock ?? options.parent?.clock ?? realClock;
    if (options.parent?.scope === 'scenario') throw new BudgetError('Scenario cannot contain another scenario');
    this.#waiters = options.parent ? options.parent.#waiters : [];
    this.deadline = Math.min(this.clock.now() + this.limits.maxRuntimeMs, options.parent?.deadline ?? Infinity);
    this.workDeadline = Math.min(this.deadline - this.limits.cleanupMs, options.parent?.workDeadline ?? Infinity);
    this.#cancelTimers.push(this.clock.schedule(Math.max(0, this.workDeadline - this.clock.now()), () => this.#drain()));
    this.#cancelTimers.push(this.clock.schedule(Math.max(0, this.deadline - this.clock.now()), () => this.stop('Deadline reached')));
    if (options.parent) {
      const stop = () => this.stop('Parent stopped');
      options.parent.signal.addEventListener('abort', stop, { once: true });
      this.#cancelTimers.push(() => options.parent!.signal.removeEventListener('abort', stop));
      if (options.parent.signal.aborted) this.stop('Parent already stopped');
    }
  }
  get signal(): AbortSignal { return this.#controller.signal; }
  get snapshot() { return { requestsUsed: this.#used, activeRequests: this.#active, peakConcurrency: this.#peak, sessionsUsed: this.#sessions, cleanup: this.#cleanup, remainingMs: Math.max(0, this.deadline - this.clock.now()) }; }
  #chain(): BudgetLedger[] { const result: BudgetLedger[] = []; for (let l: BudgetLedger | undefined = this; l; l = l.#parent) result.push(l); return result; }
  reserveRequests(count: number): RequestReservation {
    if (!Number.isSafeInteger(count) || count < 1) throw new BudgetError('Invalid request reservation');
    this.#check(); const chain = this.#chain();
    if (chain.some(l => l.#cleanup || l.#used + l.#reserved + count > l.limits.requests - l.limits.cleanupRequests)) throw new BudgetError('Proof request reservation cannot fit');
    for (const l of chain) l.#reserved += count;
    const token: RequestReservation = Object.freeze({ release: () => {
      const state = this.#reservations.get(token); if (!state) return;
      for (const l of chain) l.#reserved -= state.remaining;
      this.#reservations.delete(token); this.#drain();
    } });
    this.#reservations.set(token, { remaining: count }); return token;
  }
  #check(reservation?: RequestReservation): void {
    if (reservation && !this.#reservations.get(reservation)?.remaining) throw new BudgetError('Foreign, released or spent reservation');
    for (const l of this.#chain()) {
      if (l.#closed || l.signal.aborted || l.clock.now() >= (l.#cleanup ? l.deadline : l.workDeadline)) throw new BudgetError('Stopped or deadline reached');
      if (reservation && l.#cleanup) throw new BudgetError('Work reservation cannot consume cleanup');
      if (l.#used + (reservation ? 0 : l.#reserved) >= l.limits.requests - (l.#cleanup ? 0 : l.limits.cleanupRequests)) throw new BudgetError('Request allowance exhausted');
    }
  }
  acquire(signal?: AbortSignal, reservation?: RequestReservation): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new BudgetError('Request cancelled')); return; }
      const waiter: Waiter = { ledger: this, resolve, reject, remove: () => {}, ...(reservation ? { reservation } : {}) };
      if (signal) {
        waiter.signal = signal;
        const abort = () => { const i = this.#waiters.indexOf(waiter); if (i !== -1) this.#waiters.splice(i, 1); waiter.remove(); reject(new BudgetError('Request cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        waiter.remove = () => signal.removeEventListener('abort', abort);
      }
      this.#waiters.push(waiter); this.#drain();
    });
  }
  #drain(): void {
    for (const w of [...this.#waiters]) {
      let error: unknown;
      try { w.ledger.#check(w.reservation); } catch (e) { error = e; }
      const chain = w.ledger.#chain();
      if (!error && chain.some(l => l.#active >= l.limits.concurrency)) continue;
      this.#waiters.splice(this.#waiters.indexOf(w), 1); w.remove();
      if (error) { w.reject(error); continue; }
      if (w.reservation) {
        w.ledger.#reservations.get(w.reservation)!.remaining--;
        for (const l of chain) l.#reserved--;
      }
      for (const l of chain) { l.#used++; l.#active++; l.#peak = Math.max(l.#peak, l.#active); }
      let released = false;
      w.resolve(() => { if (!released) { released = true; for (const l of chain) l.#active--; this.#drain(); } });
    }
  }
  openSession(): number {
    this.#check();
    const chain = this.#chain();
    if (chain.some(l => l.#sessions >= l.limits.sessions)) throw new BudgetError('Browser session allowance exhausted');
    for (const l of chain) l.#sessions++;
    return this.#sessions;
  }
  beginCleanup(): void { this.#cleanup = true; this.#drain(); }
  stop(reason = 'Stopped'): void {
    if (this.#closed) return;
    this.#closed = true; this.#controller.abort(new BudgetError(reason));
    for (const token of this.#reservations.keys()) token.release();
    for (const cancel of this.#cancelTimers) cancel();
    this.#drain();
  }
}
