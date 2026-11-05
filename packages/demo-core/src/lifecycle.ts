import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { Id, Time } from '../../contracts/src/schemas.js';
import { BudgetLedger } from './budget.js';
import { validateEvidenceDirectory } from './config.js';
const LeaseRecord = z.strictObject({ ownerId: Id, runId: Id, pid: z.number().int().positive(), idempotencyKey: Id, createdAt: Time });
type LeaseRecord = z.infer<typeof LeaseRecord>;
function readRecord(file: string): LeaseRecord {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid lease file');
  return LeaseRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new Error('Owner liveness is unknown'); }
}
export class LabLease {
  readonly #file: string;
  readonly #record: LeaseRecord;
  #released = false;
  private constructor(file: string, record: LeaseRecord) { this.#file = file; this.#record = record; }
  get ownerId(): string { return this.#record.ownerId; }
  get runId(): string { return this.#record.runId; }
  static claim(options: { projectRoot: string; evidenceDirectory: string; labId: string; idempotencyKey: string }): { kind: 'claimed'; lease: LabLease } | { kind: 'existing'; record: LeaseRecord } {
    Id.parse(options.idempotencyKey);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.labId)) throw new Error('Invalid lab ID');
    const root = validateEvidenceDirectory(options.evidenceDirectory, options.projectRoot);
    const file = join(root, 'leases', `${options.labId}.json`);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    // Revalidate after creating ancestors to reject pre-existing symlink paths.
    validateEvidenceDirectory(dirname(file), options.projectRoot);
    const record = LeaseRecord.parse({ ownerId: randomUUID(), runId: randomUUID(), pid: process.pid, idempotencyKey: options.idempotencyKey, createdAt: new Date().toISOString() });
    let fd: number;
    try { fd = openSync(file, 'wx', 0o600); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const existing = readRecord(file);
      if (existing.idempotencyKey === options.idempotencyKey) return { kind: 'existing', record: existing };
      throw new Error('Lab already has an owner; explicit recovery required for a dead owner');
    }
    try { writeFileSync(fd, JSON.stringify(record)); } finally { closeSync(fd); }
    return { kind: 'claimed', lease: new LabLease(file, record) };
  }
  static recover(options: { projectRoot: string; evidenceDirectory: string; labId: string; expectedOwnerId: string; expectedIdempotencyKey?: string; explicit: boolean }, probe: (pid: number) => boolean = alive): void {
    if (!options.explicit) throw new Error('Explicit recovery required');
    Id.parse(options.expectedOwnerId);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(options.labId)) throw new Error('Invalid lab ID');
    const root = validateEvidenceDirectory(options.evidenceDirectory, options.projectRoot);
    const file = join(root, 'leases', `${options.labId}.json`);
    validateEvidenceDirectory(dirname(file), options.projectRoot);
    const mutex = `${file}.recovery`;
    const fd = openSync(mutex, 'wx', 0o600);
    try {
      const record = readRecord(file);
      if (record.ownerId !== options.expectedOwnerId || (options.expectedIdempotencyKey !== undefined && record.idempotencyKey !== Id.parse(options.expectedIdempotencyKey))) throw new Error('Lease changed; recovery refused');
      if (probe(record.pid)) throw new Error('Cannot recover an active owner');
      const current = readRecord(file);
      if (current.ownerId !== record.ownerId) throw new Error('Lease changed');
      unlinkSync(file);
    } finally { closeSync(fd); unlinkSync(mutex); }
  }
  release(): void {
    if (this.#released) return;
    if (!existsSync(this.#file) || readRecord(this.#file).ownerId !== this.ownerId) throw new Error('Lease ownership changed');
    unlinkSync(this.#file); this.#released = true;
  }
}
export type Phase = 'planned' | 'preflight' | 'baseline' | 'protected' | 'correlate' | 'report' | 'cleanup' | 'finished';
const ORDER: Phase[] = ['planned', 'preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup', 'finished'];
export class RunLifecycle {
  readonly #work = new AbortController();
  readonly #resources = new Map<string, (signal: AbortSignal) => Promise<void>>();
  readonly #lease: LabLease;
  readonly ledger: BudgetLedger;
  #phase: Phase = 'planned';
  #cleaned = false;
  #started = false;
  readonly #pending = new Set<string>();
  readonly interrupted: { value: boolean } = { value: false };
  constructor(lease: LabLease, ledger: BudgetLedger) { this.#lease = lease; this.ledger = ledger; }
  get phase(): Phase { return this.#phase; }
  get runId(): string { return this.#lease.runId; }
  get signal(): AbortSignal { return AbortSignal.any([this.#work.signal, this.ledger.signal]); }
  advance(next: Phase): void {
    if (ORDER.indexOf(next) !== ORDER.indexOf(this.#phase) + 1) throw new Error('Invalid run transition');
    this.#phase = next;
  }
  cancel(ownerId: string): void {
    if (ownerId !== this.#lease.ownerId) throw new Error('Only the owner may cancel');
    this.interrupted.value = true; this.#work.abort(new Error('Presenter stopped run'));
  }
  trackOwned(key: string, ownerId: string, cleanup: (signal: AbortSignal) => Promise<void>): void {
    if (ownerId !== this.#lease.ownerId || !key.startsWith(`${this.runId}:`) || this.#resources.has(key) || this.#cleaned) throw new Error('Invalid owned resource registration');
    this.#resources.set(key, cleanup);
  }
  async #bounded(step: () => Promise<void>, report = false): Promise<void> {
    const signal = report ? this.ledger.signal : this.signal;
    signal.throwIfAborted();
    const deadline = report ? this.ledger.deadline : this.ledger.workDeadline;
    if (this.ledger.clock.now() >= deadline) throw new Error('Run deadline reached');
    let cancelTimer = () => {};
    let removeAbort = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      const abort = () => reject(new Error('Run interrupted'));
      signal.addEventListener('abort', abort, { once: true });
      removeAbort = () => signal.removeEventListener('abort', abort);
      cancelTimer = this.ledger.clock.schedule(Math.max(0, deadline - this.ledger.clock.now()), () => {
        if (!report) this.#work.abort(new Error('Work deadline reached'));
        reject(new Error('Run deadline reached'));
      });
    });
    const key = `${this.runId}:unfinished-${this.#phase}`;
    this.#pending.add(key);
    const operation = Promise.resolve().then(step).finally(() => this.#pending.delete(key));
    try { await Promise.race([operation, interrupted]); } finally { cancelTimer(); removeAbort(); }
  }
  async execute(steps: Record<'preflight' | 'baseline' | 'protected' | 'correlate' | 'report', (run: RunLifecycle) => Promise<void>>): Promise<{ cleanup: 'complete' | 'incomplete'; leftovers: string[]; executionFailed: boolean }> {
    if (this.#started) throw new Error('Run execution already started');
    this.#started = true;
    let executionFailed = false;
    try {
      for (const phase of ['preflight', 'baseline', 'protected', 'correlate'] as const) {
        this.signal.throwIfAborted(); this.advance(phase); await this.#bounded(() => steps[phase](this));
      }
    } catch { executionFailed = true; }
    this.#phase = 'report';
    try { await this.#bounded(() => steps.report(this), true); } catch { executionFailed = true; }
    this.#phase = 'cleanup'; this.#cleaned = true; this.ledger.beginCleanup();
    const leftovers: string[] = [];
    for (const [key, cleanup] of [...this.#resources].reverse()) {
      if (this.ledger.signal.aborted || this.ledger.clock.now() >= this.ledger.deadline) { leftovers.push(key); continue; }
      let cancelTimer = () => {};
      const timedOut = new Promise<never>((_resolve, reject) => {
        cancelTimer = this.ledger.clock.schedule(Math.max(0, this.ledger.deadline - this.ledger.clock.now()), () => reject(new Error('Cleanup deadline reached')));
      });
      try { await Promise.race([cleanup(this.ledger.signal), timedOut]); this.#resources.delete(key); }
      catch { leftovers.push(key); }
      finally { cancelTimer(); }
    }
    leftovers.push(...this.#pending);
    this.#phase = 'finished'; this.ledger.stop('Run finished');
    // Do not admit a competing run while cleanup or uncooperative work remains.
    if (!leftovers.length) { try { this.#lease.release(); } catch { executionFailed = true; } }
    return { cleanup: leftovers.length ? 'incomplete' : 'complete', leftovers, executionFailed };
  }
}
