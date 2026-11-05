import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { imageVariantDeclaration, ImageVariantDeclarationSchema } from '../packages/demo-core/src/image-variant-view.js';
import { ImagesVariantPanel } from '../apps/command-center/src/ImagesVariantPanel.js';
import { CatalogSchema } from '../apps/command-center/src/api.js';
import { controlFixture } from './fixtures/control.js';
const selection = { source: 'existing-public-readonly' as const, id: 'public' as const, options: { fit: 'scale-down' as const, width: 1366, height: 768, metadata: 'none' as const }, neverRequireSignedURLs: false };
const fixtures: ReturnType<typeof controlFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.cleanup(); });
describe('local declared Images source disclosure, not live proof', () => {
  it('labels managed and shared sources without inventing verification', () => {
    const managed = imageVariantDeclaration({ labId: 'owned-lab' });
    expect(managed).toEqual({ id: 'owned-lab-catalog', source: 'managed-lab', readOnly: false, declared: true, liveVerified: false });
    const shared = imageVariantDeclaration({ labId: 'owned-lab', imageVariant: selection });
    const html = renderToStaticMarkup(React.createElement(ImagesVariantPanel, { view: shared }));
    expect(html).toContain('Shared · read-only'); expect(html).toContain('Not owned by this lab'); expect(html).toContain('Not a live readback');
    expect(html).toContain('1366'); expect(html).toContain('768'); expect(html).not.toContain('Lab-managed');
    expect(renderToStaticMarkup(React.createElement(ImagesVariantPanel, { view: undefined }))).toBe('');
  });
  it.each([undefined, selection])('projects only local config with zero target/provider probes (%j)', async imageVariant => {
    const f = controlFixture(); fixtures.push(f); if (imageVariant) f.config.imageVariant = imageVariant;
    await f.login(); const before = f.calls.length;
    const response = await f.request('/api/catalog'); const data = await response.json();
    expect(response.status).toBe(200); const parsed = CatalogSchema.parse(data);
    expect(parsed.imageVariant).toEqual(imageVariantDeclaration(f.config)); expect(parsed.imageVariant?.liveVerified).toBe(false);
    expect(f.calls).toHaveLength(before);
    for (const value of Object.values(f.credentials)) expect(JSON.stringify(data)).not.toContain(value);
    const { imageVariant: _removed, ...legacy } = data; expect(CatalogSchema.parse(legacy).imageVariant).toBeUndefined();
  });
  it('keeps unavailable configuration null instead of assuming public', async () => {
    const f = controlFixture({ demo: { mode: 'fixture', loadConfig: () => { throw new Error('private-config-canary'); } } }); fixtures.push(f);
    await f.login(); const response = await f.request('/api/catalog'); const data = await response.json();
    expect(data.imageVariant).toBeNull(); expect(data.configured).toBe(false); expect(JSON.stringify(data)).not.toContain('private-config-canary');
  });
  it('rejects forged live/read-only/ownership claims and unknown fields', () => {
    const shared = imageVariantDeclaration({ labId: 'owned-lab', imageVariant: selection });
    for (const candidate of [{ ...shared, liveVerified: true }, { ...shared, readOnly: false }, { ...shared, owned: true }, { ...shared, privateKey: 'not-exportable' }]) expect(ImageVariantDeclarationSchema.safeParse(candidate).success).toBe(false);
  });
});
