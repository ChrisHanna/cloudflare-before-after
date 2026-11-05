import { z } from 'zod';
import { ImageVariantSelectionSchema, selectedImageVariantId, type ImageVariantSelection } from './image-variant-selection.js';

const Declaration = { declared: z.literal(true), liveVerified: z.literal(false) };
export const ImageVariantDeclarationSchema = z.union([
  z.strictObject({ ...Declaration, source: z.literal('managed-lab'), id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,135}$/), readOnly: z.literal(false) }),
  ImageVariantSelectionSchema.extend({ ...Declaration, readOnly: z.literal(true) }),
]);
export type ImageVariantDeclaration = z.infer<typeof ImageVariantDeclarationSchema>;

/** Local configuration disclosure only: never fetch or claim live verification. */
export function imageVariantDeclaration(config: { labId: string; imageVariant?: ImageVariantSelection | undefined }): ImageVariantDeclaration {
  const selection = config.imageVariant;
  return ImageVariantDeclarationSchema.parse(selection
    ? { ...ImageVariantSelectionSchema.parse(selection), readOnly: true, declared: true, liveVerified: false }
    : { id: selectedImageVariantId(config.labId), source: 'managed-lab', readOnly: false, declared: true, liveVerified: false });
}
