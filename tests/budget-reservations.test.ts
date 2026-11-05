import { afterEach, describe, expect, it } from 'vitest';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
const ledgers: BudgetLedger[] = [];
afterEach(() => ledgers.splice(0).reverse().forEach(ledger => ledger.stop()));
const ledger = (options: ConstructorParameters<typeof BudgetLedger>[0] = {}) => { const value = new BudgetLedger(options); ledgers.push(value); return value; };
const charge = async (value: BudgetLedger) => { const release = await value.acquire(); release(); };
describe('atomic proof quota across ledger ancestors', () => {
  it('refuses a child reservation when only its parent lacks capacity', async () => {
    const parent = ledger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const child = ledger({ parent });
    await charge(parent); await charge(parent);
    expect(() => child.reserveRequests(3)).toThrow('cannot fit'); expect(child.snapshot.requestsUsed).toBe(0);
  });
  it('protects reserved capacity against parent, sibling and concurrent reservations', async () => {
    const parent = ledger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const a = ledger({ parent }); const b = ledger({ parent });
    const token = a.reserveRequests(3);
    expect(() => b.reserveRequests(3)).toThrow(); await expect(parent.acquire()).rejects.toThrow(); await expect(b.acquire()).rejects.toThrow();
    expect(parent.snapshot.requestsUsed).toBe(0);
    for (let i = 0; i < 3; i++) { const release = await a.acquire(undefined, token); release(); }
    expect(parent.snapshot.requestsUsed).toBe(3); expect(a.snapshot.requestsUsed).toBe(3);
    await expect(a.acquire(undefined, token)).rejects.toThrow('spent'); token.release();
  });
  it('releases unused quota without charging it or releasing already consumed requests', async () => {
    const parent = ledger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const a = ledger({ parent });
    const token = a.reserveRequests(3); const release = await a.acquire(undefined, token); release(); token.release(); token.release();
    await charge(parent); await charge(parent); expect(parent.snapshot.requestsUsed).toBe(3); await expect(parent.acquire()).rejects.toThrow();
  });
  it('does not allow a forged, foreign or released token', async () => {
    const a = ledger(); const b = ledger(); const token = a.reserveRequests(2);
    await expect(b.acquire(undefined, token)).rejects.toThrow('Foreign');
    await expect(a.acquire(undefined, { release() {} })).rejects.toThrow('Foreign');
    token.release(); await expect(a.acquire(undefined, token)).rejects.toThrow('released'); expect(a.snapshot.requestsUsed).toBe(0);
  });
  it('preserves the concurrency semaphore while quota is reserved', async () => {
    const a = ledger({ limits: { concurrency: 1 } }); const token = a.reserveRequests(2);
    const release = await a.acquire(undefined, token); let granted = false;
    const pending = a.acquire(undefined, token).then(done => { granted = true; return done; });
    await Promise.resolve(); expect(granted).toBe(false); expect(a.snapshot.activeRequests).toBe(1);
    release(); const done = await pending; done(); token.release(); expect(a.snapshot.peakConcurrency).toBe(1);
  });
  it('releases quota on stop and rejects queued reservation work', async () => {
    const parent = ledger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const child = ledger({ parent, limits: { concurrency: 1 } });
    const token = child.reserveRequests(3); const release = await child.acquire(undefined, token);
    const queued = child.acquire(undefined, token); child.stop(); await expect(queued).rejects.toThrow(); release();
    await charge(parent); await charge(parent); expect(parent.snapshot.requestsUsed).toBe(3);
  });
  it('cannot spend work reservations in the cleanup phase', async () => {
    const a = ledger(); const token = a.reserveRequests(3); a.beginCleanup();
    await expect(a.acquire(undefined, token)).rejects.toThrow('cleanup'); token.release();
    expect(() => a.reserveRequests(1)).toThrow();
  });
});
