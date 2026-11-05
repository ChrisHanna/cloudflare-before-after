import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import { CORE_VERSIONS } from '../packages/demo-core/src/infrastructure.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import type { DeploymentIntent } from '../packages/demo-core/src/deployment-plan.js';

// All state files live in disposable scratch roots. All HTTP is injected.
const roots: string[] = [];
const apis: DeploymentApi[] = [];
const databaseIds = { before: '11111111-1111-4111-8111-111111111111', after: '22222222-2222-4222-8222-222222222222' };
const provider = 'provider["registry.terraform.io/cloudflare/cloudflare"]';
const roles = ['before', 'after'] as const;
const options = () => ({ fit: 'contain', width: 64, height: 64, metadata: 'none' });
const publicVariant = () => ({ id: 'public', options: { fit: 'scale-down', width: 1366, height: 768, metadata: 'keep' }, neverRequireSignedURLs: true });
const catalogVariant = (lab: string) => ({ id: `${lab}-catalog`, options: options(), neverRequireSignedURLs: false });

type Instance = { schema_version: number; index_key?: string; attributes: Record<string, unknown>; sensitive_attributes: unknown[]; [key: string]: unknown };
type Resource = { mode: string; type: string; name: string; provider: string; instances: Instance[]; [key: string]: unknown };
type State = { version: number; terraform_version: string; serial: number; lineage: string; outputs: Record<string, unknown>; resources: Resource[]; check_results: null; [key: string]: unknown };
function retainedState(intent: DeploymentIntent): State {
  const { labId, accountId } = intent.discovery;
  return {
    version: 4, terraform_version: CORE_VERSIONS.terraform, serial: 6,
    // Terraform accepts version-agnostic UUID lineages, unlike RFC z.uuid().
    lineage: '12345678-9abc-0def-1234-56789abcdef0', outputs: {}, check_results: null,
    resources: [
      { mode: 'managed', type: 'cloudflare_d1_database', name: 'storefront', provider, instances: roles.map(role => ({ schema_version: 500, index_key: role, attributes: { account_id: accountId, id: databaseIds[role], name: `${labId}-${role}-storefront`, created_at: '2026-01-01T00:00:00Z', read_replication: { mode: 'disabled' } }, sensitive_attributes: [] })) },
      { mode: 'managed', type: 'cloudflare_r2_bucket', name: 'storefront', provider, instances: roles.map(role => ({ schema_version: 500, index_key: role, attributes: { account_id: accountId, id: `${labId}-${role}-objects`, name: `${labId}-${role}-objects`, storage_class: 'Standard' }, sensitive_attributes: [] })) },
    ],
  };
}
function addVariant(state: State, intent: DeploymentIntent): void {
  state.resources.push({ mode: 'managed', type: 'cloudflare_image_variant', name: 'catalog', provider, instances: [{ schema_version: 500, attributes: { account_id: intent.discovery.accountId, id: `${intent.discovery.labId}-catalog`, options: options(), never_require_signed_urls: false }, sensitive_attributes: [] }] });
}
interface FixtureOptions {
  noState?: boolean;
  mutate?: (state: State, intent: DeploymentIntent) => void;
  databases?: (intent: DeploymentIntent) => unknown;
  buckets?: (intent: DeploymentIntent) => unknown;
  variants?: (intent: DeploymentIntent) => unknown;
  variantStatus?: number;
  variantInfo?: unknown;
}
function fixture(o: FixtureOptions = {}) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'recovery-ownership-')); roots.push(root);
  const intent = deploymentIntent(root); intent.discovery.labId = 'cf-recovery-test';
  const state = retainedState(intent); o.mutate?.(state, intent);
  const statePath = join(intent.discovery.evidenceDirectory, 'deployment/work', intent.discovery.labId, 'core/terraform.tfstate');
  mkdirSync(dirname(statePath), { recursive: true });
  if (!o.noState) writeFileSync(statePath, JSON.stringify(state));
  const variants = o.variants?.(intent) ?? { variants: { public: publicVariant() } };
  const calls: { path: string; method: string; query: string }[] = [];
  const dispatch = vi.fn(async (value: string, init: RequestInit) => {
    const u = new URL(value); calls.push({ path: u.pathname, method: init.method ?? '', query: u.search });
    expect(u.origin).toBe(intent.discovery.apiOrigin); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    const respond = (result: unknown, status = 200, info?: unknown) => Response.json({ success: status === 200, errors: [], result, ...(info === undefined ? {} : { result_info: info }) }, { status });
    if (u.pathname.endsWith('/d1/database')) return respond(o.databases?.(intent) ?? (o.noState ? [] : roles.map(role => ({ uuid: databaseIds[role], name: `${intent.discovery.labId}-${role}-storefront` }))));
    if (u.pathname.endsWith('/r2/buckets')) return respond(o.buckets?.(intent) ?? { buckets: o.noState ? [] : roles.map(role => ({ name: `${intent.discovery.labId}-${role}-objects` })) });
    if (u.pathname.endsWith('/images/v1/variants')) return respond(variants, o.variantStatus, o.variantInfo);
    if (u.pathname.endsWith('/workers/scripts') || u.pathname.endsWith('/workers/domains') || u.pathname.endsWith('/dns_records')) return respond([]);
    throw new Error('Unregistered mocked ownership path');
  });
  const api = new DeploymentApi(root, intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, dispatch); apis.push(api);
  return { root, intent, state, statePath, variants, api, calls, dispatch };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real HTTP forbidden in offline ownership tests'); })); });
