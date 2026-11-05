import { expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { CATALOG_SEED } from '../apps/storefront-worker/src/d1.js';
import { fixtureReservationHeaders } from './container-restart-sequence-fixture.js';
for (const role of ['before', 'after']) it(`${role}: real Node restart + native durable reservation/eviction + real SQL collector`, async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('tests/runtime/container-restart-sequence-runner.mjs'), ...(role === 'after' ? ['--after'] : [])], { cwd: resolve('.'), timeout: 90000, maxBuffer: 1024 * 1024 });
  expect(`${stdout}${stderr}`).not.toMatch(/PRIVATE_CANARY|Bearer /);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!); expect(result).toMatchObject({ kind: 'restart-sequence-repaired', role, cloudRequests: 0, uniqueConflict: false, productionHandler: true, version: 'workerd 2026-11-03' });
  expect(result.checks).toBeGreaterThanOrEqual(23); expect(result.actualNodeProcesses).toBeGreaterThanOrEqual(3); expect(result.binarySha256).toMatch(/^[a-f0-9]{64}$/);
}, 95000);
it('Node rejects unsigned, forged, unknown, foreign or body-swapped reservations before receipts', async () => {
  const internalSecret = 'guard-only-synthetic-internal-secret'; const runId = randomUUID(); const sendReceipt = vi.fn(async () => {});
  const options = { role: 'before' as const, scenarioId: 'analytics' as const, runId, producerId: 'synthetic-guard', releaseDigest: 'a'.repeat(64), internalSecret, sendReceipt };
  const app = createContainerApp(options); const body = { runId, requestId: randomUUID(), scenarioId: 'analytics', targetRole: 'before', rayId: null, operation: 'catalog', product: CATALOG_SEED, imageUrl: 'https://imagedelivery.net/synthetic/shirt/public', detail: 'Synthetic detail', registration: null };
  const valid = fixtureReservationHeaders(body, options); const value = JSON.parse(valid['x-origin-receipt-reservation']);
  const signed = (change: object) => { const encoded = JSON.stringify({ ...value, ...change }); return { 'x-origin-receipt-reservation': encoded, 'x-origin-receipt-signature': createHmac('sha256', internalSecret).update(`origin-receipt-reservation-v1\n${encoded}`).digest('hex') }; };
  const cases = [{}, { ...valid, 'x-origin-receipt-signature': '0'.repeat(64) }, { ...valid, 'x-origin-receipt-reservation': 'x'.repeat(2049) }, ...[{ role: 'after' }, { producerId: 'foreign' }, { scenarioId: 'waf-custom' }, { runId: randomUUID() }, { requestId: randomUUID() }, { releaseDigest: 'b'.repeat(64) }, { payloadDigest: 'b'.repeat(64) }, { provider: 'PRIVATE_CANARY' }, { completion: { ...value.completion, sequence: value.entry.sequence } }].map(signed)];
  for (const headers of cases) {
    const response = await app.request('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${internalSecret}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    expect(response.status).toBe(403); expect(await response.text()).not.toContain('PRIVATE_CANARY');
  }
  expect(sendReceipt).not.toHaveBeenCalled();
  const swapped = await app.request('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${internalSecret}`, 'content-type': 'application/json', ...valid }, body: JSON.stringify({ ...body, detail: 'changed body' }) }); expect(swapped.status).toBe(403); expect(sendReceipt).not.toHaveBeenCalled();
  const response = await app.request('/internal/render', { method: 'POST', headers: { authorization: `Bearer ${internalSecret}`, 'content-type': 'application/json', ...valid }, body: JSON.stringify(body) }); expect(response.status).toBe(200); expect(sendReceipt.mock.calls).toHaveLength(2);
});
