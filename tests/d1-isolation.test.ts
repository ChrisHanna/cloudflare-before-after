import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { CATALOG_SEED, StorefrontData, type Database } from '../apps/storefront-worker/src/d1.js';
let mf: Miniflare;
let before: StorefrontData; let after: StorefrontData;
let beforeDb: Awaited<ReturnType<Miniflare['getD1Database']>>;
const previousTmp = process.env.TMPDIR;
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required');
  process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local D1 test"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, d1Persist: false });
  beforeDb = await mf.getD1Database('BEFORE'); const afterDb = await mf.getD1Database('AFTER');
  const migration = readFileSync('apps/storefront-worker/migrations/0001_storefront.sql', 'utf8');
  // D1 exec accepts a multi-statement migration; triggers remain intact.
  for (const db of [beforeDb, afterDb]) await db.exec(migration.replace(/\n/g, ' '));
  before = new StorefrontData(beforeDb as unknown as Database, 'before');
  after = new StorefrontData(afterDb as unknown as Database, 'after');
  await before.seed(); await after.seed();
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
describe('d1-isolation', () => {
  it('uses separate real local D1 bindings and immutable idempotent equivalent seeds', async () => {
    const { content_digest, ...seedFields } = CATALOG_SEED;
    expect(createHash('sha256').update(JSON.stringify(seedFields)).digest('hex')).toBe(content_digest);
    for (const store of [before, after]) { await store.seed(); await store.seed(); expect(await store.product('launch-shirt')).toEqual(CATALOG_SEED); }
    expect(await beforeDb.prepare('SELECT COUNT(*) AS count FROM catalog').first('count')).toBe(1);
    await expect(beforeDb.prepare('UPDATE catalog SET title=?').bind('bad').run()).rejects.toThrow('immutable');
    await expect(beforeDb.prepare('DELETE FROM catalog').run()).rejects.toThrow('immutable');
    await expect(before.seed([{ ...CATALOG_SEED, title: 'different' }])).rejects.toThrow('differs');
  });
  it('isolates environments, scenarios, runs and owned cleanup', async () => {
    const run = randomUUID(); const otherRun = randomUUID(); const id = randomUUID();
    const original = before.scope('waf-custom', run);
    const otherScope = before.scope('turnstile', run);
    const anotherRun = before.scope('waf-custom', otherRun);
    const otherEnv = after.scope('waf-custom', run);
    const input = { record_id: id, display_name: 'synthetic-shopper', note: 'owned-data' };
    await original.create(input); await original.create(input);
    for (const scope of [otherScope, anotherRun, otherEnv]) {
      expect(await scope.get(id)).toBeNull();
      await expect(scope.updateNote(id, 'corruption')).rejects.toThrow('not found');
      await scope.cleanup(); expect(await original.get(id)).toEqual(input);
      await scope.create({ ...input, note: 'independent' });
    }
    await original.cleanup(); expect(await original.get(id)).toBeNull();
    for (const scope of [otherScope, anotherRun, otherEnv]) expect((await scope.get(id))?.note).toBe('independent');
    expect(await before.product('launch-shirt')).toEqual(CATALOG_SEED);
  });
  it('stores harmless signatures as inert bound values and rejects real identity input', async () => {
    const scope = before.scope('waf-sqli', randomUUID()); const id = randomUUID();
    const note = "' OR 1=1; DROP TABLE catalog; -- <script>inert</script>";
    await scope.create({ record_id: id, display_name: 'synthetic-test', note });
    expect((await scope.get(id))?.note).toBe(note);
    expect(await before.product('launch-shirt')).toEqual(CATALOG_SEED);
    await expect(scope.create({ record_id: randomUUID(), display_name: 'real@example.com', note: '' })).rejects.toThrow();
    await expect(before.product("' OR 1=1")).rejects.toThrow();
  });
});
