import { describe, expect, it } from 'vitest';
import { OwnedAssets, contentDigest, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
describe('runtime existing immutable detail postcondition', () => {
  for (const role of ['before', 'after'] as const) {
    for (const defect of ['none', 'missing', 'environment', 'ownership', 'digest', 'text'] as const) it(`${role}: ${defect}`, async () => {
      const text = 'Synthetic launch shirt. Demo data only.'; const digest = await contentDigest(text);
      const metadata = { digest, ownership: 'immutable-catalog', environment: role };
      if (defect === 'environment') metadata.environment = role === 'before' ? 'after' : 'before';
      if (defect === 'ownership') metadata.ownership = 'foreign';
      if (defect === 'digest') metadata.digest = 'b'.repeat(64);
      let writes = 0;
      const bucket = { get: async () => ({ customMetadata: defect === 'missing' ? undefined : metadata, text: async () => defect === 'text' ? 'Changed' : text }), put: async () => { writes++; }, delete: async () => { writes++; } } as unknown as ObjectBucket;
      const assets = new OwnedAssets(bucket, role);
      if (defect === 'none') { expect(await assets.seedDetail('launch-shirt', text)).toBe(digest); expect(await assets.seedDetail('launch-shirt', text)).toBe(digest); expect(await assets.detail('launch-shirt')).toEqual({ text, digest }); }
      else await expect(assets.seedDetail('launch-shirt', text)).rejects.toThrow();
      expect(writes).toBe(0);
    });
  }
});
