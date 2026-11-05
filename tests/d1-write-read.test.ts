import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runD1WriteRead } from '../apps/storefront-worker/src/d1-probe.js';
import type { Database, PreparedStatement } from '../apps/storefront-worker/src/d1.js';
import { D1_PROBE_MARKER, D1WriteReadReceiptSchema } from '../packages/contracts/src/d1-probe.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { labConfig } from './fixtures/lab.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
let mf: Miniflare; let db: Database;
const ledgers: BudgetLedger[] = [];
afterEach(() => ledgers.splice(0).forEach(ledger => ledger.stop()));
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('Owned scratch required');
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("offline"); } }', compatibilityDate: '2026-01-01', d1Databases: ['DB'] });
  const actual = await mf.getD1Database('DB'); db = actual;
  await actual.exec(readFileSync('apps/storefront-worker/migrations/0005_verification_probes.sql', 'utf8').replace(/\n/g, ' '));
});
afterAll(async () => { await mf?.dispose(); });
function owner() { return { role: 'before' as const, runId: randomUUID(), requestId: randomUUID() }; }
function faulted(fault: string): Database {
  return { batch: statements => db.batch(statements), prepare(sql) {
    let statement = db.prepare(sql);
    const wrapper: PreparedStatement = {
      bind(...values) { statement = statement.bind(...values); return wrapper; },
      all: () => statement.all(),
      async first<T>() {
        const value = await statement.first<T>();
        if (sql.startsWith('SELECT environment')) {
          if (fault === 'missing') return null;
          if (fault === 'read-error') throw new Error('PRIVATE_DB_CANARY');
          if (value && fault === 'wrong-owner') return { ...value, run_id: randomUUID() };
          if (value && fault === 'wrong-marker') return { ...value, marker: 'not-the-marker' };
        }
        return value;
      },
      async run() {
        if (sql.startsWith('DELETE') && fault === 'cleanup') throw new Error('PRIVATE_CLEANUP_CANARY');
        const result = await statement.run();
        if (sql.startsWith('DELETE') && fault === 'cleanup-returned-failure') return { success: false, meta: { changes: 1 } };
        if (sql.startsWith('DELETE') && fault === 'cleanup-malformed') return {};
        if (sql.startsWith('DELETE') && fault === 'cleanup-zero') return { success: true, meta: { changes: 0 } };
        if (sql.startsWith('INSERT') && fault === 'uncertain-insert') return { success: true, meta: {} };
        return result;
      },
    }; return wrapper;
  } };
}
describe('real local D1 write/read and exact cleanup, not isolation proof', () => {
  it('writes and reads a fixed scoped marker, then proves its removal', async () => {
    const input = owner(); const result = await runD1WriteRead(db, input);
    expect(result).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'observed' }); expect(result.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    const rows = await db.prepare('SELECT probe_id FROM verification_probes WHERE run_id=?').bind(input.runId).all(); expect(rows.results).toHaveLength(0);
  });
  it.each(['missing', 'read-error', 'wrong-owner', 'wrong-marker'] as const)('does not claim a read from %s data; still cleans its newly inserted row', async fault => {
    const input = owner(); const result = await runD1WriteRead(faulted(fault), input);
    expect(result).toMatchObject({ write: 'observed', read: 'unknown', cleanup: 'observed', contentDigest: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('keeps failed cleanup visible and does not retry the write', async () => {
    const input = owner(); const result = await runD1WriteRead(faulted('cleanup'), input);
    expect(result).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'unknown' });
    expect(await db.prepare('SELECT probe_id FROM verification_probes WHERE probe_id=?').bind(result.probeId).first()).not.toBeNull();
  });
  it.each(['cleanup-returned-failure', 'cleanup-malformed', 'cleanup-zero'])('does not prove cleanup from %s even if the row is absent', async fault => {
    const result = await runD1WriteRead(faulted(fault), owner());
    expect(result).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'unknown' });
    expect(await db.prepare('SELECT probe_id FROM verification_probes WHERE probe_id=?').bind(result.probeId).first()).toBeNull();
  });
  it('does not guess insertion ownership when database metadata is missing', async () => {
    const input = owner(); const result = await runD1WriteRead(faulted('uncertain-insert'), input);
    expect(result).toMatchObject({ write: 'unknown', read: 'unknown', cleanup: 'unknown', contentDigest: null });
    expect(await db.prepare('SELECT probe_id FROM verification_probes WHERE probe_id=?').bind(result.probeId).first()).not.toBeNull();
  });
  it('does not remove a pre-existing colliding marker or another request', async () => {
    const input = owner(); const probeId = randomUUID(); const other = owner();
    for (const scope of [input, other]) await db.prepare('INSERT INTO verification_probes(environment,scenario_id,run_id,request_id,probe_id,marker) VALUES(?,?,?,?,?,?)')
      .bind(scope.role, 'waf-custom', scope.runId, scope.requestId, probeId, D1_PROBE_MARKER).run();
    const result = await runD1WriteRead(db, input, probeId);
    expect(result).toMatchObject({ write: 'unknown', read: 'unknown', cleanup: 'unknown' });
    const rows = await db.prepare('SELECT probe_id FROM verification_probes WHERE probe_id=?').bind(probeId).all(); expect(rows.results).toHaveLength(2);
    const fresh = await runD1WriteRead(db, input); expect(fresh.cleanup).toBe('observed');
    expect((await db.prepare('SELECT probe_id FROM verification_probes WHERE probe_id=?').bind(probeId).all()).results).toHaveLength(2);
  });
  it('requires explicit opt-in and enough pre-budgeted reads before any mutation', async () => {
    const config = labConfig(); config.liveOptIn = true;
    const ledger = new BudgetLedger({ limits: { requests: 3, cleanupRequests: 1 } }); ledgers.push(ledger); let calls = 0;
    const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(row => `${row.type}:${row.role}:${row.id}`)),
      credentials: { reader: 'fixture-d1-reader-credential', collector: 'fixture-d1-collector-credential', runner: 'fixture-d1-runner-credential' }, dispatch: async () => { calls++; throw new Error('No I/O'); } });
    const scope = { role: 'before' as const, hostname: 'before.example.test', scenarioId: 'waf-custom' as const, runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64),
      start: new Date(Date.now() - 1000).toISOString(), end: new Date().toISOString() };
    expect((await collector.d1WriteRead(scope)).state).toBe('unsupported'); expect(calls).toBe(0);
    expect((await collector.d1WriteRead(scope, true)).state).toBe('unknown'); expect(calls).toBe(0); expect(ledger.snapshot.requestsUsed).toBe(0);
  });
  it.each(['parent', 'reads'] as const)('reserves %s proof capacity before concurrent effectful POSTs', async mode => {
    const config = labConfig(); config.liveOptIn = true;
    const parent = new BudgetLedger({ scope: 'all', limits: { requests: mode === 'parent' ? 4 : 30, cleanupRequests: 1 } });
    const child = new BudgetLedger({ parent }); ledgers.push(parent, child);
    let calls = 0; let begin!: () => void; let complete!: (response: Response) => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const response = new Promise<Response>(resolve => { complete = resolve; });
    const options = { config, ledger: child, mode: 'fixture' as const, maxReads: mode === 'reads' ? 3 : 24,
      observedOwnedResources: new Set(config.inventory.map(row => `${row.type}:${row.role}:${row.id}`)),
      credentials: { reader: 'fixture-d1-reader-credential', collector: 'fixture-d1-collector-credential', runner: 'fixture-d1-runner-credential' },
      dispatch: async () => { calls++; begin(); return response; } };
    const collector = createTrustedCollectors(options);
    const scope = { role: 'before' as const, hostname: 'before.example.test', scenarioId: 'waf-custom' as const, runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64),
      start: new Date(Date.now() - 1000).toISOString(), end: new Date().toISOString() };
    const first = collector.d1WriteRead(scope, true); await started;
    const secondCollector = mode === 'parent' ? createTrustedCollectors(options) : collector;
    expect((await secondCollector.d1WriteRead({ ...scope, requestId: randomUUID() }, true)).value).toBeNull(); expect(calls).toBe(1);
    if (mode === 'parent') await expect(parent.acquire()).rejects.toThrow();
    complete(new Response('Denied', { status: 403 })); expect((await first).permission).toBe('denied');
    const release = await parent.acquire(); release(); expect(parent.snapshot.requestsUsed).toBe(2);
  });
  it('checks every ancestor before dispatch when a parent has only one slot left', async () => {
    const config = labConfig(); config.liveOptIn = true;
    const parent = new BudgetLedger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const child = new BudgetLedger({ parent }); ledgers.push(parent, child);
    for (let i = 0; i < 2; i++) { const release = await parent.acquire(); release(); }
    let calls = 0;
    const collector = createTrustedCollectors({ config, ledger: child, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(row => `${row.type}:${row.role}:${row.id}`)),
      credentials: { reader: 'fixture-d1-reader-credential', collector: 'fixture-d1-collector-credential', runner: 'fixture-d1-runner-credential' }, dispatch: async () => { calls++; throw new Error('No mutation'); } });
    const scope = { role: 'before' as const, hostname: 'before.example.test', scenarioId: 'waf-custom' as const, runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64),
      start: new Date(Date.now() - 1000).toISOString(), end: new Date().toISOString() };
    expect((await collector.d1WriteRead(scope, true)).value).toBeNull(); expect(calls).toBe(0); expect(child.snapshot.requestsUsed).toBe(0);
  });
  it('keeps operation receipts distinct from full deployment or isolation claims', async () => {
    const input = owner(); const result = await runD1WriteRead(db, input);
    const receipt = D1WriteReadReceiptSchema.parse({ schemaVersion: 1, kind: 'd1-write-read', source: 'owned-worker-d1', targetRole: input.role,
      scenarioId: 'waf-custom', runId: input.runId, requestId: input.requestId, releaseDigest: 'a'.repeat(64), observedAt: new Date().toISOString(), resourceId: 'owned-database', ...result });
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: input.runId, requestId: input.requestId, targetRole: input.role,
      scenarioId: 'waf-custom' as const, observedAt: receipt.observedAt, source: 'verification' as const, payload: receipt };
    expect(makeArtifact(artifact).artifact.payload).toEqual(receipt);
    expect(() => makeArtifact({ ...artifact, targetRole: 'after' })).toThrow();
    expect(() => makeArtifact({ ...artifact, requestId: randomUUID() })).toThrow();
    expect(D1WriteReadReceiptSchema.safeParse({ ...receipt, write: 'unknown' }).success).toBe(false);
    expect(D1WriteReadReceiptSchema.safeParse({ ...receipt, isolation: true }).success).toBe(false);
  });
});
