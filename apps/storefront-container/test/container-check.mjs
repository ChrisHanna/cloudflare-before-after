import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { createContainerApp } from './dist/apps/storefront-container/src/app.js';
import { CATALOG_SEED } from './dist/apps/storefront-worker/src/d1.js';
const secret = 'container-only-fixture-internal-key';
function fixture(sendReceipt) {
  const runId = randomUUID();
  const events = [];
  const app = createContainerApp({ role: 'before', scenarioId: 'waf-custom', runId, producerId: 'local-container', releaseDigest: 'a'.repeat(64), internalSecret: secret, sendReceipt: sendReceipt ?? (async e => { events.push(e); }) });
  const payload = { runId, requestId: randomUUID(), scenarioId: 'waf-custom', targetRole: 'before', rayId: null, operation: 'catalog', product: CATALOG_SEED, imageUrl: 'https://imagedelivery.net/owned/shirt/public', detail: "<script>inert</script> ' OR 1=1", registration: null };
  let highWater = 0;
  const request = body => {
    const value = body ?? payload; const raw = JSON.stringify(value);
    // Trusted test-only issuer: the real deployment reserves these in DO storage.
    const encoded = JSON.stringify({ schemaVersion: 1, producerId: 'local-container', role: 'before', scenarioId: 'waf-custom', runId, releaseDigest: 'a'.repeat(64), requestId: value.requestId, payloadDigest: createHash('sha256').update(raw).digest('hex'), observedAt: new Date().toISOString(), entry: { id: randomUUID(), sequence: ++highWater }, completion: { id: randomUUID(), sequence: ++highWater } });
    const signature = createHmac('sha256', secret).update(`origin-receipt-reservation-v1\n${encoded}`).digest('hex');
    return app.request('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'x-origin-receipt-reservation': encoded, 'x-origin-receipt-signature': signature }, body: raw });
  };
  return { runId, events, payload, request };
}
await test('actual local Container: receipt order and escaped content', async () => {
  const f = fixture(); const response = await f.request(); assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.releaseDigest, 'a'.repeat(64));
  assert.match(body.html, /&lt;script&gt;/); assert.doesNotMatch(body.html, /<script>/);
  assert.deepEqual(f.events.map(e => [e.stage, e.sequence]), [['entry', 1], ['completion', 2]]);
});
await test('actual local Container: scope isolation', async () => {
  const a = fixture(); const b = fixture();
  assert.equal((await b.request(a.payload)).status, 403); assert.equal(b.events.length, 0);
});
await test('actual local Container: telemetry failure denies business output', async () => {
  const f = fixture(async () => { throw new Error('receipt unavailable'); });
  const response = await f.request(); assert.equal(response.status, 503);
  const body = await response.json(); assert.equal(body.originCoverage, 'unknown'); assert.equal(body.html, undefined);
});
