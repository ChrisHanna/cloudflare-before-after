import { z } from 'zod';
import { ImageVariantSelectionSchema, type ImageVariantSelection } from './image-variant-selection.js';

const Name = z.string().min(1).max(512);
// The selected transform must be complete and understood before any fields are stripped.
export const SelectedVariantReadbackSchema = z.strictObject({
  id: Name, options: ImageVariantSelectionSchema.shape.options,
  neverRequireSignedURLs: z.boolean().optional(),
});
// Unselected rows establish list integrity, never ownership or transform equivalence.
const UnselectedVariant = z.object({
  id: Name,
  options: z.object({
    fit: z.enum(['scale-down', 'contain', 'cover', 'crop', 'pad']),
    width: z.number().finite().min(1), height: z.number().finite().min(1),
    metadata: z.enum(['keep', 'copyright', 'none']),
  }),
  neverRequireSignedURLs: z.boolean().optional(),
});

/** Real account-group shape; retain only the selected, fully understood variant. */
export function selectedVariantGroupSchema(selectedId: string) {
  return z.strictObject({ variants: z.record(Name, z.unknown()).refine(rows => Object.keys(rows).length <= 100) }).transform((group, ctx) => {
    const variants: Record<string, z.infer<typeof SelectedVariantReadbackSchema>> = {};
    for (const [name, raw] of Object.entries(group.variants)) {
      const parsed = (name === selectedId ? SelectedVariantReadbackSchema : UnselectedVariant).safeParse(raw);
      if (!parsed.success || parsed.data.id !== name) {
        ctx.addIssue({ code: 'custom', message: 'Images variant group has invalid, ambiguous, or unqualified settings' });
        return z.NEVER;
      }
      if (name === selectedId) variants[name] = SelectedVariantReadbackSchema.parse(parsed.data);
    }
    return { variants };
  });
}

/** Equality uses the explicit descriptor, never any unrelated variant or fallback. */
export function assertDeclaredPublicVariant(
  group: z.infer<ReturnType<typeof selectedVariantGroupSchema>>,
  input: ImageVariantSelection,
): void {
  const expected = ImageVariantSelectionSchema.parse(input);
  const candidate = Object.hasOwn(group.variants, expected.id) ? group.variants[expected.id] : undefined;
  const actual = candidate === undefined ? undefined : SelectedVariantReadbackSchema.parse(candidate);
  if (!actual || actual.id !== expected.id
    || actual.neverRequireSignedURLs !== expected.neverRequireSignedURLs
    || actual.options.fit !== expected.options.fit || actual.options.width !== expected.options.width
    || actual.options.height !== expected.options.height || actual.options.metadata !== expected.options.metadata) {
    throw new Error('Declared public Images variant is missing or changed; read-only dependency cannot be repaired');
  }
}