afterEach(() => {
  for (const api of apis.splice(0)) api.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('offline recovery ownership: exact retained state and mocked GET-only reads', () => {
  it('reuses serial-6 two-D1/two-R2 state unchanged with no core outputs', async () => {
    const f = fixture(); const original = readFileSync(f.statePath);
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
    expect(readFileSync(f.statePath)).toEqual(original); expect(f.state.outputs).toEqual({});
    expect(f.calls).toHaveLength(8); expect(f.calls.every(c => c.method === 'GET')).toBe(true);
    expect(f.calls.filter(c => c.path.endsWith('/images/v1/variants'))).toHaveLength(1);
    expect(f.calls.some(c => c.path.includes('/variants/public'))).toBe(false);
    expect(f.calls[0]!.query).toBe('?per_page=100&page=1');
    expect(f.calls[1]!.query).toBe('?per_page=100');
    expect(existsSync(join(f.intent.discovery.evidenceDirectory, 'leases'))).toBe(false);
    expect(existsSync(join(f.intent.discovery.evidenceDirectory, 'deployment/plans'))).toBe(false);
  });
  it('rejects duplicate retained UUID aliases before any provider read', async () => {
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const f = fixture({ mutate: state => {
      const rows = state.resources.find(r => r.type === 'cloudflare_d1_database')!.instances;
      rows[0]!.attributes.id = lower; rows[1]!.attributes.id = lower.toUpperCase();
    } });
    const before = readFileSync(f.statePath);
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Invalid retained');
    expect(f.calls).toEqual([]); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it('rejects alias duplicates in provider database rows without claiming ownership', async () => {
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const f = fixture({ noState: true, databases: () => [{ uuid: lower, name: 'unrelated-one' }, { uuid: lower.toUpperCase(), name: 'unrelated-two' }] });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Duplicate');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true); expect(existsSync(f.statePath)).toBe(false);
  });
  it('keeps distinct uppercase UUID spelling intact when state and API agree', async () => {
    const upper = { before: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', after: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB' };
    const f = fixture({ mutate: state => {
      for (const row of state.resources.find(r => r.type === 'cloudflare_d1_database')!.instances) row.attributes.id = upper[row.index_key as 'before' | 'after'];
    }, databases: intent => roles.map(role => ({ uuid: upper[role], name: `${intent.discovery.labId}-${role}-storefront` })) });
    const before = readFileSync(f.statePath); await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
    expect(readFileSync(f.statePath)).toEqual(before);
  });
  it('admits a new lab with only an unrelated public variant and no state', async () => {
    const f = fixture({ noState: true }); const before = JSON.stringify(f.variants);
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
    expect(existsSync(f.statePath)).toBe(false); expect(JSON.stringify(f.variants)).toBe(before);
    expect(f.calls).toHaveLength(8);
  });
  it('admits valid empty state without granting ownership to any resource', async () => {
    const f = fixture({ mutate: s => { s.resources = []; s.serial = 0; }, databases: () => [], buckets: () => ({ buckets: [] }) });
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
  });
  it('admits a valid partial apply with one D1 and one R2 while preserving state', async () => {
    const f = fixture({ mutate: s => { for (const r of s.resources) r.instances = r.instances.slice(0, 1); s.serial = 2; }, databases: i => [{ uuid: databaseIds.before, name: `${i.discovery.labId}-before-storefront` }], buckets: i => ({ buckets: [{ name: `${i.discovery.labId}-before-objects` }] }) });
    const before = readFileSync(f.statePath); await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined(); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it('admits the catalog variant only with matching exact scalar state and options', async () => {
    const f = fixture({ mutate: addVariant, variants: i => ({ variants: { public: publicVariant(), [`${i.discovery.labId}-catalog`]: catalogVariant(i.discovery.labId) } }) });
    const before = readFileSync(f.statePath); await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined(); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it.each([false, true])('rejects same-name variant outside state (noState=%s) without touching public', async noState => {
    const f = fixture({ noState, variants: i => ({ variants: { public: publicVariant(), [`${i.discovery.labId}-catalog`]: catalogVariant(i.discovery.labId) } }) });
    const before = JSON.stringify(f.variants);
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Images variant is not owned');
    expect(f.calls).toHaveLength(3); expect(f.calls.at(-1)!.path).toMatch(/\/images\/v1\/variants$/); expect(JSON.stringify(f.variants)).toBe(before);
  });
  it('does not trust forged output inventory as ownership', async () => {
    const f = fixture({ mutate: s => { s.resources = []; s.outputs = { core_inventory: { value: { forged: true } } }; } });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('D1');
  });
  it('rejects a retained variant absent from the group list instead of recreating it', async () => {
    const f = fixture({ mutate: addVariant }); await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Retained Images variant'); expect(f.calls).toHaveLength(3);
  });
  it.each(['fit', 'width', 'height', 'metadata', 'signing', 'missing-signing'])('rejects retained variant with changed %s', async field => {
    const f = fixture({ mutate: addVariant, variants: i => {
      const variant: Record<string, unknown> = catalogVariant(i.discovery.labId); const opts = variant.options as Record<string, unknown>;
      if (field === 'signing') variant.neverRequireSignedURLs = true;
      else if (field === 'missing-signing') delete variant.neverRequireSignedURLs;
      else opts[field] = field === 'fit' ? 'cover' : field === 'metadata' ? 'keep' : 128;
      return { variants: { public: publicVariant(), [`${i.discovery.labId}-catalog`]: variant } };
    } });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Retained Images variant');
  });

  const invalidState: [string, (s: State) => void][] = [
    ['state format', s => { s.version = 3; }],
    ['Terraform version', s => { s.terraform_version = '1.0.0'; }],
    ['missing lineage', s => { delete (s as Partial<State>).lineage; }],
    ['malformed lineage', s => { s.lineage = 'forged-lineage'; }],
    ['nil lineage', s => { s.lineage = '00000000-0000-0000-0000-000000000000'; }],
    ['negative serial', s => { s.serial = -1; }],
    ['fractional serial', s => { s.serial = 1.5; }],
    ['unsafe serial', s => { s.serial = Number.MAX_SAFE_INTEGER + 1; }],
    ['zero nonempty serial', s => { s.serial = 0; }],
    ['missing serial', s => { delete (s as Partial<State>).serial; }],
    ['foreign backend', s => { s.backend = { type: 'remote' }; }],
    ['data resource', s => { s.resources[0]!.mode = 'data'; }],
    ['foreign type', s => { s.resources[0]!.type = 'cloudflare_workers_script'; }],
    ['foreign name', s => { s.resources[0]!.name = 'foreign'; }],
    ['type/name mismatch', s => { s.resources[0]!.name = 'catalog'; }],
    ['nested module', s => { s.resources[0]!.module = 'module.foreign'; }],
    ['provider alias', s => { s.resources[0]!.provider = 'provider["registry.terraform.io/cloudflare/cloudflare"].foreign'; }],
    ['foreign provider', s => { s.resources[0]!.provider = 'provider["registry.terraform.io/foreign/cloudflare"]'; }],
    ['duplicate resource', s => { s.resources.push(structuredClone(s.resources[0]!)); }],
    ['duplicate role', s => { s.resources[0]!.instances[1]!.index_key = 'before'; }],
    ['duplicate D1 ID', s => { s.resources[0]!.instances[1]!.attributes.id = databaseIds.before; }],
    ['missing role', s => { delete s.resources[0]!.instances[0]!.index_key; }],
    ['foreign role', s => { s.resources[0]!.instances[0]!.index_key = 'telemetry'; }],
    ['numeric role', s => { (s.resources[0]!.instances[0] as Record<string, unknown>).index_key = 0; }],
    ['foreign account', s => { s.resources[0]!.instances[0]!.attributes.account_id = 'f'.repeat(32); }],
    ['malformed D1 ID', s => { s.resources[0]!.instances[0]!.attributes.id = 'foreign'; }],
    ['nil D1 ID', s => { s.resources[0]!.instances[0]!.attributes.id = '00000000-0000-0000-0000-000000000000'; }],
    ['wrong D1 name', s => { s.resources[0]!.instances[0]!.attributes.name = 'foreign-storefront'; }],
    ['cross-role name', s => { s.resources[0]!.instances[0]!.attributes.name = s.resources[0]!.instances[1]!.attributes.name; }],
    ['wrong R2 ID', s => { s.resources[1]!.instances[0]!.attributes.id = 'foreign-objects'; }],
    ['wrong R2 name', s => { s.resources[1]!.instances[0]!.attributes.name = 'foreign-objects'; }],
    ['tainted instance', s => { s.resources[0]!.instances[0]!.status = 'tainted'; }],
    ['deposed instance', s => { s.resources[0]!.instances[0]!.deposed = 'deadbeef'; }],
    ['empty deposed marker', s => { s.resources[1]!.instances[0]!.deposed = ''; }],
    ['wrong schema version', s => { s.resources[0]!.instances[0]!.schema_version = 1; }],
    ['foreign dependency', s => { s.resources[0]!.instances[0]!.dependencies = ['module.foreign.cloudflare_d1_database.db']; }],
    ['unverified identity', s => { s.resources[0]!.instances[0]!.identity = { id: 'foreign' }; }],
    ['empty resource block', s => { s.resources[0]!.instances = []; }],
  ];
  it.each(invalidState)('rejects %s before any mocked API call', async (_label, mutate) => {
    const f = fixture({ mutate }); const before = readFileSync(f.statePath);
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Invalid retained core ownership state');
    expect(f.dispatch).not.toHaveBeenCalled(); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it.each(['public-id', 'indexed', 'tainted', 'duplicate', 'wrong-options', 'signed'] as const)('rejects forged retained variant %s before reads', async fault => {
    const f = fixture({ mutate: (s, intent) => {
      addVariant(s, intent); const r = s.resources[2]!; const instance = r.instances[0]!;
      if (fault === 'public-id') instance.attributes.id = 'public';
      if (fault === 'indexed') instance.index_key = 'before';
      if (fault === 'tainted') instance.status = 'tainted';
      if (fault === 'duplicate') r.instances.push(structuredClone(instance));
      if (fault === 'wrong-options') instance.attributes.options = { ...options(), width: 128 };
      if (fault === 'signed') instance.attributes.never_require_signed_urls = true;
    } });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Invalid retained core ownership state'); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects cross-role D1 UUID swaps even when every ID belongs to the state set', async () => {
    const f = fixture({ databases: i => roles.map(role => ({ uuid: databaseIds[role === 'before' ? 'after' : 'before'], name: `${i.discovery.labId}-${role}-storefront` })) });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('D1'); expect(f.calls).toHaveLength(2);
  });
  it.each(['D1', 'R2'])('rejects retained %s missing from remote reads', async kind => {
    const f = fixture(kind === 'D1' ? { databases: () => [] } : { buckets: () => ({ buckets: [] }) });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(kind); expect(f.calls).toHaveLength(2);
  });
  it.each(['D1', 'R2'])('rejects foreign same-name %s without state', async kind => {
    const f = fixture({ noState: true, ...(kind === 'D1' ? { databases: (i: DeploymentIntent) => [{ uuid: databaseIds.before, name: `${i.discovery.labId}-before-storefront` }] } : { buckets: (i: DeploymentIntent) => ({ buckets: [{ name: `${i.discovery.labId}-before-objects` }] }) }) });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(kind);
  });
  it.each(['database-name', 'database-id', 'bucket'] as const)('rejects duplicate remote %s ownership', async fault => {
    const f = fixture({ databases: i => fault === 'bucket' ? roles.map(role => ({ uuid: databaseIds[role], name: `${i.discovery.labId}-${role}-storefront` })) : [{ uuid: databaseIds.before, name: `${i.discovery.labId}-before-storefront` }, { uuid: fault === 'database-id' ? databaseIds.before : databaseIds.after, name: fault === 'database-name' ? `${i.discovery.labId}-before-storefront` : `${i.discovery.labId}-after-storefront` }], buckets: i => ({ buckets: fault === 'bucket' ? [{ name: `${i.discovery.labId}-before-objects` }, { name: `${i.discovery.labId}-before-objects` }] : roles.map(role => ({ name: `${i.discovery.labId}-${role}-objects` })) }) });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Duplicate or ambiguous');
  });
  it.each(['array', 'missing-map', 'missing-id', 'wrong-id', 'bad-options', 'oversized-map', 'cursor'] as const)('rejects incomplete or malformed variant group %s', async fault => {
    const f = fixture({ variants: i => {
      if (fault === 'array') return [];
      if (fault === 'missing-map') return {};
      if (fault === 'missing-id') return { variants: { public: { options: options() } } };
      if (fault === 'wrong-id') return { variants: { public: catalogVariant(i.discovery.labId) } };
      if (fault === 'bad-options') return { variants: { public: { ...publicVariant(), options: { ...options(), width: 0 } } } };
      if (fault === 'cursor') return { variants: { public: publicVariant() }, cursor: 'next-page' };
      return { variants: Object.fromEntries(Array.from({ length: 101 }, (_, n) => [`variant-${n}`, { ...publicVariant(), id: `variant-${n}` }])) };
    } });
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.calls).toHaveLength(3);
  });
  it('accepts a complete 100-variant name-keyed group without a hero key', async () => {
    const f = fixture({ variants: () => ({ variants: Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`variant-${n}`, { ...publicVariant(), id: `variant-${n}` }])) }) });
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined(); expect(f.calls).toHaveLength(8);
  });
  it.each([{ page: 1, total_pages: 2 }, { cursor: 'next-page' }])('rejects incomplete variant result_info %j', async variantInfo => {
    const f = fixture({ variantInfo }); await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('incomplete'); expect(f.calls).toHaveLength(3);
  });
  it.each([403, 429, 500])('fails closed on variant HTTP %s without retry', async variantStatus => {
    const f = fixture({ variantStatus }); await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.calls).toHaveLength(3); expect(f.calls.filter(c => c.path.endsWith('/variants'))).toHaveLength(1);
  });
  it('bounds total reads across repeated checks', async () => {
    const f = fixture(); for (let n = 0; n < 12; n++) await f.api.assertNoForeignCollisions();
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('allowance'); expect(f.calls).toHaveLength(100);
  });
  it('does not dispatch on a cancelled check', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.api.assertNoForeignCollisions(controller.signal)).rejects.toThrow(); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it.each(['malformed-json', 'oversized', 'directory', 'symlink', 'dangling-symlink', 'hardlink'] as const)('rejects unsafe state file %s without reads', async fault => {
    const f = fixture(); const original = readFileSync(f.statePath); rmSync(f.statePath);
    if (fault === 'malformed-json') writeFileSync(f.statePath, '{invalid');
    if (fault === 'oversized') writeFileSync(f.statePath, Buffer.alloc(4 * 1024 * 1024 + 1));
    if (fault === 'directory') mkdirSync(f.statePath);
    if (fault === 'symlink' || fault === 'dangling-symlink' || fault === 'hardlink') {
      const target = join(f.root, 'synthetic-state-target.json'); if (fault !== 'dangling-symlink') writeFileSync(target, original);
      if (fault === 'hardlink') linkSync(target, f.statePath); else symlinkSync(target, f.statePath);
    }
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('Invalid retained core ownership state'); expect(f.dispatch).not.toHaveBeenCalled();
  });
});
