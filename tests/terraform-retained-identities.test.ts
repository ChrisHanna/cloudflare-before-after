import { describe, expect, it } from 'vitest';
import { terraformChanges } from '../packages/demo-core/src/terraform-plan.js';
import { deploymentIntent, rawTerraformPlan } from './fixtures/deployment.js';
const ids = { before: '11111111-1111-4111-8111-111111111111', after: '22222222-2222-4222-8222-222222222222' };
function fixture(publicMode: boolean) {
  const intent = deploymentIntent('/tmp/retained-plan-identity-fixture');
  if (publicMode) intent.discovery.imageVariant = { source: 'existing-public-readonly', id: 'public', options: { fit: 'scale-down', width: 1366, height: 768, metadata: 'none' }, neverRequireSignedURLs: false };
  const raw = rawTerraformPlan(intent, 'terraform-core');
  for (const resource of raw.resource_changes) {
    if (resource.address === 'cloudflare_image_variant.catalog') continue;
    const role = resource.address.endsWith('["before"]') ? 'before' : 'after';
    resource.change.actions = ['no-op']; resource.change.after.id = resource.address.startsWith('cloudflare_d1_database.') ? ids[role] : resource.change.after.name;
    resource.change.before = { ...resource.change.after }; resource.change.after_unknown = {};
  }
  return { intent, raw, d1: raw.resource_changes.find((r: any) => r.address.startsWith('cloudflare_d1_database.')), r2: raw.resource_changes.find((r: any) => r.address.startsWith('cloudflare_r2_bucket.')) };
}
describe.each([false, true])('qualified retained identities (public mode %s)', publicMode => {
  it('accepts known exact retained identities and explicit null unused identity metadata', () => {
    const f = fixture(publicMode);
    for (const r of f.raw.resource_changes) { r.before_identity = null; r.after_identity = null; r.change.before_identity = null; r.change.after_identity = null; }
    expect(terraformChanges(f.raw, f.intent, 'terraform-core').changes).toHaveLength(publicMode ? 4 : 5);
  });
  it.each(['missing', 'null', 'malformed', 'nil', 'unknown', 'contradictory', 'unknown-marker', 'no-before'] as const)('rejects %s retained D1 identity', kind => {
    const f = fixture(publicMode);
    if (kind === 'missing' || kind === 'unknown') { delete f.d1.change.before.id; delete f.d1.change.after.id; }
    if (kind === 'null') f.d1.change.before.id = f.d1.change.after.id = null;
    if (kind === 'malformed') f.d1.change.before.id = f.d1.change.after.id = 'not-a-d1-uuid';
    if (kind === 'nil') f.d1.change.before.id = f.d1.change.after.id = '00000000-0000-0000-0000-000000000000';
    if (kind === 'unknown' || kind === 'contradictory') f.d1.change.after_unknown.id = true;
    if (kind === 'unknown-marker') f.d1.change.after_unknown.id = null;
    if (kind === 'no-before') f.d1.change.before = null;
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow();
  });
  it.each(['missing', 'null', 'foreign', 'unknown'] as const)('rejects %s retained R2 identity', kind => {
    const f = fixture(publicMode);
    if (kind === 'missing') { delete f.r2.change.before.id; delete f.r2.change.after.id; }
    if (kind === 'null') f.r2.change.before.id = f.r2.change.after.id = null;
    if (kind === 'foreign') f.r2.change.before.id = f.r2.change.after.id = 'another-bucket';
    if (kind === 'unknown') f.r2.change.after_unknown.id = true;
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow();
  });
  it.each(['update', 'read'] as const)('requires qualified identities for %s too', action => {
    const f = fixture(publicMode); f.d1.change.actions = [action]; f.d1.change.before.id = f.d1.change.after.id = null;
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow();
  });
  it('rejects a duplicated known D1 identity across roles', () => {
    const f = fixture(publicMode);
    for (const r of f.raw.resource_changes.filter((r: any) => r.address.startsWith('cloudflare_d1_database.'))) r.change.before.id = r.change.after.id = ids.before;
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow('duplicate');
  });
  it.each([false, true])('rejects UUID spelling aliases with a known-create mixture %s', knownCreate => {
    const f = fixture(publicMode); const rows = f.raw.resource_changes.filter((r: any) => r.address.startsWith('cloudflare_d1_database.'));
    const lower = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    rows[0].change.before.id = rows[0].change.after.id = lower;
    rows[1].change.before.id = rows[1].change.after.id = lower.toUpperCase();
    if (knownCreate) { rows[1].change.actions = ['create']; rows[1].change.before = null; }
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow('duplicate');
  });
  it('accepts distinct valid UUIDs without rewriting their spelling', () => {
    const f = fixture(publicMode); const rows = f.raw.resource_changes.filter((r: any) => r.address.startsWith('cloudflare_d1_database.'));
    rows[0].change.before.id = rows[0].change.after.id = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    rows[1].change.before.id = rows[1].change.after.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const before = JSON.stringify(f.raw);
    expect(terraformChanges(f.raw, f.intent, 'terraform-core').changes).toHaveLength(publicMode ? 4 : 5);
    expect(JSON.stringify(f.raw)).toBe(before);
  });
  it.each(['before_identity', 'after_identity'] as const)('rejects unsupported non-null %s data in either location', field => {
    const f = fixture(publicMode); f.d1[field] = { id: 'unsupported-provider-identity' };
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow(); delete f.d1[field]; f.d1.change[field] = { id: 'unsupported-provider-identity' };
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow();
  });
  it('still permits fresh provider-generated IDs to be unknown, without claiming retained identity', () => {
    const f = fixture(publicMode); const fresh = rawTerraformPlan(f.intent, 'terraform-core');
    for (const r of fresh.resource_changes) if (r.address !== 'cloudflare_image_variant.catalog') { r.change.after.id = null; r.change.after_unknown = { id: true }; }
    expect(terraformChanges(fresh, f.intent, 'terraform-core').changes).toHaveLength(publicMode ? 4 : 5);
    const d1 = fresh.resource_changes.find((r: any) => r.address.startsWith('cloudflare_d1_database.')); d1.change.after.id = 'malformed-known-id';
    expect(() => terraformChanges(fresh, f.intent, 'terraform-core')).toThrow();
  });
  it('rejects create actions with retained before state instead of hiding a scope change', () => {
    const f = fixture(publicMode); f.d1.change.actions = ['create'];
    expect(() => terraformChanges(f.raw, f.intent, 'terraform-core')).toThrow('drift');
  });
});
