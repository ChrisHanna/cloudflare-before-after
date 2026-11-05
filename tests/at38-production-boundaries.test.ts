import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { collectTrustedImage } from '../packages/demo-core/src/trusted-collectors-image.js';
import { t38Bindings } from './t38-at11-14-bindings.js';
describe('AT38 production service readers with independent actual local boundaries', () => {
  it.each(['none', 'ingest', 'image'] as const)('both environments and boundary fault %s', async fault => {
    const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'p-')); const f = await t38Bindings(root, fault === 'ingest' ? fault : undefined);
    const ledger = new BudgetLedger({ limits: { requests: 30, cleanupRequests: 0, sessions: 8 } });
    const options = { config: f.config, ledger, mode: 'fixture' as const, credentials: f.credentials, observedOwnedResources: new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), dispatch: async (url: string, init: RequestInit) => {
      const response = await f.dispatch(url, init);
      if (fault === 'image' && new URL(url).origin === 'https://imagedelivery.net') return new Response('not-a-PNG', { headers: { 'content-type': 'image/png' } });
      return response;
    } };
    try {
      const collectors = createTrustedCollectors(options); const runId = randomUUID();
      for (const env of f.config.environments) {
        const requestId = randomUUID(); const now = new Date().toISOString();
        const services = await collectors.serviceRead({ role: env.role, runId, scenarioId: 'waf-custom', requestId, hostname: new URL(env.origin).hostname, releaseDigest: env.releaseDigest, start: new Date(Date.parse(now) - 1000).toISOString(), end: now });
        expect(services.mode).toBe('fixture');
        if (fault === 'ingest') {
          expect(services.state).not.toBe('observed'); expect(services.value?.operations ?? []).toEqual([]); expect(f.receipts).toHaveLength(0);
        } else {
          expect(services.state, JSON.stringify(services)).toBe('observed'); expect(services.value?.container?.requestCompleted).toBe(true);
          expect(services.value?.operations.map(o => o.service)).toEqual(['d1', 'r2', 'container']);
          expect(services.value?.serviceStates.images).toBe('unknown');
          const entered = f.receipts.find(r => r.runId === runId && r.requestId === requestId && r.stage === 'entry');
          expect(services.value?.container?.receipts.some(r => r.id === entered?.id)).toBe(true);
        }
        const asset = f.bindings.get(env.role)!.image;
        const image = await collectTrustedImage(options, { role: env.role, runId, scenarioId: 'waf-custom', requestId, releaseDigest: env.releaseDigest, resourceId: asset.id, deliveryAccount: asset.accountHash, variant: asset.variant });
        expect(image.mode).toBe('fixture');
        if (fault === 'image') { expect(image.state).not.toBe('observed'); expect(image.value).toBeNull(); }
        else { expect(image.state, JSON.stringify(image)).toBe('observed'); expect(image.value?.encodedDigest).toBe(asset.expectedDigest); expect(image.value?.source).toBe('observed-browser'); expect(image.value?.applicationJoin).toBe('unknown'); }
        // Independent source checks do not silently become deployed readiness.
        for (const secret of Object.values(f.credentials)) expect(JSON.stringify({ services, image })).not.toContain(secret);
      }
      expect(ledger.snapshot.requestsUsed).toBe(f.calls.length);
    } finally { ledger.stop(); await f.dispose(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);
});
