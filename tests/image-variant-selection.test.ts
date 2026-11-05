import { describe, expect, it } from 'vitest';
import { ImageVariantSelectionSchema, selectedImageVariantId } from '../packages/demo-core/src/image-variant-selection.js';
import { IntentSchema, digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { LabConfigSchema } from '../packages/demo-core/src/config.js';
import { deploymentIntent } from './fixtures/deployment.js';
import { labConfig } from './fixtures/lab.js';
const selection = { source: 'existing-public-readonly' as const, id: 'public' as const, options: { fit: 'scale-down' as const, width: 1366, height: 768, metadata: 'none' as const }, neverRequireSignedURLs: false };
describe('explicit read-only public Images dependency contract', () => {
  it('keeps dedicated managed behavior when selection is absent', () => {
    expect(selectedImageVariantId('owned-lab')).toBe('owned-lab-catalog');
    expect(deploymentIntent('/tmp/variant-contract').discovery).not.toHaveProperty('imageVariant');
  });
  it('accepts only explicit public read-only selection in discovery and runtime', () => {
    const intent = deploymentIntent('/tmp/variant-contract'); intent.discovery.imageVariant = selection;
    expect(IntentSchema.parse(intent).discovery.imageVariant).toEqual(selection);
    expect(LabConfigSchema.parse({ ...labConfig(), imageVariant: selection }).imageVariant).toEqual(selection);
    expect(selectedImageVariantId('owned-lab', ImageVariantSelectionSchema.parse(selection))).toBe('public');
  });
  it.each([
    { ...selection, id: '*' }, { ...selection, id: 'foreign-variant' }, { ...selection, source: 'managed' },
    { ...selection, source: 'owned' }, { ...selection, allowWrite: true },
    { ...selection, options: { ...selection.options, quality: 90 } },
    { ...selection, options: { ...selection.options, width: 0 } },
    { ...selection, options: { ...selection.options, height: 1.5 } },
  ])('rejects unapproved ownership, targets and unknown settings: %j', candidate => {
    expect(ImageVariantSelectionSchema.safeParse(candidate).success).toBe(false);
  });
  it('binds source choice and expected options into the approval intent digest', () => {
    const intent = deploymentIntent('/tmp/variant-contract'); const before = digestValue(intent);
    intent.discovery.imageVariant = selection; const selected = digestValue(IntentSchema.parse(intent));
    expect(selected).not.toBe(before);
    intent.discovery.imageVariant = { ...selection, options: { ...selection.options, width: 640 } };
    expect(digestValue(IntentSchema.parse(intent))).not.toBe(selected);
  });
});
