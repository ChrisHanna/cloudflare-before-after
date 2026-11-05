import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { BrowserTransport } from '../packages/demo-core/src/browser-transport.js';
import { BudgetLedger, limitsFor } from '../packages/demo-core/src/budget.js';
import { planWaitingRoom, runWaitingRoom, waitingRoomSetupModule, WaitingRoomStateMachine, type WaitingRoomPlan, type WaitingRoomPolicy } from '../packages/demo-core/src/waiting-room.js';
import { waitingRoomFixture } from './browser-transport-fixtures.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';

const policy: WaitingRoomPolicy = { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) };
const plan: WaitingRoomPlan = { path: '/launch', productId: 'launch-shirt', expectedTransitionMs: 20, perNavigationRequests: 1, refreshes: 1, telemetryRequests: 4, interview: false };
const ledgers: BudgetLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.stop()); });
async function run(fault: Parameters<typeof waitingRoomFixture>[0] = {}, requests = 30) {
  const f = waitingRoomFixture(fault); f.config.ledger.stop();
  f.config.ledger = new BudgetLedger({ limits: { requests, cleanupRequests: 0 } }); ledgers.push(f.config.ledger);
  const transport = (await BrowserTransport.create(f.config))!;
  const machine = new WaitingRoomStateMachine(f.config.correlation.runId, 'fixture', policy);
  const result = await runWaitingRoom({ transport, ledger: f.config.ledger, plan, beforeOrigin: 'https://before.example.test', afterOrigin: 'https://after.example.test', machine, selectors: { queue: '[data-queue]', storefront: '[data-storefront]' }, receipts: async id => f.receipts.filter(r => r.requestId === id) });
  return { ...f, result, transport };
}
describe('waiting-room-state: AT-13A/AT-13B fixture orchestration', () => {
  it('uses three actual contexts, observes queue/admission and continuing distinct shopper', async () => {
    const { result, config, transport } = await run();
    expect(result.fixtureAssertionsPassed).toBe(true); expect(result.liveReadiness).toBe(false); expect(result.outcome).toBe('inconclusive'); expect(result.limitation).toContain('FIXTURE');
    expect(result.sessions.find(s => s.sessionId === 'session-3')!.transitions.map(t => t.to)).toEqual(['navigating', 'queued', 'navigating', 'admitted', 'closed']);
    expect(result.sessions.find(s => s.sessionId === 'session-2')!.transitions.filter(t => t.to === 'admitted')).toHaveLength(2);
    expect(config.ledger.snapshot.sessionsUsed).toBe(3); expect(config.ledger.snapshot.requestsUsed).toBe(5); expect(transport.sessions.every(s => s.state === 'closed')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fixture-private-cookie');
    expect(result.sessions.every(s => s.queuePosition === null && s.estimatedWaitMs === null)).toBe(true);
  });
  it.each([{ noQueue: true }, { noTransition: true }, { missingReceipt: true }, { breakCookies: true }])('does not verify missing proof: %j', async fault => {
    const { result } = await run(fault);
    expect(result.fixtureAssertionsPassed).toBe(false); expect(result.liveReadiness).toBe(false); expect(result.outcome).not.toBe('verified');
    expect(result.missingProof.length + result.contradictions.length).toBeGreaterThan(0);
  });
  it('allows normal Waiting Room cookie rotation within the same jar', async () => {
    const { result } = await run({ rotateCookie: true }); expect(result.fixtureAssertionsPassed).toBe(true);
  });
  it('stops new traffic at the request cap and preserves observations', async () => {
    const f = waitingRoomFixture(); f.config.ledger.stop();
    // The full plan fits, but concurrent work spends the remaining run allowance.
    f.config.ledger = new BudgetLedger({ limits: { requests: 9, cleanupRequests: 0 } }); ledgers.push(f.config.ledger);
    for (let n = 0; n < 6; n++) (await f.config.ledger.acquire())();
    const transport = (await BrowserTransport.create(f.config))!;
    const result = await runWaitingRoom({ transport, ledger: f.config.ledger, plan, beforeOrigin: 'https://before.example.test', afterOrigin: 'https://after.example.test', machine: new WaitingRoomStateMachine(f.config.correlation.runId, 'fixture', policy), selectors: { queue: '[data-queue]', storefront: '[data-storefront]' }, receipts: async id => f.receipts.filter(r => r.requestId === id) });
    expect(f.config.ledger.snapshot.requestsUsed).toBe(9); expect(result.liveReadiness).toBe(false); expect(result.fixtureAssertionsPassed).toBe(false); expect(result.sessions.length).toBeGreaterThan(0);
  });
  it('refuses fixture transport masquerading as live and still cleans up', async () => {
    const f = waitingRoomFixture(); ledgers.push(f.config.ledger);
    const transport = (await BrowserTransport.create(f.config))!;
    await expect(runWaitingRoom({ transport, ledger: f.config.ledger, plan, beforeOrigin: 'https://before.example.test', afterOrigin: 'https://after.example.test', machine: new WaitingRoomStateMachine(f.config.correlation.runId, 'live', { ...policy, mode: 'live' }), selectors: { queue: '[data-queue]', storefront: '[data-storefront]' }, receipts: async () => [] })).rejects.toThrow('mode mismatch');
    expect(f.config.ledger.snapshot.requestsUsed).toBe(0); await expect(transport.open('after')).rejects.toThrow('closed');
  });
  it('refuses plans that cannot fit sessions, subrequests, time or the interview slot', () => {
    expect(() => planWaitingRoom(plan, limitsFor('scenario', { sessions: 2 }))).toThrow();
    expect(() => planWaitingRoom({ ...plan, perNavigationRequests: 10 }, limitsFor())).toThrow();
    expect(() => planWaitingRoom({ ...plan, expectedTransitionMs: 60000 }, limitsFor())).toThrow();
    expect(() => planWaitingRoom({ ...plan, interview: true }, limitsFor('scenario', { maxRuntimeMs: 76000 }))).toThrow();
    expect(() => planWaitingRoom({ ...plan, refreshes: 0 }, limitsFor())).toThrow();
    expect(() => planWaitingRoom({ ...plan, path: '/launch?bypass=1' }, limitsFor())).toThrow();
  });
  it('declares a setup-only optional module and rejects unsupported tiny capacity', () => {
    const settings = { hostname: 'after.example.test', path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false };
    const module = waitingRoomSetupModule(settings); expect(module.phase).toBe('setup-only'); expect(module.optional).toBe(true);
    expect(() => waitingRoomSetupModule({ ...settings, total_active_users: 1 })).toThrow();
    expect(() => waitingRoomSetupModule({ ...settings, session_duration: 0 })).toThrow();
    expect(() => waitingRoomSetupModule({ ...settings, queue_all: true })).toThrow();
  });
});
describe('waiting-room-state: proof guards', () => {
  function receipt(runId: string, requestId: string, role: 'before' | 'after', at: string): Receipt {
    return { schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waiting-room', targetRole: role, producerId: 'container-fixture', sequence: 1, observedAt: at, rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' };
  }
  it('rejects replacement context admission, generic queue text and wrong-run receipts', () => {
    const runId = randomUUID(); const machine = new WaitingRoomStateMachine(runId, 'fixture', policy); const at = new Date().toISOString();
    machine.register('session-1', 'after'); machine.register('session-2', 'after');
    machine.observe({ sessionId: 'session-1', requestId: randomUUID(), observedAt: at, queue: true, storefront: false, queueCookiePresent: true, cookieContinuity: true, receipts: [] });
    const id = randomUUID(); machine.observe({ sessionId: 'session-2', requestId: id, observedAt: at, queue: false, storefront: true, queueCookiePresent: true, cookieContinuity: true, receipts: [receipt(runId, id, 'after', at)] });
    expect(machine.result().missingProof).toContain('Same-context queued-to-admitted transition and Container receipt');
    const unknown = new WaitingRoomStateMachine(runId, 'fixture', policy); unknown.register('session-1', 'after');
    unknown.observe({ sessionId: 'session-1', requestId: id, observedAt: at, queue: true, storefront: false, queueCookiePresent: false, cookieContinuity: true, receipts: [] });
    expect(unknown.result().sessions[0]!.state).toBe('unknown');
    unknown.observe({ sessionId: 'session-1', requestId: id, observedAt: at, queue: false, storefront: true, queueCookiePresent: true, cookieContinuity: true, receipts: [receipt(randomUUID(), id, 'after', at)] });
    expect(unknown.result().sessions[0]!.state).toBe('unknown');
    expect(() => unknown.register('session-1', 'after')).toThrow('Duplicate');
  });
  it('retains a cookie contradiction over missing policy proof', () => {
    const m = new WaitingRoomStateMachine(randomUUID(), 'fixture', { ...policy, state: 'unknown' }); m.register('session-1', 'after');
    m.observe({ sessionId: 'session-1', requestId: null, observedAt: new Date().toISOString(), queue: false, storefront: true, queueCookiePresent: false, cookieContinuity: false, receipts: [] });
    expect(m.result().outcome).toBe('failed'); expect(m.result().liveReadiness).toBe(false);
  });
});
