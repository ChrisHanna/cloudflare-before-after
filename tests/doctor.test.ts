import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runDoctor } from '../packages/demo-core/src/doctor.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
const roots: string[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden in Doctor tests'); })));
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(fault?: Parameters<typeof demoLabFixture>[1]) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'doctor-')); roots.push(root); return { root, ...demoLabFixture(root, fault) };
}
describe('doctor (fixture preflight, not deployed qualification)', () => {
  it('passes only the explicitly scoped healthy core-WAF prerequisites with bounded safe probes', async () => {
    const f = fixture(); const report = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
    expect(report.preflightReady).toBe(true); expect(report.scope).toBe('core-waf'); expect(report.mode).toBe('fixture'); expect(report.requestsUsed).toBe(24);
    expect(report.checks.every(c => c.state === 'passed')).toBe(true);
    expect(Object.values(report.claims).every(value => value === false)).toBe(true);
    expect(report.catalog.filter(c => c.state === 'unavailable')).toHaveLength(10);
    expect(report.observedOwnedResources).toEqual(expect.arrayContaining(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)));
    expect(f.targets()).toBe(2); expect(f.calls.filter(c => c.method !== 'GET').every(c => c.url.endsWith('/graphql') && c.method === 'POST')).toBe(true);
    expect(JSON.stringify(report)).not.toContain(f.canary); for (const secret of Object.values(f.credentials)) expect(JSON.stringify(report)).not.toContain(secret);
  });
  it('default catalog reporting stays nonready rather than dropping unavailable scenarios', async () => {
    const f = fixture(); const report = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', dispatch: f.dispatch });
    expect(report.scope).toBe('catalog'); expect(report.preflightReady).toBe(false); expect(report.catalog).toHaveLength(11); expect(report.catalog.find(c => c.id === 'waiting-room')?.state).toBe('unavailable');
  });
  it('reports binding/routing/policy/telemetry/image faults and never repairs them', async () => {
    for (const fault of ['binding', 'route', 'policy', 'telemetry', 'image'] as const) {
      const f = fixture(fault); const report = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
      expect(report.preflightReady, fault).toBe(false);
      expect(report.checks.some(c => c.state !== 'passed' && c.correctiveAction.length > 10)).toBe(true);
      expect(f.calls.every(c => c.method === 'GET' || c.url.endsWith('/graphql'))).toBe(true);
      if (fault === 'binding' || fault === 'route' || fault === 'policy') expect(f.targets()).toBe(0);
    }
  });
  it.each(['null', 'omitted', 'empty', 'bounded-array'] as const)('accepts successful %s errors across managed/public owner reads and drops raw messages', async shape => {
    for (const publicMode of [false, true]) {
      const f = fixture();
      const selection = { source: 'existing-public-readonly' as const, id: 'public' as const, options: { fit: 'scale-down' as const, width: 1366, height: 768, metadata: 'none' as const }, neverRequireSignedURLs: false };
      if (publicMode) f.config.imageVariant = selection;
      const canary = 'RAW_OWNER_ERRORS_MUST_NOT_SURVIVE';
      const isOwnerRead = (path: string) => path === `/client/v4/accounts/${f.config.accountId}` || path === `/client/v4/zones/${f.config.zoneId}`
        || /\/(?:workers\/domains|workers\/scripts\/[^/]+\/settings|d1\/database\/[^/]+|r2\/buckets\/[^/]+|images\/v1\/[^/]+|containers\/applications)$/.test(path);
      const spy = vi.spyOn(GuardedClient.prototype, 'requestJson');
      const dispatch = vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url); let response: Response;
        if (publicMode && u.pathname.endsWith('/images/v1/variants')) {
          const { source: _source, ...actual } = selection;
          response = Response.json({ success: true, result: { variants: { public: actual } }, errors: [] });
        } else response = await f.dispatch(url, init);
        if (u.origin !== f.config.apiOrigin || !isOwnerRead(u.pathname)) return response;
        const data = await response.json() as any;
        if (publicMode && u.pathname.includes('/workers/scripts/')) for (const binding of data.result.bindings) if (binding.name === 'IMAGE_ASSET_JSON') {
          binding.text = JSON.stringify({ ...JSON.parse(binding.text), variant: 'public' });
        }
        if (shape === 'omitted') delete data.errors;
        else data.errors = shape === 'null' ? null : shape === 'empty' ? [] : [{ code: 1234, message: canary }];
        return Response.json(data, { status: response.status });
      });
      const report = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch });
      expect(report.preflightReady).toBe(true); expect(report.requestsUsed).toBe(publicMode ? 26 : 24);
      expect(dispatch).toHaveBeenCalledTimes(report.requestsUsed);
      expect(report.checks.every(check => check.state === 'passed')).toBe(true);
      for (let index = 0; index < spy.mock.calls.length; index++) {
        const request = spy.mock.calls[index]![0]; if (!isOwnerRead(new URL(request.url).pathname)) continue;
        const result = spy.mock.results[index]!;
        if (result.type !== 'return') throw new Error('Unexpected mocked read failure');
        const response = await result.value;
        expect(response.data).toHaveProperty('errors', []); expect(response.excerpt).not.toContain(canary);
        expect(JSON.stringify(response.data)).not.toContain(canary);
      }
      expect(JSON.stringify(report)).not.toContain(canary); expect(Object.values(report.claims).every(claim => claim === false)).toBe(true);
      expect(fetch).not.toHaveBeenCalled(); spy.mockRestore();
    }
  });
  it.each(['null', 'omitted'] as const)('keeps denied/malformed/partial/scope checks with %s errors', async shape => {
    for (const fault of ['http-denied', 'success-false', 'null-result', 'missing-result', 'malformed-result', 'malformed-errors', 'partial-pages', 'cursor', 'wrong-page', 'wrong-service', 'duplicate-domain', 'wrong-account', 'wrong-zone'] as const) {
      const f = fixture(); const canary = 'RAW_FAILED_OWNER_ERROR';
      const dispatch = async (url: string, init: RequestInit) => {
        const response = await f.dispatch(url, init); const path = new URL(url).pathname;
        const target = fault === 'wrong-account' ? `/client/v4/accounts/${f.config.accountId}` : fault === 'wrong-zone' ? `/client/v4/zones/${f.config.zoneId}` : '/workers/domains';
        if (!path.endsWith(target)) return response;
        const data = await response.json() as any;
        if (shape === 'null') data.errors = null; else delete data.errors;
        if (fault === 'success-false' || fault === 'http-denied') data.success = false;
        if (fault === 'null-result') data.result = null;
        if (fault === 'missing-result') delete data.result;
        if (fault === 'malformed-result') data.result = { private: canary };
        if (fault === 'malformed-errors') data.errors = [{ code: 'not-a-number', message: canary }];
        if (fault === 'partial-pages') data.result_info = { page: 1, total_pages: 2 };
        if (fault === 'cursor') data.result_info = { cursor: canary };
        if (fault === 'wrong-page') data.result_info = { page: 2, total_pages: 2 };
        if (fault === 'wrong-service') data.result[0].service = 'foreign-worker';
        if (fault === 'duplicate-domain') data.result.push(structuredClone(data.result[0]));
        if (fault === 'wrong-account') data.result.id = '0'.repeat(32);
        if (fault === 'wrong-zone') data.result.account.id = '0'.repeat(32);
        return Response.json(data, { status: fault === 'http-denied' ? 403 : 200 });
      };
      const report = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch });
      const checkId = fault === 'wrong-account' ? 'account' : fault === 'wrong-zone' ? 'zone' : 'hostname-routes';
      expect(report.preflightReady, `${shape}/${fault}`).toBe(false); expect(report.checks.find(check => check.id === checkId)?.state).not.toBe('passed');
      expect(f.targets()).toBe(0); expect(f.calls.filter(call => new URL(call.url).pathname.endsWith('/workers/domains'))).toHaveLength(1);
      expect(JSON.stringify(report)).not.toContain(canary); expect(Object.values(report.claims).every(claim => claim === false)).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    }
  });
  it('rejects unsafe opt-in/budgets before any network call', async () => {
    const f = fixture();
    await expect(runDoctor({ projectRoot: f.root, config: { ...f.config, liveOptIn: false }, credentials: f.credentials, mode: 'fixture', dispatch: f.dispatch })).rejects.toThrow('opt-in');
    await expect(runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', dispatch: f.dispatch, limits: { requests: 10 } })).rejects.toThrow('fit');
    expect(f.calls).toEqual([]);
    // Refused configurations did not strand the lab lease.
    expect((await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch })).preflightReady).toBe(true);
  });
});
