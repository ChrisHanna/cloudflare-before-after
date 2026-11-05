import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createContainerApp, receiptSender } from '../apps/storefront-container/src/app.js';
import { CATALOG_SEED } from '../apps/storefront-worker/src/d1.js';
import { fixtureReservationHeaders } from './container-restart-sequence-fixture.js';
const secret = 'fixture-internal-service-secret-only';
function fixture() {
  const runId = randomUUID(); const receipts: any[] = [];
  const send = vi.fn(async (r: any) => { receipts.push(r); });
  const app = createContainerApp({ role: 'before', scenarioId: 'waf-custom', runId, producerId: 'fixture-producer', releaseDigest: 'a'.repeat(64), internalSecret: secret, sendReceipt: send });
  const body = { runId, requestId: randomUUID(), scenarioId: 'waf-custom', targetRole: 'before', rayId: null, operation: 'catalog', product: CATALOG_SEED, imageUrl: 'https://imagedelivery.net/owned/product/public', detail: 'Synthetic detail', registration: null };
  const request = (data = body, auth = secret) => app.request('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json', ...fixtureReservationHeaders(data, { producerId: 'fixture-producer', releaseDigest: 'a'.repeat(64), internalSecret: secret }) }, body: JSON.stringify(data) });
  return { app, runId, body, request, send, receipts };
}
describe('container-origin', () => {
  it('acknowledges entry before completing business work and preserves actual release identity', async () => {
    const { request, receipts, runId } = fixture();
    const response = await request(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runId, releaseDigest: 'a'.repeat(64) });
    expect(receipts.map(r => [r.stage, r.sequence])).toEqual([['entry', 1], ['completion', 2]]);
  });
  it('refuses foreign scope and unauthorized callers before operations', async () => {
    const f = fixture();
    expect((await f.request(f.body, 'wrong')).status).toBe(401);
    expect((await f.request({ ...f.body, runId: randomUUID() })).status).toBe(403);
    expect((await f.request({ ...f.body, targetRole: 'after' })).status).toBe(403);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('cannot render/persist an operation when receipt delivery fails', async () => {
    const f = fixture(); f.send.mockRejectedValue(new Error('secret-in-error'));
    const response = await f.request(); expect(response.status).toBe(503);
    const output = await response.text(); expect(output).toContain('unknown'); expect(output).not.toContain('secret-in-error'); expect(output).not.toContain('<html');
    expect(f.receipts).toHaveLength(0);
  });
  it('escapes inert signatures and returns only a synthetic scoped registration operation', async () => {
    const f = fixture(); const signature = "<script>alert('inert')</script> ' OR 1=1";
    const response = await f.request({ ...f.body, operation: 'registration', registration: { record_id: randomUUID(), display_name: 'synthetic-shopper', note: signature } } as any);
    const json = await response.json() as any;
    expect(json.html).not.toContain('<script>'); expect(json.html).toContain('&lt;script&gt;');
    expect(json.operation.value.note).toBe(signature);
    expect((await f.request({ ...f.body, detail: 'x'.repeat(9000) })).status).toBe(413);
    const other = fixture(); expect((await other.request(f.body)).status).toBe(403);
  });
  it('requires an authenticated exact receipt acknowledgment, not a generic 200', async () => {
    const f = fixture(); await f.request(); const receipt = f.receipts[0];
    const dispatch = vi.fn(async (_url: any, init: any) => { expect(init.headers.authorization).toBe(`Bearer ${secret}`); expect(init.redirect).toBe('error'); return new Response(null, { status: 204, headers: { 'x-receipt-id': receipt.id } }); });
    await receiptSender('https://receipts.example.test/ingest', secret, dispatch)(receipt);
    await expect(receiptSender('https://receipts.example.test/ingest', secret, async () => new Response('ok'))(receipt)).rejects.toThrow('acknowledgment');
    expect(() => receiptSender('http://evil.test', secret)).toThrow();
  });
});
