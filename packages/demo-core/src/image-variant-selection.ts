import { z } from 'zod';

/** An operator-declared, read-only dependency, never a lab-owned variant. */
export const ImageVariantSelectionSchema = z.strictObject({
  source: z.literal('existing-public-readonly'), id: z.literal('public'),
  options: z.strictObject({
    fit: z.enum(['scale-down', 'contain', 'cover', 'crop', 'pad']),
    width: z.number().int().min(1).max(16384), height: z.number().int().min(1).max(16384),
    metadata: z.enum(['keep', 'copyright', 'none']),
  }),
  neverRequireSignedURLs: z.boolean(),
});
export type ImageVariantSelection = z.infer<typeof ImageVariantSelectionSchema>;

/** Absence preserves the existing dedicated, managed catalog-variant behavior. */
export function selectedImageVariantId(labId: string, selection?: ImageVariantSelection): string {
  return selection?.source === 'existing-public-readonly' ? 'public' : `${labId}-catalog`;
}
