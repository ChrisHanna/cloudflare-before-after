import { z } from 'zod';
import { Digest, Id, Role, ScenarioId } from '../../../packages/contracts/src/schemas.js';
export interface ObjectBody { customMetadata?: Record<string, string>; text(): Promise<string> }
export interface ObjectBucket {
  head?(key: string): Promise<unknown>;
  get(key: string): Promise<ObjectBody | null>;
  put(key: string, value: string, options: { customMetadata: Record<string, string>; onlyIf: { etagDoesNotMatch: '*' } }): Promise<unknown>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit: number }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
}
const Key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/);
const Detail = z.string().max(4096);
export async function contentDigest(text: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(result)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export class OwnedAssets {
  readonly #bucket: ObjectBucket;
  readonly #role: z.infer<typeof Role>;
  constructor(bucket: ObjectBucket, role: z.infer<typeof Role>) { this.#bucket = bucket; this.#role = Role.parse(role); }
  async seedDetail(key: string, detail: string): Promise<string> {
    Key.parse(key); Detail.parse(detail);
    const path = `catalog/${key}`; const digest = await contentDigest(detail);
    const existing = await this.#bucket.get(path);
    if (existing) {
      const text = Detail.parse(await existing.text());
      if (existing.customMetadata?.['digest'] !== digest || existing.customMetadata?.['environment'] !== this.#role || existing.customMetadata?.['ownership'] !== 'immutable-catalog' || text !== detail || await contentDigest(text) !== digest) throw new Error('Immutable asset differs');
    } else {
      await this.#bucket.put(path, detail, { customMetadata: { digest, ownership: 'immutable-catalog', environment: this.#role }, onlyIf: { etagDoesNotMatch: '*' } });
      if ((await this.detail(key))?.digest !== digest) throw new Error('Concurrent immutable asset differs');
    }
    return digest;
  }
  async detail(key: string): Promise<{ text: string; digest: string } | null> {
    Key.parse(key); const value = await this.#bucket.get(`catalog/${key}`);
    if (!value) return null;
    const text = Detail.parse(await value.text()); const digest = await contentDigest(text);
    if (value.customMetadata?.['digest'] !== digest || value.customMetadata['environment'] !== this.#role || value.customMetadata['ownership'] !== 'immutable-catalog') throw new Error('Asset integrity or ownership mismatch');
    return { text, digest };
  }
  scope(scenario: z.infer<typeof ScenarioId>, runId: string): ScopedAssets { return new ScopedAssets(this.#bucket, this.#role, ScenarioId.parse(scenario), Id.parse(runId)); }
}
export class ScopedAssets {
  readonly #bucket: ObjectBucket; readonly #prefix: string;
  constructor(bucket: ObjectBucket, role: z.infer<typeof Role>, scenario: z.infer<typeof ScenarioId>, run: string) {
    this.#bucket = bucket; this.#prefix = `runs/${Role.parse(role)}/${ScenarioId.parse(scenario)}/${Id.parse(run)}/`;
  }
  async put(key: string, text: string): Promise<string> {
    Key.parse(key); Detail.parse(text); const digest = await contentDigest(text);
    const path = `${this.#prefix}${key}`; const existing = await this.#bucket.get(path);
    if (existing) {
      if (existing.customMetadata?.['owner'] !== this.#prefix || await existing.text() !== text) throw new Error('Existing owned asset differs');
    } else {
      await this.#bucket.put(path, text, { customMetadata: { owner: this.#prefix, digest }, onlyIf: { etagDoesNotMatch: '*' } });
      if (await this.get(key) !== text) throw new Error('Concurrent owned asset differs');
    }
    return digest;
  }
  async get(key: string): Promise<string | null> {
    Key.parse(key); const value = await this.#bucket.get(`${this.#prefix}${key}`);
    if (!value) return null;
    const text = Detail.parse(await value.text());
    if (value.customMetadata?.['owner'] !== this.#prefix || value.customMetadata?.['digest'] !== await contentDigest(text)) throw new Error('Asset ownership or integrity mismatch');
    return text;
  }
  async cleanup(): Promise<void> {
    // Fixed work ceiling; a caller must schedule further bounded cleanup if needed.
    const page = await this.#bucket.list({ prefix: this.#prefix, limit: 100 });
    if (page.truncated) throw new Error('Owned cleanup exceeds operation cap');
    for (const object of page.objects) {
      if (!object.key.startsWith(this.#prefix)) throw new Error('Bucket returned foreign key');
      const value = await this.#bucket.get(object.key);
      if (value?.customMetadata?.['owner'] !== this.#prefix) throw new Error('Foreign asset cleanup rejected');
      await this.#bucket.delete(object.key);
    }
  }
}
export const ImageAssetSchema = z.strictObject({
  id: Key, role: Role, labId: Key, immutable: z.literal(true),
  deliveryOrigin: z.literal('https://imagedelivery.net'), accountHash: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  variant: Key, expectedDigest: Digest,
});
export type ImageAsset = z.infer<typeof ImageAssetSchema>;
export function imageUrl(asset: ImageAsset, role: z.infer<typeof Role>, labId: string): string {
  const valid = ImageAssetSchema.parse(asset);
  if (valid.role !== role || valid.labId !== labId) throw new Error('Foreign image binding');
  return `${valid.deliveryOrigin}/${valid.accountHash}/${valid.id}/${valid.variant}`;
}
export async function verifyImageResponse(asset: ImageAsset, response: Response): Promise<{ observed: true; digest: string }> {
  ImageAssetSchema.parse(asset);
  if (!response.ok || response.redirected || !/^image\/(png|jpeg|webp)(;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error('No observed image delivery');
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty image body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 65536) { await reader.cancel(); throw new Error('Image exceeds cap'); } chunks.push(part.value); }
  } finally { reader.releaseLock(); }
  if (!size) throw new Error('Empty image body');
  const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const digest = [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
  if (digest !== asset.expectedDigest) throw new Error('Delivered image digest differs');
  return { observed: true, digest };
}
