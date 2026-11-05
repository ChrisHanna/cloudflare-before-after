import { describe, expect, it, vi } from 'vitest';
import { BrowserTransport } from '../packages/demo-core/src/browser-transport.js';
import { randomUUID } from 'node:crypto';
import { controlFixture } from './fixtures/control.js';
import { installedBrowser } from './browser-transport-fixtures.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { WaitingRoomStateMachine } from '../packages/demo-core/src/waiting-room.js';
import { TestClock } from './fixtures/clock.js';
import { atRecord } from '../packages/demo-core/src/t38-at11-14-record.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { ReportSchema, ReportStore } from '../packages/demo-core/src/reports.js';
import { readJournalRuns } from '../packages/demo-core/src/journal-reader.js';
type Fault = 'none' | 'no-transition' | 'missing-receipt' | 'cookies' | 'cap' | 'deadline';
function fixture(fault: Fault) {
  const receipts: Receipt[] = []; let runId = ''; let calls = 0; const visits = new Map<string, number>(); const clock = new TestClock();
  const f = controlFixture({ execute: (args, deps) => runDemoCli(args, { ...deps, ownershipRequests: 0,
    ...(fault === 'deadline' ? { clock, onWaitingRoom: value => { deps.onWaitingRoom?.(value); if (value.sessions.some(s => s.state === 'admitted')) clock.advance(60000); } } : {}),
    ownership: async () => new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)),
    onStarted: info => { runId = info.runId; deps.onStarted?.(info); },
    dispatch: async (url, init) => {
      calls++; const u = new URL(url);
      if (u.origin === f.config.apiOrigin) return Response.json({ success: true, result: { id: 'a'.repeat(32), host: 'after.example.test', path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false } });
      if (u.origin === f.config.telemetryOrigin) {
        expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${f.credentials.collector}`);
        const role = u.searchParams.get('role'); const found = receipts.filter(r => r.targetRole === role);
        return Response.json({ schemaVersion: 1, targetRole: role, runId, scenarioId: 'waiting-room', originCount: found.length, receipts: found, coverage: { healthy: true, complete: true, windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: found.length, gaps: [] } });
      }
      if (u.pathname === '/internal/checkpoint' && f.config.environments.some(e => e.origin === u.origin)) return Response.json({ checkpoint: true });
      throw new Error('Unapproved fixture route');
    },
    workshop: { browser: { launch: installedBrowser, fixture: async request => {
      calls++; const n = (visits.get(request.sessionId) ?? 0) + 1; visits.set(request.sessionId, n);
      const queue = request.sessionId === 'session-3' && (n === 1 || fault === 'no-transition');
      if (!queue && request.requestId && fault !== 'missing-receipt') receipts.push({ schemaVersion: 1, id: randomUUID(), runId, requestId: request.requestId, scenarioId: 'waiting-room', targetRole: request.sessionId === 'session-1' ? 'before' : 'after', producerId: 'fixture-container', sequence: receipts.length + 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: f.config.environments[0].releaseDigest, stage: 'entry' });
      return { status: 200, contentType: 'text/html', headers: queue ? { 'set-cookie': '__cfwaitingroom=t38-private-cookie; Path=/; Secure' } : fault === 'cookies' && request.sessionId === 'session-3' ? { 'set-cookie': '__cfwaitingroom=; Max-Age=0; Path=/; Secure' } : {}, body: queue ? '<main data-queue>Fixture queue</main>' : '<main data-storefront>Synthetic launch shirt</main>' + (fault === 'cap' ? Array.from({ length: 5 }, (_, i) => `<img src="/pixel-${i}">`).join('') : '') };
    } } },
  }) });
  f.config.demonstrations = { waitingRoom: { id: 'a'.repeat(32), settings: { hostname: 'after.example.test', path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false }, expectedTransitionMs: 20, perNavigationRequests: 1, refreshes: 1, queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]', queueContractQualified: true } };
  return { f, receipts, visits, count: () => calls };
}
describe('T38 AT-13 joined authenticated server, CLI and actual owned Chromium', () => {
  it.each(['none', 'no-transition', 'missing-receipt', 'cookies', 'cap', 'deadline'] as const)('AT-13 fixture/fault: %s', async fault => {
    const started = performance.now(); const { f, count, visits } = fixture(fault);
    try {
      await f.login(); const created = await f.request('/api/runs', 'POST', { command: 'waiting-room', liveOptIn: true, idempotencyKey: randomUUID(), ...(fault === 'cap' ? { limits: { requests: 20 } } : {}) });
      expect(created.status).toBe(202); const id = (await created.json() as any).run.id;
      const job = await f.wait(id); const room = job.waitingRoom;
      if (!job.result) console.info(JSON.stringify(atRecord({ id: 'AT-13B', releaseDigest: f.config.environments[0].releaseDigest, artifacts: job.artifacts, requestsUsed: count(), durationMs: performance.now() - started, checks: [{ name: 'Deadline preserves a schema-valid result and session history', passed: job.result !== null }] })));
      expect(job.result, `AT-13B requires a retained report at ${fault}; status=${job.status}; error=${job.error}; snapshots=${room?.sessions.length ?? 0}`).not.toBeNull();
      expect(job.result.report.result.outcome).not.toBe('verified'); expect(room.liveReadiness).toBe(false); expect(room.mode).toBe('fixture');
      expect(room.sessions.every((s: any) => s.state === 'closed')).toBe(true);
      const stored = new ReportStore(f.root, f.config.evidenceDirectory).load(job.actualRunId);
      expect(stored.waitingRoom).toEqual(room);
      const historical = readJournalRuns(f.root, f.config, new Set(), job.actualRunId).runs[0]!;
      expect(historical.waitingRoom).toEqual(room); expect(historical.readOnly).toBe(true); expect(historical.historical).toBe(true);
      expect(() => ReportSchema.parse({ ...stored, waitingRoom: { ...room, cookie: 'private' } })).toThrow();
      expect(() => ReportSchema.parse({ ...stored, waitingRoom: { ...room, mode: 'live' } })).toThrow();
      expect(room.fixtureAssertionsPassed).toBe(fault === 'none');
      const used = job.result.report.result.requestsUsed; expect(used).toBe(count()); expect(used).toBeLessThanOrEqual(fault === 'cap' ? 20 : 30);
      if (fault === 'none') {
        expect(room.sessions).toHaveLength(3); expect(visits.get('session-2')).toBe(2); expect(visits.get('session-3')).toBe(2);
        const q = room.sessions.find((s: any) => s.sessionId === 'session-3'); expect(q.transitions.map((t: any) => t.to)).toEqual(['navigating', 'queued', 'navigating', 'admitted', 'closed']);
        expect(q.cookieContinuity).toBe(true); expect(q.queuePosition).toBeNull(); expect(q.estimatedWaitMs).toBeNull();
      }
      if (fault === 'cookies') expect(room.contradictions).toContain('Browser cookie continuity broken');
      const countBefore = count(); const preview = await f.request(`/api/runs/${id}/sessions/session-1/preview`);
      // Current pixel frames expire with their owned page; no stale text fallback.
      expect(preview.status).toBe(404);
      expect((await f.request(`/api/runs/${id}/sessions/session-1/frame?scope=null`)).status).toBe(404);
      expect((await f.request(`/api/runs/${id}/sessions/session-8/preview`)).status).toBe(404);
      expect((await f.request(`/api/runs/${randomUUID()}/sessions/session-1/preview`)).status).toBe(404);
      expect(JSON.stringify(job)).not.toContain('t38-private-cookie'); expect(await preview.text()).not.toContain('t38-private-cookie'); expect(count()).toBe(countBefore);
      const record = atRecord({ id: fault === 'none' ? 'AT-13A' : 'AT-13B', releaseDigest: f.config.environments[0].releaseDigest, result: job.result.report.result, artifacts: job.artifacts, requestsUsed: used, durationMs: performance.now() - started, checks: [{ name: 'Actual contexts retained; fixture cannot verify live readiness', passed: !room.liveReadiness && job.result.report.result.outcome !== 'verified' }, { name: `Observed ${fault} with bounded traffic and owned previews`, passed: room.fixtureAssertionsPassed === (fault === 'none') && count() === countBefore }] });
      console.info(JSON.stringify(record)); expect(record.outcome).toBe('unavailable');
    } finally { await f.cleanup(); }
  }, 30000);
  it('retains the report and final session snapshot when owned browser cleanup fails', async () => {
    const original = BrowserTransport.prototype.close;
    const close = vi.spyOn(BrowserTransport.prototype, 'close').mockImplementation(async function (this: BrowserTransport) {
      await original.call(this); throw new Error('Injected owned cleanup failure');
    });
    const { f } = fixture('none');
    try {
      await f.login();
      const created = await f.request('/api/runs', 'POST', { command: 'waiting-room', liveOptIn: true, idempotencyKey: randomUUID() });
      const job = await f.wait((await created.json() as any).run.id);
      expect(job.result).not.toBeNull(); expect(job.result.report.result.cleanup).toBe('incomplete');
      expect(job.result.report.result.outcome).not.toBe('verified');
      expect(job.waitingRoom.sessions.every((s: any) => s.state === 'closed')).toBe(true);
      expect(job.waitingRoom.fixtureAssertionsPassed).toBe(false);
    } finally { close.mockRestore(); await f.cleanup(); }
  });
  it('AT-13A cannot use a replacement context as the queued shopper', () => {
    const runId = randomUUID(); const machine = new WaitingRoomStateMachine(runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: 'a'.repeat(64) });
    machine.register('session-1', 'after'); machine.register('session-2', 'after');
    const at = new Date().toISOString(); const requestId = randomUUID();
    machine.observe({ sessionId: 'session-1', requestId: randomUUID(), observedAt: at, queue: true, storefront: false, queueCookiePresent: true, cookieContinuity: true, receipts: [] });
    machine.observe({ sessionId: 'session-2', requestId, observedAt: new Date(Date.parse(at) + 1).toISOString(), queue: false, storefront: true, queueCookiePresent: true, cookieContinuity: true, receipts: [{ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waiting-room', targetRole: 'after', producerId: 'fixture', sequence: 1, observedAt: at, rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' }] });
    expect(machine.result().fixtureAssertionsPassed).toBe(false); expect(machine.result().missingProof).toContain('Same-context queued-to-admitted transition and Container receipt');
  });
});
