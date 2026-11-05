import { z } from 'zod';

// Standalone contracts: no demo-core or shared-schema imports (avoids cycles).
const Id = z.uuid();
const Time = z.iso.datetime();
const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const Role = z.enum(['before', 'after']);
const AccountHash = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
/** Measured URL/content facts, not an expected asset declaration. */
export const ImageDeliveryReadbackSchema = z.strictObject({
  deliveryOrigin: z.literal('https://imagedelivery.net'), accountHash: AccountHash,
  resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), variant: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), encodedDigest: Digest,
});
export type ImageDeliveryReadback = z.infer<typeof ImageDeliveryReadbackSchema>;
const Asset = z.strictObject({
  role: Role, workerName: Name, imageId: Name, variant: Name,
  deliveryOrigin: z.literal('https://imagedelivery.net'), accountHash: AccountHash, expectedDigest: Digest,
  origin: z.url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }),
  releaseDigest: Digest,
});
export const PublicVariantFunctionalSchema = z.strictObject({
  variant: z.strictObject({ source: z.literal('existing-public-readonly'), id: z.literal('public'),
    options: z.strictObject({ fit: z.enum(['scale-down', 'contain', 'cover', 'crop', 'pad']),
      width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
      metadata: z.enum(['keep', 'copyright', 'none']) }), neverRequireSignedURLs: z.boolean() }),
  assets: z.tuple([Asset.extend({ role: z.literal('before') }), Asset.extend({ role: z.literal('after') })]),
});
export type PublicVariantFunctional = z.infer<typeof PublicVariantFunctionalSchema>;
const AssetRead = z.strictObject({ role: Role, readId: Id, observedAt: Time });
export const PublicVariantProofSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('public-variant-proof'),
  source: z.literal('cloudflare-images-group-and-worker-bindings'),
  runId: Id, scenarioId: z.literal('waf-custom'), phase: z.enum(['before', 'after']), mode: z.enum(['live', 'fixture']),
  accountId: z.string().regex(/^[a-f0-9]{32}$/), labId: Name,
  startedAt: Time, observedAt: Time, variantObservedAt: Time, readId: Id,
  assetReads: z.tuple([AssetRead.extend({ role: z.literal('before') }), AssetRead.extend({ role: z.literal('after') })]),
  functional: PublicVariantFunctionalSchema,
}).superRefine((value, ctx) => {
  const start = Date.parse(value.startedAt); const end = Date.parse(value.observedAt);
  if (end < start || end - start > 120000 || [value.variantObservedAt, ...value.assetReads.map(read => read.observedAt)].some(time => Date.parse(time) < start || Date.parse(time) > end)) ctx.addIssue({ code: 'custom', message: 'Public variant observations are outside their current read window' });
  if (new Set([value.readId, ...value.assetReads.map(read => read.readId)]).size !== 3) ctx.addIssue({ code: 'custom', message: 'Public dependency and asset reads must be distinct' });
});
export type PublicVariantProof = z.infer<typeof PublicVariantProofSchema>;
