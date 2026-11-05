import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { createHash, randomUUID } from 'node:crypto';
import { OwnedAssets, imageUrl, verifyImageResponse, type ImageAsset, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
let mf: Miniflare; let before: OwnedAssets; let after: OwnedAssets;
const previousTmp = process.env.TMPDIR;
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required');
  process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local R2"); } }', host: '127.0.0.1', port: 0, r2Buckets: { BEFORE: 'before', AFTER: 'after' }, r2Persist: false });
  before = new OwnedAssets(await mf.getR2Bucket('BEFORE') as unknown as ObjectBucket, 'before');
  after = new OwnedAssets(await mf.getR2Bucket('AFTER') as unknown as ObjectBucket, 'after');
}, 30000);
afterAll(async () => { await mf?.dispose(); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
describe('asset-isolation', () => {
  it('keeps stable equivalent catalog seeds without duplicate objects', async () => {
    const text = '{"description":"Synthetic shirt"}';
    const expected = createHash('sha256').update(text).digest('hex');
    for (const assets of [before, after]) {
      expect(await assets.seedDetail('launch-shirt', text)).toBe(expected);
      expect(await assets.seedDetail('launch-shirt', text)).toBe(expected);
      expect(await assets.detail('launch-shirt')).toEqual({ text, digest: expected });
      await expect(assets.seedDetail('launch-shirt', 'different')).rejects.toThrow('differs');
    }
    const bucket = await mf.getR2Bucket('BEFORE') as unknown as ObjectBucket;
    expect((await bucket.list({ prefix: 'catalog/', limit: 100 })).objects).toHaveLength(1);
  });
  it('isolates environments, scenarios, runs and cleanup from immutable assets', async () => {
    const run = randomUUID(); const id = 'receipt';
    const owner = before.scope('waf-custom', run);
    const others = [before.scope('turnstile', run), before.scope('waf-custom', randomUUID()), after.scope('waf-custom', run)];
    await owner.put(id, 'owner');
    await owner.put(id, 'owner');
    await expect(owner.put(id, 'overwrite')).rejects.toThrow('differs');
    for (const other of others) { expect(await other.get(id)).toBeNull(); await other.cleanup(); expect(await owner.get(id)).toBe('owner'); await other.put(id, 'other'); }
    await owner.cleanup(); expect(await owner.get(id)).toBeNull();
    for (const other of others) expect(await other.get(id)).toBe('other');
    expect(await before.detail('launch-shirt')).not.toBeNull();
    await expect(owner.get('../catalog/launch-shirt')).rejects.toThrow();
  });
  it('refuses concurrent conflicting writes without corrupting existing content', async () => {
    const scope = before.scope('waf-custom', randomUUID());
    const result = await Promise.allSettled([scope.put('same-key', 'one'), scope.put('same-key', 'two')]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(['one', 'two']).toContain(await scope.get('same-key'));
  });
  it('requires observed delivery, not merely a declared image URL', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
    const asset: ImageAsset = { id: 'launch-shirt', role: 'before', labId: 'owned-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'owned-account', variant: 'public', expectedDigest: createHash('sha256').update(bytes).digest('hex') };
    expect(imageUrl(asset, 'before', 'owned-lab')).toBe('https://imagedelivery.net/owned-account/launch-shirt/public');
    expect(() => imageUrl(asset, 'after', 'owned-lab')).toThrow('Foreign');
    await expect(verifyImageResponse(asset, new Response(bytes, { headers: { 'content-type': 'image/png' } }))).resolves.toEqual({ observed: true, digest: asset.expectedDigest });
    for (const response of [new Response('', { status: 404 }), new Response(imageUrl(asset, 'before', 'owned-lab')), new Response('bad', { headers: { 'content-type': 'image/png' } })]) await expect(verifyImageResponse(asset, response)).rejects.toThrow();
    // No image deletion operation exists in run cleanup.
    expect(asset.immutable).toBe(true);
  });
});
