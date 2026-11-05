import { describe, expect, it, vi } from 'vitest';
import { ApiCapabilityProvider, CAPABILITY_KEYS, capabilityDigest, discoverCapabilities, type CapabilityProvider, type Finding } from '../packages/demo-core/src/capabilities.js';
import { runLabCli } from '../packages/demo-core/src/lab-cli.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { CloudflareReader } from '../packages/demo-core/src/cloudflare.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { TestClock } from './fixtures/clock.js';
import { labConfig } from './fixtures/lab.js';
const available: Finding = { state: 'available', source: 'fixture-authoritative-observation', reasons: [] };
function provider(changes: Record<string, Finding> = {}): CapabilityProvider { return { mode: 'fixture', inspect: vi.fn(async key => changes[key] ?? available) }; }
function apiFixture(dispatch: (url: string, init: RequestInit) => Promise<Response>) {
  const config = labConfig(); config.liveOptIn = true;
  const ledger = new BudgetLedger({ clock: new TestClock() });
  const client = new GuardedClient(config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), dispatch });
  const p = new ApiCapabilityProvider(config, client, new CloudflareReader(client, 'fixture-reader'), { tooling: available, collectorConfigured: true, deploymentClient: client, deploymentToken: 'fixture-deployment-token' });
  return { config, ledger, client, p };
}
describe('capability-discovery', () => {
  it('AT-CAP-1: missing Enterprise capabilities do not block core but remain in the catalog', async () => {
    const p = provider({ 'bot-management': { state: 'not-entitled', source: 'fixture-explicit-entitlement', reasons: ['Enterprise access absent'] }, 'waiting-room': { state: 'not-entitled', source: 'fixture-explicit-entitlement', reasons: ['Waiting Room entitlement absent'] } });
    const core = await discoverCapabilities(labConfig(), 'core', p);
    expect(core.deployable).toBe(true); expect(core.includedModules).toEqual(['core']); expect(core.excludedModules).toHaveLength(11); expect(core.fullCatalogAvailable).toBe(false);
    const workshop = await discoverCapabilities(labConfig(), 'workshop', p);
    expect(workshop.deployable).toBe(true); expect(workshop.includedModules).not.toContain('bot'); expect(workshop.includedModules).not.toContain('waiting-room');
    expect(workshop.findings.map(f => f.product)).toEqual(CAPABILITY_KEYS);
  });
  it('AT-CAP-2: unresolved core and selected-module prerequisites prevent deployment', async () => {
    for (const key of ['d1', 'r2', 'images', 'containers', 'deployment-permissions', 'tooling']) {
      const snapshot = await discoverCapabilities(labConfig(), 'core', provider({ [key]: { state: 'unknown', source: 'fixture', reasons: ['Unresolved'] } }));
      expect(snapshot.deployable).toBe(false); expect(snapshot.blockers).toContain(key); expect(snapshot.includedModules).toEqual([]);
    }
    const missingWaf = provider({ 'custom-waf': { state: 'permission-denied', source: 'fixture', reasons: ['WAF write grant missing'] } });
    expect((await discoverCapabilities(labConfig(), 'core-waf', missingWaf)).deployable).toBe(false);
    expect((await discoverCapabilities(labConfig(), 'core', missingWaf)).deployable).toBe(true);
  });
  it('hashes functional capability drift, not observation timestamps', async () => {
    const a = await discoverCapabilities(labConfig(), 'core', provider(), undefined, '2026-11-04T00:00:00.000Z');
    const b = await discoverCapabilities(labConfig(), 'core', provider(), undefined, '2026-11-04T00:01:00.000Z');
    expect(capabilityDigest(a)).toBe(capabilityDigest(b));
    b.findings[0]!.state = 'unknown'; expect(capabilityDigest(a)).not.toBe(capabilityDigest(b));
  });
  it('classifies denied reads as permission gaps, not missing entitlements', async () => {
    const f = apiFixture(async () => new Response('{"success":false,"result":null,"errors":[{"code":10000,"message":"denied"}]}', { status: 403 }));
    for (const key of ['account', 'd1', 'waiting-room', 'deployment-permissions']) expect((await f.p.inspect(key)).state).toBe('permission-denied');
    f.ledger.stop();
  });
  it.each(['Containers Write', 'Workers Containers Write'])('uses scoped reads with %s and never probes writes', async containerPermission => {
    const names = ['Workers Scripts Write', 'D1 Write', 'Workers R2 Storage Write', 'Cloudflare Images Write', containerPermission, 'DNS Write', 'Zone WAF Write'];
    const config = labConfig();
    const dispatch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      const path = new URL(url).pathname;
      const id = 'f'.repeat(32);
      let result: unknown;
      if (path.endsWith('/tokens/verify')) result = { id, status: 'active' };
      else if (path.endsWith(`/tokens/${id}`)) result = { id, status: 'active', policies: names.map(name => ({ effect: 'allow', permission_groups: [{ id, name }], resources: { [name === 'DNS Write' || name === 'Zone WAF Write' ? `com.cloudflare.api.account.zone.${config.zoneId}` : `com.cloudflare.api.account.${config.accountId}`]: '*' } })) };
      else if (path.endsWith('/rulesets')) result = [];
      else result = { id: config.accountId };
      return new Response(JSON.stringify({ success: true, result, errors: [] }));
    });
    const f = apiFixture(dispatch);
    expect((await f.p.inspect('deployment-permissions')).state).toBe('available');
    expect((await f.p.inspect('custom-waf')).state).toBe('available');
    expect(dispatch).toHaveBeenCalledTimes(3);
    await expect(f.client.request({ url: 'https://before.example.test/catalog', kind: 'before' })).rejects.toThrow('Discovery');
    await expect(f.client.request({ url: `https://api.cloudflare.com/client/v4/accounts/${'e'.repeat(32)}`, kind: 'cloudflare' })).rejects.toThrow('Discovery');
    await expect(f.client.request({ url: `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/workers/scripts`, kind: 'cloudflare', method: 'POST', body: '{}' })).rejects.toThrow('read-only');
    f.ledger.stop();
  });
  it.each([undefined, false, true])('accepts documented wildcard grants only with owner opt-in (%s)', async optIn => {
    const id = 'f'.repeat(32);
    const names = ['Workers Scripts Write', 'D1 Write', 'Workers R2 Storage Write', 'Images Write', 'Workers Containers Write', 'DNS Write', 'Zone WAF Write'];
    const dispatch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET');
      const result = url.endsWith('/verify') ? { id, status: 'active' } : { id, status: 'active', policies: names.map(name => ({ effect: 'allow', permission_groups: [{ id, name }], resources: { [name === 'DNS Write' || name === 'Zone WAF Write' ? 'com.cloudflare.api.account.zone.*' : 'com.cloudflare.api.account.*']: '*' } })) };
      return Response.json({ success: true, result, errors: [] });
    });
    const f = apiFixture(dispatch);
    if (optIn !== undefined) f.config.credentials.allowBroadApiToken = optIn;
    expect((await f.p.inspect('deployment-permissions')).state).toBe(optIn ? 'available' : 'permission-denied');
    await expect(f.client.request({ url: `https://api.cloudflare.com/client/v4/accounts/${'e'.repeat(32)}`, kind: 'cloudflare' })).rejects.toThrow('Discovery');
    await expect(f.client.request({ url: `https://api.cloudflare.com/client/v4/zones/${'e'.repeat(32)}`, kind: 'cloudflare' })).rejects.toThrow('Discovery');
    expect(dispatch).toHaveBeenCalledTimes(2); f.ledger.stop();
  });
  it.each(['foreign', 'unknown-wildcard', 'deny', 'missing-permission'])('keeps %s grants blocked even with broad-token opt-in', async fault => {
    const id = 'f'.repeat(32);
    const names = ['Workers Scripts Write', 'D1 Write', 'Workers R2 Storage Write', 'Images Write', 'Workers Containers Write', 'DNS Write'];
    const f = apiFixture(async url => Response.json({ success: true, result: url.endsWith('/verify') ? { id, status: 'active' } : { id, status: 'active', policies: names.filter(name => fault !== 'missing-permission' || name !== 'D1 Write').map(name => ({ effect: fault === 'deny' ? 'deny' : 'allow', permission_groups: [{ id, name }], resources: { [fault === 'unknown-wildcard' ? '*' : fault === 'foreign' ? `com.cloudflare.api.account.${'e'.repeat(32)}` : name === 'DNS Write' ? 'com.cloudflare.api.account.zone.*' : 'com.cloudflare.api.account.*']: '*' } })) }, errors: [] }));
    f.config.credentials.allowBroadApiToken = true;
    expect((await f.p.inspect('deployment-permissions')).state).not.toBe('available'); f.ledger.stop();
  });
  it('does not infer a paid Containers entitlement from an empty successful application list', async () => {
    const unknown = apiFixture(async () => new Response(JSON.stringify({ success: true, result: [], errors: [] })));
    expect((await unknown.p.inspect('containers')).state).toBe('unknown'); unknown.ledger.stop();
    const active = apiFixture(async url => new Response(JSON.stringify({ success: true, result: url.endsWith('/subscriptions') ? [{ state: 'Paid', current_period_end: new Date(Date.now() + 86400000).toISOString(), rate_plan: { id: 'workers_paid' } }] : [], errors: [] })));
    expect((await active.p.inspect('containers')).state).toBe('available'); active.ledger.stop();
  });
  it('counts owned image reuse when checking capacity and refuses missing capacity', async () => {
    const base = labConfig();
    const enough = apiFixture(async url => {
      const existing = url.endsWith(`/${base.labId}-before-product`);
      const missing = url.endsWith(`/${base.labId}-after-product`);
      return new Response(JSON.stringify({ success: !missing, result: existing ? { id: `${base.labId}-before-product`, meta: { owner: `${base.labId}:before:immutable-catalog` } } : missing ? null : { count: { current: 1, allowed: 2 } }, errors: [] }), { status: missing ? 404 : 200 });
    });
    expect((await enough.p.inspect('images')).state).toBe('available'); enough.ledger.stop();
    const noCapacity = apiFixture(async url => new Response(JSON.stringify({ success: url.endsWith('/stats'), result: url.endsWith('/stats') ? { count: { current: 0, allowed: 0 } } : null, errors: [] }), { status: url.endsWith('/stats') ? 200 : 404 }));
    expect((await noCapacity.p.inspect('images')).state).toBe('unknown'); noCapacity.ledger.stop();
  });
  it('does not infer write permissions from account or service read success', async () => {
    const f = apiFixture(async () => new Response(JSON.stringify({ success: true, result: { id: 'f'.repeat(32), status: 'active', policies: [{ effect: 'allow', permission_groups: [{ id: 'e'.repeat(32), name: 'Account Settings Read' }], resources: { '*': '*' } }] }, errors: [] })));
    expect((await f.p.inspect('deployment-permissions')).state).toBe('permission-denied'); f.ledger.stop();
  });
  it('CLI supports profiles, honest JSON, dry-run isolation and bounded error output', async () => {
    const root = process.cwd(); const config = labConfig(); const close = vi.fn(); const makeProvider = vi.fn(() => ({ provider: provider(), close }));
    const deps = { projectRoot: root, loadConfig: () => config, provider: makeProvider };
    const dry = await runLabCli(['capabilities', '--config', '/fixture/config.json', '--dry-run', '--json'], deps);
    expect(JSON.parse(dry.output)).toMatchObject({ kind: 'planned', remoteWrites: 0, deploymentAuthorized: false }); expect(makeProvider).not.toHaveBeenCalled();
    const good = await runLabCli(['capabilities', '--config', '/fixture/config.json', '--profile', 'core-waf', '--json'], deps);
    expect(good.exitCode).toBe(0); expect(JSON.parse(good.output).profile).toBe('core-waf'); expect(close).toHaveBeenCalledOnce();
    const bad = await runLabCli(['capabilities', '--config', '/fixture/config.json', '--profile', 'production', '--json'], deps);
    expect(bad.exitCode).toBe(2); expect(JSON.parse(bad.output).remoteWrites).toBe(0);
    expect((await runLabCli(['capabilities', '--help'], deps)).output).toContain('No deployment');
  });
});
