import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { LabLease, RunLifecycle } from '../packages/demo-core/src/lifecycle.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { TestClock } from './fixtures/clock.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const scratch = process.env.KIROCREW_SCRATCH;
  if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'lifecycle-')); roots.push(root);
  const options = { projectRoot: root, evidenceDirectory: join(root, '.evidence'), labId: 'owned-lab', idempotencyKey: randomUUID() };
  const claim = LabLease.claim(options); if (claim.kind !== 'claimed') throw new Error('Expected fresh lease');
  const clock = new TestClock(); const ledger = new BudgetLedger({ clock });
  return { root, options, lease: claim.lease, clock, ledger, run: new RunLifecycle(claim.lease, ledger) };
}
const noop = async () => {};
describe('run-lifecycle', () => {
  it('deduplicates starts and rejects competing processes atomically', () => {
    const { options, lease, ledger } = setup();
    const existing = LabLease.claim(options);
    expect(existing.kind).toBe('existing');
    expect(() => LabLease.claim({ ...options, idempotencyKey: randomUUID() })).toThrow('owner');
    const file = join(options.evidenceDirectory, 'leases', 'owned-lab.json');
    const child = spawnSync(process.execPath, ['-e', 'try { require("node:fs").openSync(process.argv[1], "wx"); process.exit(1); } catch(e) { process.exit(e.code === "EEXIST" ? 0 : 2); }', file]);
    expect(child.status).toBe(0); lease.release(); lease.release(); ledger.stop();
  });
  it('requires explicit recovery, proven termination and unchanged owner', () => {
    const { options, lease, ledger } = setup();
    const recovery = { ...options, expectedOwnerId: lease.ownerId, explicit: true };
    expect(() => LabLease.recover({ ...recovery, explicit: false })).toThrow('Explicit');
    expect(() => LabLease.recover(recovery)).toThrow('active');
    expect(() => LabLease.recover({ ...recovery, expectedOwnerId: randomUUID() }, () => false)).toThrow('changed');
    expect(() => LabLease.recover(recovery, () => { throw new Error('unknown liveness'); })).toThrow('unknown');
    // Injected process probe is a fixture, not evidence that the actual parent died.
    LabLease.recover(recovery, () => false);
    const next = LabLease.claim({ ...options, idempotencyKey: randomUUID() });
    expect(next.kind).toBe('claimed'); expect(() => lease.release()).toThrow('changed');
    if (next.kind === 'claimed') next.lease.release(); ledger.stop();
  });
  it('runs ordered steps, reports, then cleans only registered owned resources', async () => {
    const { run, lease } = setup(); const seen: string[] = [];
    expect(() => run.advance('protected')).toThrow();
    expect(() => run.trackOwned('personal-browser', lease.ownerId, noop)).toThrow();
    expect(() => run.trackOwned(`${run.runId}:browser`, randomUUID(), noop)).toThrow();
    run.trackOwned(`${run.runId}:browser`, lease.ownerId, async () => { seen.push('cleanup'); });
    const step = (phase: string) => async () => { seen.push(phase); };
    const result = await run.execute({ preflight: step('preflight'), baseline: step('baseline'), protected: step('protected'), correlate: step('correlate'), report: step('report') });
    expect(seen).toEqual(['preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup']);
    expect(result).toEqual({ cleanup: 'complete', leftovers: [], executionFailed: false }); expect(run.phase).toBe('finished');
  });
  it('rejects cross-owner cancellation and reports partial work on interrupt', async () => {
    const { run, lease } = setup(); const protectedStep = vi.fn(noop); const report = vi.fn(noop); const cleanup = vi.fn(noop);
    run.trackOwned(`${run.runId}:browser`, lease.ownerId, cleanup);
    expect(() => run.cancel(randomUUID())).toThrow('owner');
    const result = await run.execute({ preflight: noop, baseline: async () => { run.cancel(lease.ownerId); }, protected: protectedStep, correlate: noop, report });
    expect(protectedStep).not.toHaveBeenCalled(); expect(report).toHaveBeenCalledOnce(); expect(cleanup).toHaveBeenCalledOnce(); expect(result.executionFailed).toBe(true);
  });
  it('bounds uncooperative polling and cleanup and records leftovers', async () => {
    const { run, lease, clock, options } = setup();
    const key = `${run.runId}:browser`; run.trackOwned(key, lease.ownerId, () => new Promise(() => {}));
    const pending = run.execute({ preflight: noop, baseline: () => new Promise(() => {}), protected: noop, correlate: noop, report: noop });
    await vi.waitFor(() => expect(run.phase).toBe('baseline'));
    clock.advance(59000); await vi.waitFor(() => expect(run.phase).toBe('cleanup'));
    clock.advance(1000);
    const result = await pending;
    expect(result).toMatchObject({ cleanup: 'incomplete', executionFailed: true });
    expect(result.leftovers).toEqual(expect.arrayContaining([key, `${run.runId}:unfinished-baseline`]));
    expect(readFileSync(join(options.evidenceDirectory, 'leases', 'owned-lab.json'), 'utf8')).toContain(lease.ownerId);
    expect(() => LabLease.claim({ ...options, idempotencyKey: randomUUID() })).toThrow('owner');
    await expect(run.execute({ preflight: noop, baseline: noop, protected: noop, correlate: noop, report: noop })).rejects.toThrow('already started');
  });
});
