import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { TEST_SECRET, TEST_SITEKEY } from '../apps/storefront-worker/src/turnstile.js';
for (const role of ['before', 'after'] as const) it(`${role}: literal privacy policies retain CSP and Turnstile boundaries`, async () => {
  const origin = `https://${role}.example.test`; const secret = 'header-only-synthetic-internal-secret';
  const env = { role, origin, releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret: secret, internalSecret: secret, labId: 'synthetic-lab',
    image: { id: 'synthetic-shirt', role, labId: 'synthetic-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'b'.repeat(64) },
    db: { prepare() { throw new Error('PRIVATE_HEADER_CANARY'); } }, bucket: {}, containers: {},
    turnstile: { config: { mode: role === 'before' ? 'disabled' : 'test', sitekey: role === 'before' ? null : TEST_SITEKEY, hostname: `${role}.example.test`, action: 'register' }, ...(role === 'after' ? { secret: TEST_SECRET } : {}) },
  } as unknown as StorefrontBindings;
  const app = createStorefrontWorker(env);
  for (const [path, status] of [['/health', 200], ['/register', 200], ['/internal/service-read', 400], ['/catalog', 500]] as const) {
    const response = await app.request(origin + path); expect(response.status).toBe(status);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()');
    const csp = response.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'"); expect(['sha256-s3qpCiuhUvlnaiAOpQ8fIytjpmJxGweY5Ze10ebZEBc=', 'sha256-lelB3bxDXGDZze+JVU2O8y0dLQZFpZZbXBf86SjKEnc='].some(hash => csp.includes(`style-src 'self' '${hash}'`))).toBe(true); expect(csp).not.toContain('unsafe-inline');
    expect(csp.includes('script-src https://challenges.cloudflare.com')).toBe(role === 'after'); expect(csp.includes('frame-src https://challenges.cloudflare.com')).toBe(role === 'after');
    expect(JSON.stringify([...response.headers])).not.toContain('PRIVATE_HEADER_CANARY'); expect(await response.text()).not.toContain('PRIVATE_HEADER_CANARY');
  }
});
