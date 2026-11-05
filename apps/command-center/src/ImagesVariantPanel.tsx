import React from 'react';
import type { ImageVariantDeclaration } from '../../../packages/demo-core/src/image-variant-view.js';

export function ImagesVariantPanel({ view }: { view: ImageVariantDeclaration | null | undefined }) {
  if (!view) return null;
  return <section className="card" aria-label="Images variant declaration">
    <h2>Images variant</h2><p className="hostname">{view.id}</p>
    {view.source === 'existing-public-readonly' ? <>
      <span className="badge neutral">Shared · read-only</span>
      <p>Existing public variant. Not owned by this lab.</p>
      <dl>{[
        ['Fit', view.options.fit], ['Width', view.options.width], ['Height', view.options.height],
        ['Metadata', view.options.metadata], ['Always public override', String(view.neverRequireSignedURLs)],
      ].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </> : <span className="badge neutral">Lab-managed · declared</span>}
    <p className="small muted">Declared configuration only. Not a live readback.</p>
  </section>;
}
