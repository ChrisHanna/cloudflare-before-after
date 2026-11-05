import { expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { CATALOG_SEED } from '../apps/storefront-worker/src/d1.js';
import { contentDigest } from '../apps/storefront-worker/src/assets.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
for (const role of ['before', 'after'] as const) it(`${role}: owned responsive UI exact style bytes match actual Worker CSP`, async () => {
  const secret = 'ui-only-synthetic-internal-secret'; const runId = randomUUID(); const releaseDigest = 'a'.repeat(64); const receipts: any[] = [];
  const title = 'Synthetic <script>alert(1)</script> shirt'; const detail = 'Demo <img onerror="private-canary"> & details'; const digest = await contentDigest(detail);
  const container = (run: string) => createContainerApp({ role, scenarioId: 'analytics', runId: run, producerId: 'ui-synthetic-producer', releaseDigest, internalSecret: secret, sendReceipt: async value => { receipts.push(value); } });
  const env = { role, origin: `https://${role}.example.test`, releaseDigest, viewRunId: runId, runSecret: secret, internalSecret: secret, labId: 'synthetic-lab',
    db: { prepare() { return { bind() { return this; }, first: async () => ({ ...CATALOG_SEED, title }) }; } },
    bucket: { get: async () => ({ customMetadata: { digest, ownership: 'immutable-catalog', environment: role }, text: async () => detail }) },
    image: { id: 'synthetic-shirt', role, labId: 'synthetic-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'b'.repeat(64) },
    containers: { getByName(key: string) { const app = container(key.split(':')[2]!); return { fetch: async (request: Request) => app.fetch(await fixtureReservedRequest(request, { producerId: 'ui-synthetic-producer', releaseDigest, internalSecret: secret })) }; } },
  } as unknown as StorefrontBindings;
  const response = await createStorefrontWorker(env).request(`${env.origin}/catalog`); expect(response.status).toBe(200); const html = await response.text();
  const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]; expect(styles).toHaveLength(1); const css = styles[0]![1]!;
  const styleHash = `sha256-${createHash('sha256').update(css).digest('base64')}`;
  const csp = response.headers.get('content-security-policy')!; expect(csp.match(/style-src ([^;]+)/)?.[1]).toBe(`'self' '${styleHash}'`);
  expect(csp).not.toContain('unsafe-inline'); expect(csp).toContain("default-src 'none'"); expect(csp).toContain('img-src https://imagedelivery.net');
  const drift = `sha256-${createHash('sha256').update(css + '\n').digest('base64')}`; expect(csp).not.toContain(drift);
  expect(html).toContain(role === 'before' ? 'Before baseline' : 'After custom WAF lab'); expect(html).toContain('class="hero"'); expect(html).toContain('<figure>');
  expect(html).toContain('href="#main">Skip to content'); expect(html).toContain('<main id="main"'); expect(html).toContain('aria-labelledby="product-title"'); expect(html).toContain('id="product-details"');
  expect(html.match(/<h1\b/g)).toHaveLength(1); expect(html).toMatch(/<img[^>]+alt="[^\"]+"/); expect(css).toContain('@media(max-width:640px)'); expect(css).toContain(':focus-visible');
  expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img onerror='); expect(html).not.toMatch(/<script\b|<img onerror=|\sstyle=/i); expect(css).not.toMatch(/@import|url\(/i);
  expect(html).not.toContain(secret); expect(html).not.toMatch(/https:\/\/(?!imagedelivery\.net)/); expect(receipts.map(v => v.stage)).toEqual(['entry', 'completion']);
});
