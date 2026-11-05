import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID } from 'node:crypto';
import { runR2WriteRead } from '../apps/storefront-worker/src/r2-probe.js';
import type { ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import { R2ProbeRowSchema, R2WriteReadReceiptSchema, R2_PROBE_MARKER, r2ProbeKey } from '../packages/contracts/src/r2-probe.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { labConfig } from './fixtures/lab.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
let mf: Miniflare; let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const ledgers: BudgetLedger[] = [];
afterEach(() => ledgers.splice(0).forEach(ledger => ledger.stop()));
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('Owned scratch required');
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("offline"); } }', compatibilityDate: '2026-01-01', r2Buckets: ['BUCKET'] });
  bucket = await mf.getR2Bucket('BUCKET');
});
afterAll(async () => { await mf?.dispose(); });
const owner = () => ({ role: 'before' as const, runId: randomUUID(), requestId: randomUUID() });
function faulted(fault: string): ObjectBucket {
  return {
    async put(key, text, options) {
      if (fault === 'null-put') return null;
      const result = await bucket.put(key, text, options);
      if (fault === 'uncertain-put') return {};
      return result;
    },
    async get(key) {
      if (fault === 'missing') return null;
      if (fault === 'read-error') throw new Error('PRIVATE_R2_ERROR');
      const value = await bucket.get(key); if (!value) return null;
      const body = fault === 'body' || fault === 'oversized-body' ? new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode(fault === 'body' ? 'PRIVATE_WRONG_BODY' : 'x'.repeat(2049))); controller.close();
      } }) : value.body;
      return { key: value.key, version: fault === 'version' ? 'foreign-version' : value.version, etag: value.etag,
        size: fault === 'size' ? 1000000 : value.size, customMetadata: fault === 'metadata' ? { owner: 'foreign' } : value.customMetadata ?? {},
        body, text: () => value.text() };
    },
    async head(key) {
      if (fault === 'replaced-before-cleanup') await bucket.put(key, 'foreign replacement', { customMetadata: { owner: 'foreign' } });
      return bucket.head(key);
    },
    async delete(key) { if (fault === 'cleanup') throw new Error('PRIVATE_R2_DELETE'); if (fault !== 'not-deleted') await bucket.delete(key); },
    list: options => bucket.list(options),
  };
}
describe('real local R2 scoped write/read and cleanup', () => {
  it('conditionally creates, reads actual bytes and confirms scoped removal', async () => {
    const input = owner(); const result = await runR2WriteRead(bucket, input);
    expect(result).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'observed' }); expect(result.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId, request_id: input.requestId, probe_id: result.probeId, marker: R2_PROBE_MARKER });
    expect(await bucket.head(r2ProbeKey(row))).toBeNull();
  });
  it.each(['missing', 'read-error', 'version', 'size', 'metadata', 'body', 'oversized-body'] as const)('does not claim a read from %s; only cleans the independently checked new version', async fault => {
    const result = await runR2WriteRead(faulted(fault), owner());
    expect(result).toMatchObject({ write: 'observed', read: 'unknown', cleanup: 'observed', contentDigest: null });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it.each(['null-put', 'uncertain-put'] as const)('does not clean or retry %s ownership', async fault => {
    const input = owner(); const probeId = randomUUID(); const result = await runR2WriteRead(faulted(fault), input, probeId);
    expect(result).toMatchObject({ write: 'unknown', read: 'unknown', cleanup: 'unknown', contentDigest: null });
    const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId, request_id: input.requestId, probe_id: probeId, marker: R2_PROBE_MARKER });
    expect(await bucket.head(r2ProbeKey(row)) === null).toBe(fault === 'null-put');
  });
  it.each(['cleanup', 'not-deleted', 'replaced-before-cleanup'] as const)('retains explicit unknown cleanup on %s', async fault => {
    const input = owner(); const result = await runR2WriteRead(faulted(fault), input);
    expect(result).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'unknown' });
    const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId, request_id: input.requestId, probe_id: result.probeId, marker: R2_PROBE_MARKER });
    expect(await bucket.head(r2ProbeKey(row))).not.toBeNull();
    if (fault === 'replaced-before-cleanup') expect(await (await bucket.get(r2ProbeKey(row)))!.text()).toBe('foreign replacement');
  });
  it('never overwrites/deletes an existing object or another request key', async () => {
    const input = owner(); const probeId = randomUUID(); const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId, request_id: input.requestId, probe_id: probeId, marker: R2_PROBE_MARKER });
    const key = r2ProbeKey(row); await bucket.put(key, 'foreign existing', { customMetadata: { owner: 'foreign' } });
    expect(await runR2WriteRead(bucket, input, probeId)).toMatchObject({ write: 'unknown', read: 'unknown', cleanup: 'unknown' });
    expect(await (await bucket.get(key))!.text()).toBe('foreign existing');
    const other = { ...input, requestId: randomUUID() }; expect((await runR2WriteRead(bucket, other, probeId)).cleanup).toBe('observed');
    expect(await (await bucket.get(key))!.text()).toBe('foreign existing');
  });
  it('refuses pre-aborted writes and reports absent metadata capability as unknown cleanup', async () => {
    const controller = new AbortController(); controller.abort(); const input = { ...owner(), signal: controller.signal };
    expect(await runR2WriteRead(bucket, input)).toMatchObject({ write: 'unknown', read: 'unknown', cleanup: 'unknown' });
    const wrapper = faulted(''); delete wrapper.head;
    expect(await runR2WriteRead(wrapper, owner())).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'unknown' });
  });
  it.each(['aborted-read', 'discarded-read'] as const)('does not await a never-settling cancel hook during %s', async fault => {
    const controller = new AbortController(); let notify!: () => void; const ready = new Promise<void>(resolve => { notify = resolve; }); let cancellations = 0;
    const wrapper = faulted('');
    wrapper.get = async key => {
      const value = await bucket.get(key); if (!value) return null;
      let sent = false;
      const body = new ReadableStream<Uint8Array>({ pull(stream) { if (!sent) { sent = true; stream.enqueue(new TextEncoder().encode('partial')); notify(); } },
        cancel() { cancellations++; return new Promise<void>(() => {}); } });
      return { key: value.key, version: fault === 'discarded-read' ? 'foreign-version' : value.version, etag: value.etag, size: value.size,
        customMetadata: value.customMetadata ?? {}, body, text: () => value.text() };
    };
    const input = { ...owner(), signal: controller.signal }; const pending = runR2WriteRead(wrapper, input);
    await ready; if (fault === 'aborted-read') controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Cancellation blocked owned cleanup')), 2000); })]);
      expect(result).toMatchObject({ write: 'observed', read: 'unknown', cleanup: 'observed' }); expect(cancellations).toBeGreaterThan(0);
      const row = R2ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId, request_id: input.requestId, probe_id: result.probeId, marker: R2_PROBE_MARKER });
      expect(await bucket.head(r2ProbeKey(row))).toBeNull();
    } finally { if (timer) clearTimeout(timer); }
  });
  it('reserves proof allowance before an effectful POST when the parent is exhausted', async () => {
    const config = labConfig(); config.liveOptIn = true;
    const parent = new BudgetLedger({ scope: 'all', limits: { requests: 4, cleanupRequests: 1 } }); const child = new BudgetLedger({ parent }); ledgers.push(parent, child);
    for (let i = 0; i < 2; i++) { const release = await parent.acquire(); release(); }
    let calls = 0;
    const collector = createTrustedCollectors({ config, ledger: child, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(row => `${row.type}:${row.role}:${row.id}`)),
      credentials: { reader: 'fixture-r2-reader-credential', collector: 'fixture-r2-collector-credential', runner: 'fixture-r2-runner-credential' }, dispatch: async () => { calls++; throw new Error('No mutation'); } });
    const scope = { role: 'before' as const, hostname: 'before.example.test', scenarioId: 'waf-custom' as const, runId: randomUUID(), requestId: randomUUID(), releaseDigest: 'a'.repeat(64),
      start: new Date(Date.now() - 1000).toISOString(), end: new Date().toISOString() };
    expect((await collector.r2WriteRead(scope)).state).toBe('unsupported'); expect((await collector.r2WriteRead(scope, true)).value).toBeNull(); expect(calls).toBe(0);
  });
  it('keeps only scoped operation evidence, never full deployment or storage-isolation claims', async () => {
    const input = owner(); const result = await runR2WriteRead(bucket, input);
    const receipt = R2WriteReadReceiptSchema.parse({ schemaVersion: 1, kind: 'r2-write-read', source: 'owned-worker-r2', targetRole: input.role, scenarioId: 'waf-custom',
      runId: input.runId, requestId: input.requestId, releaseDigest: 'a'.repeat(64), observedAt: new Date().toISOString(), resourceId: 'owned-bucket', ...result });
    const artifact = { id: randomUUID(), mode: 'fixture' as const, runId: input.runId, requestId: input.requestId, targetRole: input.role,
      scenarioId: 'waf-custom' as const, observedAt: receipt.observedAt, source: 'verification' as const, payload: receipt };
    expect(makeArtifact(artifact).artifact.payload).toEqual(receipt); expect(() => makeArtifact({ ...artifact, targetRole: 'after' })).toThrow();
    expect(R2WriteReadReceiptSchema.safeParse({ ...receipt, write: 'unknown' }).success).toBe(false);
    expect(R2WriteReadReceiptSchema.safeParse({ ...receipt, isolation: true }).success).toBe(false);
  });
});
