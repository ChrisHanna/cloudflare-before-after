import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGoldenPath, validateGoldenConvergence, collectGoldenConvergence } from '../packages/demo-core/src/golden-path.js';
import { digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { Miniflare } from 'miniflare';
import { SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
import { StorefrontData, type Database } from '../apps/storefront-worker/src/d1.js';
import { OwnedAssets, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import type { LabCliDependencies } from '../packages/demo-core/src/lab-cli.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { installedBrowser } from './browser-transport-fixtures.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
type Fault = 'none' | 'capability' | 'approval' | 'apply' | 'doctor' | 'attribution' | 'repeat' | 'manual-repair' | 'browser';
function fixture(fault: Fault = 'none') {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'golden-')); roots.push(root);
  const f = demoLabFixture(root, fault === 'doctor' ? 'binding' : undefined);
  const intent = f.intent; intent.profile = 'core-waf';
  const writes: string[] = [];
  const executor = vi.fn<NonNullable<LabCliDependencies['createExecutor']>>(async () => ({ mode: 'fixture', async execute(step, context) {
    await context.perform('fixture-owned-operation', step.resources[0]!, async () => { if (fault === 'apply') throw new Error('Injected provider failure'); writes.push(step.id); });
  }, async close() {} }));
  const lab: Omit<LabCliDependencies, 'projectRoot'> = {
    loadConfig: () => intent, sourceDigest: () => intent.releaseDigest, credentials: () => FIXTURE_CREDENTIALS,
    provider: () => ({ provider: { mode: 'fixture', inspect: async key => ({ state: fault === 'capability' && key === 'd1' ? 'unknown' : ['waiting-room', 'bot-management', 'api-shield', 'access'].includes(key) ? 'not-entitled' : 'available', source: 'offline-provider', reasons: [] }) }, close() {} }),
    createExecutor: executor,
    // Simulates a human answer only in this offline fixture. The harness itself
    // never builds approval strings or enables an executor before approval.
    confirm: async prompt => ({ interactiveTTY: true, confirmation: fault === 'approval' ? 'NO' : /Type (APPROVE [a-f0-9]{64})/.exec(prompt)![1]! }),
  };
  let comparisons = 0;
  const dispatch = async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === '/catalog' && new Headers(init.headers).get('x-demo-test') === `cf-demo-${f.config.labId}-block`) comparisons++;
    if (fault === 'manual-repair' && new URL(url).pathname === '/catalog') {
      const directory = join(f.config.evidenceDirectory, 'deployment/plans');
      const file = readdirSync(directory).find(name => name.endsWith('.attempt.json'))!;
      const path = join(directory, file); const record = JSON.parse(readFileSync(path, 'utf8'));
      record.completedSteps.push('manual-repair'); writeFileSync(path, JSON.stringify(record));
    }
    if (new URL(url).pathname.endsWith('/graphql') && (fault === 'attribution' || fault === 'repeat' && comparisons > 2)) return Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: [] }] } } });
    return f.dispatch(url, init);
  };
  const options = { projectRoot: root, checkoutRoot: process.cwd(), mode: 'fixture' as const, lab, demo: { loadConfig: () => f.config, credentials: () => f.credentials, dispatch }, requestApproval: true, launchBrowser: async () => { if (fault === 'browser') throw new Error('No installed browser'); return installedBrowser(); }, canaries: [...Object.values(FIXTURE_CREDENTIALS), f.canary] };
  const convergence = async () => ({ mode: 'fixture', labId: f.config.labId, accountId: f.config.accountId, zoneId: f.config.zoneId, observedAt: new Date().toISOString(), resources: f.config.inventory.filter(r => ['worker', 'container', 'd1', 'r2', 'image'].includes(r.type)).map(({ role, type, id }) => ({ role, type, id })), seeds: ['before', 'after'].map(role => ({ role, catalogCount: 1, objectCount: 1, catalogDigest: 'a'.repeat(64), objectDigest: 'b'.repeat(64), imageDigest: 'c'.repeat(64) })) });
  return { ...f, root, options: { ...options, convergence }, writes, executor };
}
describe('golden-path: actual planners -> approval -> CLI -> journal -> reports', () => {
  it('executes eight ordered offline stages from empty evidence with two fresh proofs', async () => {
    const f = fixture(); const r = await runGoldenPath(f.options);
    expect(r.status, JSON.stringify(r)).toBe('passed');
    expect(r.stages.map(s => s.id)).toEqual(['checkout', 'plan', 'apply', 'doctor', 'command-center', 'comparison', 'export', 'repeatability']);
    expect(r.stages.every(s => s.passed)).toBe(true); expect(new Set(r.runIds).size).toBe(2);
    expect(r.liveReadiness).toBe(false); expect(r.mode).toBe('fixture');
    expect(r.planPath?.startsWith(f.config.evidenceDirectory)).toBe(true);
    expect(f.executor).toHaveBeenCalledOnce(); expect(f.writes.some(id => /wrangler-before/.test(id))).toBe(true);
    expect(f.writes.some(id => /wrangler-after/.test(id))).toBe(true);
    expect(r.commands.filter(c => c.surface === 'lab' && c.args[0] === 'apply')).toHaveLength(1);
    const applied = r.commands.findIndex(c => c.args[0] === 'apply');
    expect(r.commands.slice(applied + 1).some(c => c.surface === 'lab' && ['apply', 'approve'].includes(c.args[0]!))).toBe(false);
    expect(JSON.stringify(r)).not.toContain(FIXTURE_CREDENTIALS.runner);
  });
  it('pauses at the actual saved plan without constructing an executor', async () => {
    const f = fixture(); const r = await runGoldenPath({ ...f.options, requestApproval: false });
    expect(r.status).toBe('awaiting-approval'); expect(r.stoppingStep).toBe('apply'); expect(r.planPath).not.toBeNull();
    expect(r.checkpointPath).not.toBeNull();
    expect(JSON.parse(readFileSync(r.checkpointPath!, 'utf8'))).toMatchObject({ status: 'awaiting-approval', planPath: r.planPath });
    expect(f.writes).toEqual([]); expect(f.executor).not.toHaveBeenCalled();
    const resumed = await runGoldenPath({ ...f.options, resumePlanPath: r.planPath! });
    expect(resumed.status, JSON.stringify(resumed)).toBe('passed');
    expect(resumed.planPath).toBe(r.planPath);
    expect(resumed.commands.filter(c => c.surface === 'lab' && c.args[0] === 'plan')).toHaveLength(1);
  });
  it.each([['capability', 'plan'], ['approval', 'apply'], ['apply', 'apply'], ['doctor', 'doctor'], ['attribution', 'comparison'], ['repeat', 'repeatability'], ['manual-repair', 'doctor'], ['browser', 'command-center']] as const)('stops %s at the exact %s step', async (fault, step) => {
    const f = fixture(fault); const r = await runGoldenPath(f.options);
    expect(r.status, JSON.stringify(r)).toBe('failed'); expect(r.stoppingStep).toBe(step);
    expect(r.stages.at(-1)).toMatchObject({ id: step, passed: false });
    if (fault === 'capability' || fault === 'approval') { expect(f.executor).not.toHaveBeenCalled(); expect(f.writes).toEqual([]); }
    if (fault === 'attribution') expect(r.runIds).toEqual([]);
  });
  it.each(['stale', 'source', 'owner', 'cost'] as const)('rejects a resumed %s plan before executor creation', async fault => {
    const f = fixture(); const paused = await runGoldenPath({ ...f.options, requestApproval: false });
    expect(paused.status).toBe('awaiting-approval');
    const lab = { ...f.options.lab };
    if (fault === 'stale') lab.now = () => Date.now() + 16 * 60000;
    if (fault === 'source') lab.sourceDigest = () => 'b'.repeat(64);
    if (fault === 'owner') { const changed = structuredClone(f.intent); changed.discovery.accountId = 'c'.repeat(32); lab.loadConfig = () => changed; }
    if (fault === 'cost') { const changed = structuredClone(f.intent); changed.costs.lines[0]!.thisMonthCents = 20000; lab.loadConfig = () => changed; }
    const result = await runGoldenPath({ ...f.options, lab, resumePlanPath: paused.planPath! });
    expect(result.status).toBe('failed'); expect(f.executor).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
  });
  it.each(['runs', 'journal', 'readiness', 'deployment'])('refuses old %s evidence before capabilities or setup', async directory => {
    const f = fixture(); mkdirSync(join(f.config.evidenceDirectory, directory), { recursive: true }); writeFileSync(join(f.config.evidenceDirectory, directory, 'old'), 'historical');
    const r = await runGoldenPath(f.options); expect(r.status).toBe('failed'); expect(r.stoppingStep).toBe('checkout');
    expect(r.commands).toEqual([]); expect(f.writes).toEqual([]);
  });
  it('checks actual local D1/R2 seed convergence through production seed modules', async () => {
    const f = fixture();
    const mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Fixture only"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, r2Buckets: ['BEFORE_OBJECTS', 'AFTER_OBJECTS'], d1Persist: false, r2Persist: false });
    try {
      const bindings = await Promise.all((['before', 'after'] as const).map(async role => {
        const db = await mf.getD1Database(role.toUpperCase());
        await db.exec(readFileSync('apps/storefront-worker/migrations/0001_storefront.sql', 'utf8').replace(/\n/g, ' '));
        const bucket = await mf.getR2Bucket(`${role.toUpperCase()}_OBJECTS`);
        return { role, db, bucket, data: new StorefrontData(db as unknown as Database, role), assets: new OwnedAssets(bucket as unknown as ObjectBucket, role) };
      }));
      const convergence = async () => {
        const seeds = [];
        for (const binding of bindings) {
          await binding.data.seed(); await binding.assets.seedDetail('launch-shirt', 'Synthetic launch shirt. Demo data only.');
          const objects = await binding.bucket.list({ prefix: 'catalog/', limit: 100 });
          if (objects.truncated) throw new Error('Incomplete fixture object inventory');
          const product = await binding.data.product('launch-shirt');
          seeds.push({ role: binding.role, catalogCount: await binding.db.prepare('SELECT COUNT(*) AS count FROM catalog').first('count'), objectCount: objects.objects.length, catalogDigest: digestValue(product), objectDigest: (await binding.assets.detail('launch-shirt'))!.digest, imageDigest: 'a'.repeat(64) });
        }
        return { mode: 'fixture', labId: f.config.labId, accountId: f.config.accountId, zoneId: f.config.zoneId, observedAt: new Date().toISOString(), resources: f.config.inventory.filter(r => ['worker', 'container', 'd1', 'r2', 'image'].includes(r.type)).map(({ role, type, id }) => ({ role, type, id })), seeds };
      };
      const r = await runGoldenPath({ ...f.options, convergence });
      expect(r.status, JSON.stringify(r)).toBe('passed');
      const snapshot = await convergence();
      let replay = false; let transformed = false;
      // A real, bounded RGBA variant. Explicit malformed bytes must still fail
      // the strict decoder even when the shared seed becomes a valid PNG.
      const chunk = (type: string, data: Buffer) => {
        const kind = Buffer.from(type); let crc = 0xffffffff;
        for (const byte of Buffer.concat([kind, data])) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
        const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const sum = Buffer.alloc(4); sum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
        return Buffer.concat([size, kind, data, sum]);
      };
      const header = Buffer.alloc(13); header.writeUInt32BE(1); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
      const variant = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0))]);
      const variantDigest = createHash('sha256').update(variant).digest('hex');
      const dispatch = async (value: string, init: RequestInit) => {
        const u = new URL(value);
        if (u.origin === 'https://imagedelivery.net') return new Response(transformed ? new Uint8Array(variant) : new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
        if (u.pathname !== '/internal/seed-inventory') return f.dispatch(value, init);
        const env = f.config.environments.find(e => e.origin === u.origin)!;
        const binding = bindings.find(b => b.role === env.role)!;
        const headers = new Headers(init.headers);
        expect(headers.get('x-demo-run-token')).toBe(f.credentials.runner);
        const objects = await binding.bucket.list({ prefix: 'catalog/', limit: 100 });
        if (objects.truncated) throw new Error('Incomplete inventory');
        return Response.json({ schemaVersion: 1, source: 'owned-seed-inventory/v1', runId: headers.get('x-demo-run-id'), requestId: replay ? '00000000-0000-4000-8000-000000000000' : headers.get('x-demo-request-id'), role: env.role, labId: f.config.labId, releaseDigest: env.releaseDigest, observedAt: new Date().toISOString(), databaseId: env.d1Id, bucketName: env.r2Bucket, catalogCount: await binding.db.prepare('SELECT COUNT(*) AS count FROM catalog').first('count'), objectCount: objects.objects.length, catalogDigest: digestValue(await binding.data.product('launch-shirt')), objectDigest: (await binding.assets.detail('launch-shirt'))!.digest, image: { id: env.imageIds[0], role: env.role, labId: f.config.labId, immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'fixture-account', variant: f.inventory.image_variant, expectedDigest: transformed ? variantDigest : SYNTHETIC_IMAGE_DIGEST } });
      };
      await expect(collectGoldenConvergence(f.config, 'fixture', f.credentials, dispatch)).rejects.toThrow('owned decoded image');
      transformed = true;
      const readStart = f.calls.length;
      const collected = await collectGoldenConvergence(f.config, 'fixture', f.credentials, dispatch);
      expect(collected.seeds.every(s => s.catalogCount === 1 && s.objectCount === 1 && s.imageDigest === variantDigest)).toBe(true);
      expect(() => validateGoldenConvergence(collected, f.config, 'fixture', Date.now() - 30000)).not.toThrow();
      expect(f.calls.slice(readStart).every(c => c.method === 'GET')).toBe(true);
      replay = true;
      await expect(collectGoldenConvergence(f.config, 'fixture', f.credentials, dispatch)).rejects.toThrow('fresh scope-bound');
      expect(() => validateGoldenConvergence({ ...snapshot, mode: 'live' }, f.config, 'fixture', Date.now() - 1000)).toThrow();
      expect(() => validateGoldenConvergence({ ...snapshot, accountId: 'b'.repeat(32) }, f.config, 'fixture', Date.now() - 1000)).toThrow();
      expect(() => validateGoldenConvergence({ ...snapshot, observedAt: '2020-01-01T00:00:00.000Z' }, f.config, 'fixture', Date.now() - 1000)).toThrow();
      expect(() => validateGoldenConvergence({ ...snapshot, resources: [...snapshot.resources.slice(1), snapshot.resources[1]] }, f.config, 'fixture', Date.now() - 1000)).toThrow();
      expect(() => validateGoldenConvergence({ ...snapshot, seeds: [snapshot.seeds[0], { ...snapshot.seeds[1], catalogCount: 2 }] }, f.config, 'fixture', Date.now() - 1000)).toThrow();
    } finally { await mf.dispose(); }
  }, 30000);
  it('stops inventory growth at repeatability, retaining fresh proof and saved failure', async () => {
    const f = fixture(); let reads = 0;
    const r = await runGoldenPath({ ...f.options, convergence: async () => ({ mode: 'fixture', labId: f.config.labId, accountId: f.config.accountId, zoneId: f.config.zoneId, observedAt: new Date().toISOString(), resources: f.config.inventory.filter(r => ['worker', 'container', 'd1', 'r2', 'image'].includes(r.type)).map(({ role, type, id }) => ({ role, type, id })), seeds: ['before', 'after'].map(role => ({ role, catalogCount: ++reads > 2 ? 2 : 1, objectCount: 1, catalogDigest: 'a'.repeat(64), objectDigest: 'b'.repeat(64), imageDigest: 'c'.repeat(64) })) }) });
    expect(r.status).toBe('failed'); expect(r.stoppingStep).toBe('repeatability'); expect(r.runIds).toHaveLength(2);
    expect(JSON.parse(readFileSync(r.checkpointPath!, 'utf8'))).toMatchObject({ status: 'failed', stoppingStep: 'repeatability' });
  });
  it.each([false, true])('live opt-in=%s cannot silently use fixture providers or earn readiness', async liveOptIn => {
    const f = fixture(); const r = await runGoldenPath({ ...f.options, mode: 'live', liveOptIn });
    expect(r.status).toBe('unavailable'); expect(r.liveReadiness).toBe(false); expect(r.commands).toEqual([]);
    expect(f.executor).not.toHaveBeenCalled(); expect(f.calls).toEqual([]); expect(f.writes).toEqual([]);
  });
});
