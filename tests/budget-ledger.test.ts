import { describe, expect, it } from 'vitest';
import { BudgetLedger, limitsFor, validatePlan } from '../packages/demo-core/src/budget.js';
import { TestClock } from './fixtures/clock.js';
describe('budget-ledger', () => {
  it('pins defaults and refuses every hard-cap escape', () => {
    expect(limitsFor()).toMatchObject({ requests: 30, concurrency: 2, sessions: 8, maxRuntimeMs: 60000 });
    expect(limitsFor('interview')).toMatchObject({ requests: 100, maxRuntimeMs: 300000 });
    for (const scope of ['all', 'rehearsal'] as const) expect(limitsFor(scope)).toMatchObject({ requests: 300, maxRuntimeMs: 900000 });
    for (const patch of [{ requests: 101 }, { requests: 0 }, { requests: 1.5 }, { concurrency: 5 }, { sessions: 9 }, { maxRuntimeMs: 120001 }, { cleanupMs: 60001 }, { unknown: 1 }]) expect(() => limitsFor('scenario', patch)).toThrow();
    expect(() => limitsFor('interview', { requests: 101 })).toThrow();
    expect(() => limitsFor('all', { maxRuntimeMs: 900001 })).toThrow();
    expect(() => validatePlan(limitsFor(), 30, 8)).toThrow();
    expect(() => validatePlan(limitsFor(), 2, 9)).toThrow();
    expect(() => validatePlan(limitsFor(), 2, 1, 60000)).toThrow();
  });
  it('reserves cleanup requests and enforces cumulative request usage', async () => {
    const ledger = new BudgetLedger({ clock: new TestClock(), limits: { requests: 3 } });
    for (let i = 0; i < 2; i++) (await ledger.acquire())();
    await expect(ledger.acquire()).rejects.toThrow('allowance');
    ledger.beginCleanup(); (await ledger.acquire())();
    await expect(ledger.acquire()).rejects.toThrow('allowance');
    expect(ledger.snapshot.requestsUsed).toBe(3);
    ledger.stop();
  });
  it('queues concurrency without charging before dispatch and cancels waiters', async () => {
    const l = new BudgetLedger({ clock: new TestClock(), limits: { concurrency: 1 } });
    const release = await l.acquire();
    const controller = new AbortController(); const waiting = l.acquire(controller.signal);
    expect(l.snapshot.requestsUsed).toBe(1);
    controller.abort(); await expect(waiting).rejects.toThrow('cancelled');
    const next = l.acquire(); release(); const releaseNext = await next;
    releaseNext(); releaseNext();
    expect(l.snapshot).toMatchObject({ requestsUsed: 2, activeRequests: 0, peakConcurrency: 1 });
    l.stop();
  });
  it('uses a monotonic work deadline and preserves only remaining cleanup time', async () => {
    const clock = new TestClock(); const l = new BudgetLedger({ clock });
    clock.advance(59000); await expect(l.acquire()).rejects.toThrow('deadline');
    l.beginCleanup(); (await l.acquire())();
    clock.advance(1000); expect(l.signal.aborted).toBe(true);
    await expect(l.acquire()).rejects.toThrow();
  });
  it('never resets parent request/runtime allowance across child scenarios', async () => {
    const clock = new TestClock(); const root = new BudgetLedger({ scope: 'interview', clock, limits: { requests: 5, maxRuntimeMs: 10000, cleanupRequests: 0, cleanupMs: 0 } });
    const a = new BudgetLedger({ parent: root, limits: { cleanupRequests: 0 } });
    for (let i = 0; i < 3; i++) (await a.acquire())(); a.stop();
    const b = new BudgetLedger({ parent: root, limits: { cleanupRequests: 0 } });
    for (let i = 0; i < 2; i++) (await b.acquire())();
    await expect(b.acquire()).rejects.toThrow('allowance');
    expect(root.snapshot.requestsUsed).toBe(5);
    clock.advance(10000); expect(root.signal.aborted).toBe(true); expect(b.signal.aborted).toBe(true);
    root.stop();
  });
  it('shares parent concurrency between independent ledgers', async () => {
    const clock = new TestClock(); const root = new BudgetLedger({ scope: 'all', clock, limits: { concurrency: 1 } });
    const a = new BudgetLedger({ parent: root }); const b = new BudgetLedger({ parent: root });
    const release = await a.acquire(); const waiting = b.acquire();
    expect(b.snapshot.requestsUsed).toBe(0);
    release(); (await waiting)(); expect(root.snapshot.peakConcurrency).toBe(1);
    a.stop(); b.stop(); root.stop();
  });
  it('caps created browser sessions without charging idle sessions as network requests', () => {
    const l = new BudgetLedger({ clock: new TestClock() });
    for (let i = 0; i < 8; i++) l.openSession();
    expect(() => l.openSession()).toThrow('session');
    expect(l.snapshot).toMatchObject({ sessionsUsed: 8, activeRequests: 0, requestsUsed: 0 }); l.stop();
  });
});
