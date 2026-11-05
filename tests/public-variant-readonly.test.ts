import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import { ApiCapabilityProvider } from '../packages/demo-core/src/capabilities.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { CloudflareReader } from '../packages/demo-core/src/cloudflare.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { CORE_VERSIONS, SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
import { ImageVariantSelectionSchema, type ImageVariantSelection } from '../packages/demo-core/src/image-variant-selection.js';
import { assertDeclaredPublicVariant, selectedVariantGroupSchema } from '../packages/demo-core/src/public-variant-readback.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
import { labConfig } from './fixtures/lab.js';
import { TestClock } from './fixtures/clock.js';

// Synthetic filesystem state only. Neither provider traffic nor real evidence is used.
const roots: string[] = [];
const close: (() => void)[] = [];
const selection = (): ImageVariantSelection => ({ source: 'existing-public-readonly', id: 'public', options: { fit: 'scale-down', width: 1366, height: 768, metadata: 'keep' }, neverRequireSignedURLs: true });
const publicVariant = () => { const { source: _source, ...variant } = selection(); return variant; };
const group = () => ({ variants: { public: publicVariant() } });
const roles = ['before', 'after'] as const;
const envelope = (result: unknown, status = 200, info?: unknown) => Response.json({ success: status === 200, result, errors: [], ...(info === undefined ? {} : { result_info: info }) }, { status });
function fixture(options: { managed?: boolean; noState?: boolean; defaultMode?: boolean } = {}) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('Owned KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'public-variant-')); roots.push(root);
  const intent = deploymentIntent(root); intent.discovery.labId = 'workshop-test';
  if (!options.defaultMode) intent.discovery.imageVariant = selection();
  const { inventory } = infrastructureFixture();
  if (!options.defaultMode) Object.assign(inventory, { image_variant: 'public', image_variant_source: 'existing-public-readonly' });
  const provider = 'provider["registry.terraform.io/cloudflare/cloudflare"]';
  const state = { version: 4, terraform_version: CORE_VERSIONS.terraform, serial: 6, lineage: '12345678-9abc-0def-1234-56789abcdef0', outputs: {}, check_results: null, resources: [
    { mode: 'managed', type: 'cloudflare_d1_database', name: 'storefront', provider, instances: roles.map(role => ({ schema_version: 500, index_key: role, attributes: { account_id: inventory.account_id, id: inventory.environments[role].database_id, name: inventory.environments[role].database_name } })) },
    { mode: 'managed', type: 'cloudflare_r2_bucket', name: 'storefront', provider, instances: roles.map(role => ({ schema_version: 500, index_key: role, attributes: { account_id: inventory.account_id, id: inventory.environments[role].bucket_name, name: inventory.environments[role].bucket_name } })) },
    ...(options.managed ? [{ mode: 'managed', type: 'cloudflare_image_variant', name: 'catalog', provider, instances: [{ schema_version: 500, attributes: { account_id: inventory.account_id, id: `${inventory.lab_id}-catalog`, options: { fit: 'contain', width: 64, height: 64, metadata: 'none' }, never_require_signed_urls: false } }] }] : []),
  ] };
  const statePath = join(intent.discovery.evidenceDirectory, 'deployment/work', intent.discovery.labId, 'core/terraform.tfstate');
  if (!options.noState) { mkdirSync(dirname(statePath), { recursive: true }); writeFileSync(statePath, JSON.stringify(state)); }
  const remote = { variants: group() as unknown, status: 200, info: undefined as unknown, wrongDatabase: false, missingBucket: false };
  const dispatch = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url); expect(u.origin).toBe('https://api.cloudflare.com');
    expect(u.pathname).toMatch(new RegExp(`^/client/v4/(accounts/${intent.discovery.accountId}|zones/${intent.discovery.zoneId})/`));
    expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    if (u.pathname.endsWith('/images/v1/variants')) return envelope(remote.variants, remote.status, remote.info);
    if (u.pathname.endsWith('/d1/database')) return envelope(options.noState ? [] : roles.map(role => ({ uuid: remote.wrongDatabase ? inventory.environments[role === 'before' ? 'after' : 'before'].database_id : inventory.environments[role].database_id, name: inventory.environments[role].database_name })));
    if (u.pathname.endsWith('/r2/buckets')) return envelope({ buckets: options.noState || remote.missingBucket ? [] : roles.map(role => ({ name: inventory.environments[role].bucket_name })) });
    if (u.pathname.includes('/d1/database/')) { const e = Object.values(inventory.environments).find(e => u.pathname.endsWith(`/${e.database_id}`)); if (e) return envelope({ uuid: e.database_id, name: e.database_name }); }
    if (u.pathname.includes('/images/v1/')) return envelope(null, 404);
    if (u.pathname.endsWith('/workers/scripts') || u.pathname.endsWith('/workers/domains') || u.pathname.endsWith('/dns_records')) return envelope([]);
    throw new Error('Unregistered offline public-variant path');
  });
  const api = new DeploymentApi(root, intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, dispatch); close.push(() => api.close());
  return { root, intent, inventory, state, statePath, remote, dispatch, api };
}
function capability(options: { defaultMode?: boolean; capacity?: number; reuse?: 'owned' | 'foreign'; group?: unknown; status?: number; info?: unknown; statsStatus?: number } = {}) {
  const config = labConfig(); config.liveOptIn = true;
  if (!options.defaultMode) config.imageVariant = selection();
  const remote = { group: options.group === undefined ? group() : options.group, status: options.status ?? 200, info: options.info };
  const dispatch = vi.fn(async (url: string, init: RequestInit) => {
    const u = new URL(url); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined();
    expect(u.origin).toBe('https://api.cloudflare.com'); expect(u.pathname).toContain(`/accounts/${config.accountId}/images/v1/`);
    if (u.pathname.endsWith('/stats')) return envelope({ count: { current: 0, allowed: options.capacity ?? 2 } }, options.statsStatus ?? 200);
    if (u.pathname.endsWith('/variants')) return envelope(remote.group, remote.status, remote.info);
    const role = roles.find(role => u.pathname.endsWith(`/${config.labId}-${role}-product`));
    if (!role) throw new Error('Unregistered Images capability path');
    return options.reuse ? envelope({ id: `${config.labId}-${role}-product`, meta: { owner: options.reuse === 'owned' ? `${config.labId}:${role}:immutable-catalog` : 'foreign', sourceDigest: SYNTHETIC_IMAGE_DIGEST } }) : envelope(null, 404);
  });
  const ledger = new BudgetLedger({ clock: new TestClock(), limits: { requests: 100 } }); close.push(() => ledger.stop());
  const client = new GuardedClient(config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), dispatch });
  const provider = new ApiCapabilityProvider(config, client, new CloudflareReader(client, FIXTURE_CREDENTIALS.reader), { tooling: { state: 'available', source: 'offline fixture', reasons: [] }, collectorConfigured: true });
  return { config, remote, dispatch, provider, ledger };
}
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); })); });
afterEach(() => { for (const fn of close.splice(0)) fn(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('selected public variant: pure, bounded, exact readback', () => {
  it('accepts the real name-keyed group and returns only the selected declaration', () => {
    const input = { variants: { public: publicVariant(), unrelated: { ...publicVariant(), id: 'unrelated', arbitrarySecretField: 'DO-NOT-RETAIN', options: { ...publicVariant().options, rotate: 90 } } } };
    const parsed = selectedVariantGroupSchema('public').parse(input);
    expect(parsed).toEqual(group()); expect(JSON.stringify(parsed)).not.toContain('DO-NOT-RETAIN'); expect(JSON.stringify(parsed)).not.toContain('unrelated');
    expect(() => assertDeclaredPublicVariant(parsed, selection())).not.toThrow();
    expect(selectedVariantGroupSchema('public').parse(parsed)).toEqual(parsed);
  });
  it.each(['rotate', 'quality', 'format', 'dpr', 'background', 'blur'])('rejects unknown selected transform %s before stripping', field => {
    const value = publicVariant(); Object.assign(value.options, { [field]: 90 });
    expect(() => selectedVariantGroupSchema('public').parse({ variants: { public: value } })).toThrow();
  });
  it.each(['width-zero', 'height-fraction', 'width-unbounded', 'missing-fit', 'missing-metadata', 'variant-extra'])('rejects unqualified selected settings: %s', fault => {
    const value = publicVariant();
    if (fault === 'width-zero') value.options.width = 0;
    if (fault === 'height-fraction') value.options.height = 1.5;
    if (fault === 'width-unbounded') value.options.width = 16385;
    if (fault === 'missing-fit') Reflect.deleteProperty(value.options, 'fit');
    if (fault === 'missing-metadata') Reflect.deleteProperty(value.options, 'metadata');
    if (fault === 'variant-extra') Object.assign(value, { externalOrigin: 'https://foreign.example' });
    expect(() => selectedVariantGroupSchema('public').parse({ variants: { public: value } })).toThrow();
  });
  it.each(['fit', 'width', 'height', 'metadata', 'signing', 'missing-signing'])('rejects selected %s drift even with an exact unrelated match', field => {
    const selected: Record<string, unknown> = publicVariant(); const options = selected.options as Record<string, unknown>;
    if (field === 'signing') selected.neverRequireSignedURLs = false;
    else if (field === 'missing-signing') delete selected.neverRequireSignedURLs;
    else options[field] = field === 'fit' ? 'cover' : field === 'metadata' ? 'none' : 64;
    const readback = selectedVariantGroupSchema('public').parse({ variants: { public: selected, unrelated: { ...publicVariant(), id: 'unrelated' } } });
    expect(() => assertDeclaredPublicVariant(readback, selection())).toThrow('missing or changed');
  });
  it.each([[], {}, { variants: [] }, { variants: { alias: publicVariant() } }, { variants: { public: { ...publicVariant(), id: 'alias' } } }, { variants: { public: publicVariant() }, cursor: 'next' }])('rejects malformed, ambiguous, or incomplete group %j', input => {
    expect(() => selectedVariantGroupSchema('public').parse(input)).toThrow();
  });
  it('does not infer selected settings or signing from unrelated variants', () => {
    const readback = selectedVariantGroupSchema('public').parse({ variants: { unrelated: { ...publicVariant(), id: 'unrelated' } } });
    expect(readback).toEqual({ variants: {} }); expect(() => assertDeclaredPublicVariant(readback, selection())).toThrow('missing or changed');
  });
  it('admits a complete 100-variant group and rejects 101 without a read retry', () => {
    const values: Record<string, unknown> = { public: publicVariant() };
    for (let n = 0; n < 99; n++) values[`v-${n}`] = { ...publicVariant(), id: `v-${n}` };
    expect(selectedVariantGroupSchema('public').parse({ variants: values })).toEqual(group());
    values.overflow = { ...publicVariant(), id: 'overflow' };
    expect(() => selectedVariantGroupSchema('public').parse({ variants: values })).toThrow();
  });
  it('keeps the explicit signing policy even when declared false', () => {
    const input = selection(); input.neverRequireSignedURLs = false;
    const value = publicVariant(); value.neverRequireSignedURLs = false;
    expect(() => assertDeclaredPublicVariant({ variants: { public: value } }, input)).not.toThrow();
    expect(() => assertDeclaredPublicVariant(group(), input)).toThrow();
  });
});

describe('offline setup: public is external and lab images stay owned', () => {
  it('reuses four retained D1/R2 objects unchanged, without public adoption or writes', async () => {
    const f = fixture(); const original = readFileSync(f.statePath); const before = JSON.stringify(f.remote.variants);
    await f.api.assertNoForeignCollisions();
    expect(readFileSync(f.statePath)).toEqual(original); expect(JSON.stringify(f.remote.variants)).toBe(before);
    expect(f.dispatch).toHaveBeenCalledTimes(8); expect(f.state.resources).toHaveLength(2);
    expect(f.dispatch.mock.calls.some(([url]) => url.includes('/variants/public'))).toBe(false);
  });
  it('admits public-only accounts without granting ownership to any object', async () => {
    const f = fixture({ noState: true }); await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
  });
  it('rejects public migration while trusted state owns a managed catalog variant', async () => {
    const f = fixture({ managed: true }); const before = readFileSync(f.statePath);
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('cannot replace a retained managed');
    expect(f.dispatch).not.toHaveBeenCalled(); expect(readFileSync(f.statePath)).toEqual(before);
  });
  it.each(['database', 'bucket'])('retains exact %s ownership checks in public mode', async fault => {
    const f = fixture(); f.remote.wrongDatabase = fault === 'database'; f.remote.missingBucket = fault === 'bucket';
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(fault === 'database' ? 'D1' : 'R2');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('does not adopt an unrelated unowned catalog variant or use it as a fallback', async () => {
    const f = fixture(); const value = { ...publicVariant(), id: `${f.intent.discovery.labId}-catalog` };
    f.remote.variants = { variants: { public: publicVariant(), [value.id]: value } };
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
    f.remote.variants = { variants: { [value.id]: value } };
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('missing or changed');
  });
  it('preserves the managed default collision path when no public selection exists', async () => {
    const f = fixture({ defaultMode: true });
    await expect(f.api.assertNoForeignCollisions()).resolves.toBeUndefined();
    const id = `${f.intent.discovery.labId}-catalog`;
    f.remote.variants = { variants: { public: publicVariant(), [id]: { id, options: { fit: 'contain', width: 64, height: 64, metadata: 'none' }, neverRequireSignedURLs: false } } };
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('variant is not owned');
  });
  it.each(['missing', 'changed', 'unknown-transform'])('fails closed on %s selected dependency', async fault => {
    const f = fixture(); const value = publicVariant();
    if (fault === 'missing') f.remote.variants = { variants: {} };
    else { if (fault === 'changed') value.options.width = 64; else Object.assign(value.options, { rotate: 90 }); f.remote.variants = { variants: { public: value } }; }
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.dispatch).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 429, 500])('rejects HTTP %s once without mutation or retry', async status => {
    const f = fixture(); f.remote.status = status;
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.dispatch).toHaveBeenCalledTimes(3);
  });
  it.each([{ page: 1, total_pages: 2 }, { cursor: 'next' }])('rejects partial group metadata %j without fetching another page', async info => {
    const f = fixture(); f.remote.info = info;
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow('incomplete'); expect(f.dispatch).toHaveBeenCalledTimes(3);
  });
  it('rechecks public before image ownership reads and after setup', async () => {
    const f = fixture(); await f.api.assertNoForeignCollisions(); await f.api.checkImagesBeforePlan();
    await f.api.readback(f.inventory, new AbortController().signal);
    const urls = f.dispatch.mock.calls.map(([url]) => url);
    expect(urls.filter(url => url.endsWith('/variants'))).toHaveLength(3);
    expect(urls.slice(8, 11).map(url => new URL(url).pathname.split('/').at(-1))).toEqual(['variants', 'workshop-test-before-product', 'workshop-test-after-product']);
    expect(urls.slice(11)[0]).toMatch(/\/variants$/);
  });
  it.each(['pre', 'post'])('fresh %s check blocks drift without repairing public', async phase => {
    const f = fixture(); await f.api.assertNoForeignCollisions();
    const changed = publicVariant(); changed.options.height = 64; f.remote.variants = { variants: { public: changed } };
    const count = f.dispatch.mock.calls.length;
    await expect(phase === 'pre' ? f.api.checkImagesBeforePlan() : f.api.readback(f.inventory, new AbortController().signal)).rejects.toThrow('missing or changed');
    expect(f.dispatch).toHaveBeenCalledTimes(count + 1);
  });
  it.each(['pre', 'post'])('fresh %s check blocks denied readback without retry', async phase => {
    const f = fixture(); await f.api.assertNoForeignCollisions(); f.remote.status = 403;
    const count = f.dispatch.mock.calls.length;
    await expect(phase === 'pre' ? f.api.checkImagesBeforePlan() : f.api.readback(f.inventory, new AbortController().signal)).rejects.toThrow();
    expect(f.dispatch).toHaveBeenCalledTimes(count + 1);
  });
  it.each(['identity', 'owner', 'digest'])('public dependency does not grant image ownership after %s drift', async fault => {
    const f = fixture(); const base = f.dispatch.getMockImplementation()!;
    f.dispatch.mockImplementation(async (url, init) => /\/images\/v1\/workshop-test-(before|after)-product$/.test(url)
      ? envelope({ id: fault === 'identity' ? 'foreign-image' : url.split('/').at(-1), meta: { owner: fault === 'owner' ? 'foreign' : `${f.intent.discovery.labId}:before:immutable-catalog`, sourceDigest: fault === 'digest' ? 'f'.repeat(64) : SYNTHETIC_IMAGE_DIGEST }, variants: ['https://imagedelivery.net/synthetic/foreign/public'] }) : base(url, init));
    await expect(f.api.checkImagesBeforePlan()).rejects.toThrow('Foreign or differing image');
    expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('rejects an arbitrary variant descriptor before any setup read', async () => {
    const f = fixture(); (f.intent.discovery.imageVariant as unknown as Record<string, unknown>).id = 'foreign';
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('keeps cancellation, deadline, close, and 100-request bounds', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.api.checkImagesBeforePlan(controller.signal)).rejects.toThrow(); expect(f.dispatch).not.toHaveBeenCalled();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120001);
    await expect(f.api.checkImagesBeforePlan()).rejects.toThrow('allowance'); expect(f.dispatch).not.toHaveBeenCalled(); clock.mockRestore();
    const bounded = fixture(); for (let n = 0; n < 12; n++) await bounded.api.assertNoForeignCollisions();
    await expect(bounded.api.assertNoForeignCollisions()).rejects.toThrow('allowance'); expect(bounded.dispatch).toHaveBeenCalledTimes(100);
    const closed = fixture(); closed.api.close(); await expect(closed.api.checkImagesBeforePlan()).rejects.toThrow('allowance'); expect(closed.dispatch).not.toHaveBeenCalled();
  });
  it('rejects oversized group bodies within the existing 65536-byte read bound', async () => {
    const f = fixture(); f.remote.variants = { variants: { public: { ...publicVariant(), arbitrary: 'x'.repeat(65536) } } };
    await expect(f.api.assertNoForeignCollisions()).rejects.toThrow(); expect(f.dispatch).toHaveBeenCalledTimes(3);
  });
});

describe('core Images capability needs both image capacity and the declared public dependency', () => {
  it('requires stats plus fresh matching public readback on every inspection', async () => {
    const f = capability(); expect((await f.provider.inspect('images')).state).toBe('available');
    const changed = publicVariant(); changed.options.width = 64; f.remote.group = { variants: { public: changed } };
    const finding = await f.provider.inspect('images'); expect(finding.state).toBe('unknown'); expect(JSON.stringify(finding)).not.toContain('1366');
    expect(f.dispatch.mock.calls.filter(([url]) => url.endsWith('/variants'))).toHaveLength(2);
    expect(f.dispatch.mock.calls.filter(([url]) => url.endsWith('/stats'))).toHaveLength(2);
  });
  it('accepts owned image reuse with no free upload slots only when public matches', async () => {
    const f = capability({ capacity: 0, reuse: 'owned' });
    expect((await f.provider.inspect('images')).state).toBe('available'); expect(f.dispatch).toHaveBeenCalledTimes(4);
    f.remote.group = { variants: {} }; expect((await f.provider.inspect('images')).state).toBe('unknown');
  });
  it.each([{ capacity: 0 }, { capacity: 0, reuse: 'foreign' as const }])('does not replace capacity or ownership checks with public success: %j', async options => {
    const f = capability(options); expect((await f.provider.inspect('images')).state).toBe('unknown');
  });
  it.each([401, 403])('keeps denied public HTTP %s as a permission gap, not missing entitlement', async status => {
    const f = capability({ status }); expect((await f.provider.inspect('images')).state).toBe('permission-denied'); expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it.each([null, {}, [], { variants: {} }])('keeps denied malformed result %j a permission gap without publishing it', async value => {
    const f = capability({ status: 403, group: value });
    expect((await f.provider.inspect('images')).state).toBe('permission-denied'); expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403])('does not skip denied Images stats HTTP %s in public mode', async statsStatus => {
    const f = capability({ statsStatus }); expect((await f.provider.inspect('images')).state).toBe('permission-denied'); expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500])('keeps public HTTP %s unknown with no read retries', async status => {
    const f = capability({ status }); expect((await f.provider.inspect('images')).state).toBe('unknown'); expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it.each([{ variants: {} }, { variants: { public: { ...publicVariant(), options: { ...publicVariant().options, rotate: 90 } } } }, { variants: { public: { ...publicVariant(), neverRequireSignedURLs: false } } }])('does not qualify an absent or unqualified public dependency: %j', async value => {
    const f = capability({ group: value }); expect((await f.provider.inspect('images')).state).toBe('unknown'); expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('rejects incomplete pagination without another read', async () => {
    const f = capability({ info: { page: 1, total_pages: 2 } }); expect((await f.provider.inspect('images')).state).toBe('unknown'); expect(f.dispatch).toHaveBeenCalledTimes(2);
  });
  it('keeps the default Images service and managed setup path unchanged', async () => {
    const f = capability({ defaultMode: true }); expect((await f.provider.inspect('images')).state).toBe('available'); expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(ImageVariantSelectionSchema.safeParse({ ...selection(), id: 'other' }).success).toBe(false);
  });
  it('does not leak unrelated arbitrary response fields into findings', async () => {
    const f = capability({ group: { variants: { public: publicVariant(), unrelated: { ...publicVariant(), id: 'unrelated', secret: 'DO-NOT-PUBLISH' } } } });
    const finding = await f.provider.inspect('images'); expect(finding.state).toBe('available'); expect(JSON.stringify(finding)).not.toContain('DO-NOT-PUBLISH'); expect(JSON.stringify(finding)).not.toContain('unrelated');
  });
  it('does not dispatch on cancelled discovery', async () => {
    const f = capability(); const controller = new AbortController(); controller.abort(); expect((await f.provider.inspect('images', controller.signal)).state).toBe('unknown'); expect(f.dispatch).not.toHaveBeenCalled();
  });
});
