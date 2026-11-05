import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoreInventorySchema, renderDeployment } from '../packages/demo-core/src/infrastructure.js';
import { ImageVariantSelectionSchema, type ImageVariantSelection } from '../packages/demo-core/src/image-variant-selection.js';
import { createDeploymentPlan, deploymentSteps, digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { terraformChanges, prepareTerraformPlans, verifyTerraformPlans, type TerraformReadTool } from '../packages/demo-core/src/terraform-plan.js';
import { freezeSource } from '../packages/demo-core/src/deployment-source.js';
import { deployedRuntimeConfig } from '../packages/demo-core/src/runtime-config.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { deploymentIntent, minimalSourceTree, rawTerraformPlan } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const publicSelection: ImageVariantSelection = { source: 'existing-public-readonly', id: 'public', options: { fit: 'cover', width: 320, height: 240, metadata: 'keep' }, neverRequireSignedURLs: true };
function fixture(publicMode = true) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'public-variant-plans-')); roots.push(root); minimalSourceTree(root);
  const intent = deploymentIntent(root); const { inventory, settings } = infrastructureFixture();
  intent.discovery.labId = inventory.lab_id;
  if (publicMode) {
    intent.discovery.imageVariant = structuredClone(publicSelection);
    inventory.image_variant = 'public'; inventory.image_variant_source = 'existing-public-readonly';
    settings.imageVariant = structuredClone(publicSelection);
    for (const role of ['before', 'after'] as const) settings.images[role].variant = 'public';
  }
  return { root, intent, inventory, settings };
}
async function snapshot(f: ReturnType<typeof fixture>) {
  return discoverCapabilities(f.intent.discovery, 'core', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'synthetic-only', reasons: [] }) });
}

describe('explicit read-only public variant plans (offline only)', () => {
  it('pins the alternate root with exactly the original D1/R2 addresses, no variant management', () => {
    const normal = join(process.cwd(), 'infra/terraform'); const alternate = join(normal, 'core-public');
    const files = readdirSync(normal).filter(name => name.endsWith('.tf') || name === '.terraform.lock.hcl').sort();
    expect(readdirSync(alternate).sort()).toEqual(files);
    for (const file of ['versions.tf', 'variables.tf', '.terraform.lock.hcl']) expect(readFileSync(join(alternate, file), 'utf8')).toBe(readFileSync(join(normal, file), 'utf8'));
    const main = readFileSync(join(alternate, 'main.tf'), 'utf8'); const managed = readFileSync(join(normal, 'main.tf'), 'utf8');
    const resources = (text: string) => [...text.matchAll(/^resource "([^"]+)" "([^"]+)" \{/gm)].map(match => `${match[1]}.${match[2]}`);
    expect(resources(main)).toEqual(['cloudflare_d1_database.storefront', 'cloudflare_r2_bucket.storefront']);
    for (const type of ['cloudflare_d1_database', 'cloudflare_r2_bucket']) {
      const block = new RegExp(`resource "${type}" "storefront" \\{[\\s\\S]*?^\\}`, 'm');
      expect(main.match(block)?.[0]).toBe(managed.match(block)?.[0]);
    }
    expect(main).not.toMatch(/^\s*(?:data|import|removed|moved|module|provisioner)\s+["{]/m);
    expect(main).not.toContain('cloudflare_image_variant');
    expect(main).toMatch(/image_variant\s*= "public"/); expect(main).toMatch(/image_variant_source\s*= "existing-public-readonly"/);
    expect(managed).toContain('resource "cloudflare_image_variant" "catalog"');
    expect(readFileSync(join(alternate, 'versions.tf'), 'utf8')).toContain('required_version = "= 1.17.1"');
    expect(readFileSync(join(alternate, '.terraform.lock.hcl'), 'utf8')).toContain('version     = "5.28.1"');
  });

  it.each([true, false])('keeps public=%s plan counts, routing and service steps exact', async publicMode => {
    const f = fixture(publicMode); const capability = await snapshot(f);
    const changes = terraformChanges(rawTerraformPlan(f.intent, 'terraform-core'), f.intent, 'terraform-core').changes;
    expect(changes).toHaveLength(publicMode ? 4 : 5);
    expect(terraformChanges(rawTerraformPlan(f.intent, 'terraform-routing'), f.intent, 'terraform-routing').changes).toHaveLength(3);
    const steps = deploymentSteps(f.intent, capability);
    expect(steps.find(step => step.kind === 'terraform-core')?.resources).toEqual([
      `${f.inventory.lab_id}-before-storefront`, `${f.inventory.lab_id}-after-storefront`, `${f.inventory.lab_id}-before-objects`, `${f.inventory.lab_id}-after-objects`, ...(publicMode ? [] : [`${f.inventory.lab_id}-catalog`]),
    ]);
    expect(steps.flatMap(step => step.resources)).not.toContain('public');
    expect(steps.find(step => step.kind === 'images-owned-upload')?.resources).toEqual(Object.values(f.inventory.environments).map(e => e.image_id));
    expect(steps.map(step => step.kind)).toEqual(['terraform-core', 'images-owned-upload', 'd1-migrations', 'wrangler-telemetry', 'wrangler-before', 'wrangler-after', 'provision-secrets', 'terraform-routing', 'seed-before', 'seed-after', 'readback']);
    const managedIntent = structuredClone(f.intent); delete managedIntent.discovery.imageVariant;
    if (publicMode) expect(digestValue(f.intent)).not.toBe(digestValue(managedIntent));
  });

  it.each(['create', 'update', 'no-op', 'read', 'delete', 'import'] as const)('rejects every %s ownership claim for the shared variant', action => {
    const f = fixture(); const raw = rawTerraformPlan(f.intent, 'terraform-core');
    raw.resource_changes[0] = { address: 'cloudflare_image_variant.catalog', provider_name: 'registry.terraform.io/cloudflare/cloudflare', mode: 'managed', change: { actions: [action === 'import' ? 'no-op' : action], before: null, after: { account_id: f.intent.discovery.accountId, id: 'public' }, ...(action === 'import' ? { importing: { id: 'public' } } : {}) } };
    expect(() => terraformChanges(raw, f.intent, 'terraform-core')).toThrow();
  });

  it.each(['delete-catalog', 'replace-d1', 'changed-uuid', 'import-d1', 'missing-resource', 'foreign-address', 'extra-catalog'] as const)('rejects public plan %s without masking a mode switch', fault => {
    const f = fixture(); const raw = rawTerraformPlan(f.intent, 'terraform-core'); const first = raw.resource_changes[0];
    if (fault === 'delete-catalog' || fault === 'extra-catalog') raw.resource_changes.push({ address: 'cloudflare_image_variant.catalog', provider_name: 'registry.terraform.io/cloudflare/cloudflare', mode: 'managed', change: { actions: [fault === 'delete-catalog' ? 'delete' : 'no-op'], before: { account_id: f.intent.discovery.accountId, id: `${f.inventory.lab_id}-catalog` }, after: fault === 'delete-catalog' ? null : { account_id: f.intent.discovery.accountId, id: `${f.inventory.lab_id}-catalog` } } });
    if (fault === 'replace-d1') first.change.actions = ['delete', 'create'];
    if (fault === 'changed-uuid') { first.change.before = { ...first.change.after, id: f.inventory.environments.before.database_id }; first.change.after.id = f.inventory.environments.after.database_id; }
    if (fault === 'import-d1') first.change.importing = { id: f.inventory.environments.before.database_id };
    if (fault === 'missing-resource') raw.resource_changes.pop();
    if (fault === 'foreign-address') first.address = 'cloudflare_d1_database.production';
    expect(() => terraformChanges(raw, f.intent, 'terraform-core')).toThrow();
  });

  it.each([true, false])('uses frozen public=%s source in the ORIGINAL core workspace, preserving synthetic state bytes', async publicMode => {
    const f = fixture(publicMode); const frozen = freezeSource(f.root, f.intent.discovery.evidenceDirectory);
    const workspace = join(f.intent.discovery.evidenceDirectory, 'deployment/work', f.intent.discovery.labId, 'core'); mkdirSync(workspace, { recursive: true });
    const syntheticState = JSON.stringify({ fixture: 'synthetic; not copied from live state', serial: 6, lineage: '12345678-9abc-0def-1234-56789abcdef0', resources: Object.entries(f.inventory.environments).flatMap(([role, e]) => [{ address: `cloudflare_d1_database.storefront["${role}"]`, id: e.database_id }, { address: `cloudflare_r2_bucket.storefront["${role}"]`, id: e.bucket_name }]) });
    const statePath = join(workspace, 'terraform.tfstate'); writeFileSync(statePath, syntheticState);
    const originalMain = '# Synthetic prior managed root; state must stay here'; writeFileSync(join(workspace, 'main.tf'), originalMain);
    const sourcePath = publicMode ? 'infra/terraform/core-public/main.tf' : 'infra/terraform/main.tf';
    writeFileSync(join(f.root, sourcePath), '# Changed checkout must not replace the frozen source');
    const files = new Map<string, unknown>(); const calls: { args: readonly string[]; cwd: string }[] = [];
    const tool: TerraformReadTool = { terraform: vi.fn(async (args: readonly string[], cwd: string) => {
      calls.push({ args, cwd }); const kind = cwd.endsWith('/core') ? 'terraform-core' : 'terraform-routing';
      if (args[0] === 'init') { expect(args).toContain('-lockfile=readonly'); return 'fixture init'; }
      if (args[0] === 'plan') {
        if (kind === 'terraform-core') {
          expect(cwd).toBe(workspace);
          expect(readFileSync(join(cwd, 'main.tf'), 'utf8')).toBe(readFileSync(join(frozen.path, sourcePath), 'utf8'));
          expect(readFileSync(statePath, 'utf8')).toBe(syntheticState);
        }
        const path = args.find(arg => arg.startsWith('-out='))!.slice(5); writeFileSync(path, `fixture-only-${kind}`);
        const raw = rawTerraformPlan(f.intent, kind);
        if (kind === 'terraform-core') for (const change of raw.resource_changes) {
          if (change.address === 'cloudflare_image_variant.catalog') continue;
          const role = change.address.endsWith('["before"]') ? 'before' : 'after';
          change.change.actions = ['no-op']; change.change.after.id = change.address.startsWith('cloudflare_d1_database') ? f.inventory.environments[role].database_id : f.inventory.environments[role].bucket_name;
          change.change.before = { ...change.change.after };
        }
        files.set(path, raw); return 'fixture plan';
      }
      if (args[0] === 'show') return JSON.stringify(files.get(args[2]!));
      throw new Error('No real Terraform operations allowed');
    }) };
    const artifacts = await prepareTerraformPlans(f.root, f.intent, tool, undefined, frozen.path);
    const plan = createDeploymentPlan(f.intent, await snapshot(f), frozen.digest, f.root, Date.now(), ['core'], artifacts);
    expect(plan.blockers).toEqual([]); await verifyTerraformPlans(f.root, plan, tool, undefined, frozen.path);
    expect(artifacts[0]!.changes.filter(change => change.actions[0] === 'no-op')).toHaveLength(4);
    expect(artifacts[0]!.changes).toHaveLength(publicMode ? 4 : 5);
    expect(readFileSync(statePath, 'utf8')).toBe(syntheticState);
    expect(new Set(calls.map(call => call.cwd))).toEqual(new Set([workspace, join(workspace, '../routing')]));
    expect(calls.every(call => ['init', 'plan', 'show'].includes(call.args[0]!))).toBe(true);
  });

  it('does not fall back to the managed source if the explicit public source is missing', async () => {
    const f = fixture(); rmSync(join(f.root, 'infra/terraform/core-public'), { recursive: true });
    const tool = { terraform: vi.fn(async () => { throw new Error('No tool should run'); }) };
    await expect(prepareTerraformPlans(f.root, f.intent, tool)).rejects.toThrow(); expect(tool.terraform).not.toHaveBeenCalled();
  });

  it.each([true, false])('retains explicit public rendering/runtime options with signed-URL flag %s', neverRequireSignedURLs => {
    const f = fixture(); f.intent.discovery.imageVariant!.neverRequireSignedURLs = neverRequireSignedURLs; f.settings.imageVariant!.neverRequireSignedURLs = neverRequireSignedURLs;
    const rendered = renderDeployment(f.inventory, f.settings, f.root);
    expect(rendered.imageVariant).toEqual(f.settings.imageVariant); expect(rendered.inventory.image_variant_source).toBe('existing-public-readonly');
    for (const environment of rendered.environments) {
      const expected = f.inventory.environments[environment.role]; const config = environment.config;
      expect(JSON.parse(config.vars.IMAGE_ASSET_JSON)).toMatchObject({ variant: 'public', id: expected.image_id, labId: f.inventory.lab_id });
      expect(JSON.parse(config.vars.IMAGE_VARIANT_SELECTION_JSON!)).toEqual(f.settings.imageVariant);
      expect(config.d1_databases[0]!.database_id).toBe(expected.database_id); expect(config.r2_buckets[0]!.bucket_name).toBe(expected.bucket_name);
      expect(config.containers[0]!.name).toBe(expected.container_name); expect(config.workers_dev).toBe(false);
    }
    const runtime = deployedRuntimeConfig(f.intent, f.inventory);
    expect(runtime.imageVariant).toEqual(f.intent.discovery.imageVariant);
    for (const environment of runtime.environments) {
      const expected = f.inventory.environments[environment.role];
      expect(environment.imageIds).toEqual([expected.image_id]); expect(environment.d1Id).toBe(expected.database_id); expect(environment.r2Bucket).toBe(expected.bucket_name);
    }
    expect(runtime.inventory.some(item => item.id === 'public')).toBe(false);
    expect(runtime.credentials).not.toHaveProperty('deployer'); expect(runtime.credentials).not.toHaveProperty('setup');
  });

  it.each(['unmarked-public', 'managed-with-source', 'implicit-public', 'intent-public-inventory-managed', 'wrong-image-id', 'wrong-image-variant', 'malformed-settings'] as const)('rejects %s instead of guessing or silently falling back', fault => {
    const f = fixture();
    if (fault === 'unmarked-public') delete f.inventory.image_variant_source;
    if (fault === 'managed-with-source' || fault === 'intent-public-inventory-managed') f.inventory.image_variant = `${f.inventory.lab_id}-catalog`;
    if (fault === 'intent-public-inventory-managed') delete f.inventory.image_variant_source;
    if (fault === 'implicit-public') { delete f.intent.discovery.imageVariant; delete f.settings.imageVariant; }
    if (fault === 'wrong-image-id') f.settings.images.before.id = 'foreign-image';
    if (fault === 'wrong-image-variant') f.settings.images.before.variant = `${f.inventory.lab_id}-catalog`;
    if (fault === 'malformed-settings') Object.assign(f.settings.imageVariant!, { id: 'other-variant' });
    expect(() => renderDeployment(f.inventory, f.settings, f.root)).toThrow();
    if (!['wrong-image-id', 'wrong-image-variant', 'malformed-settings'].includes(fault)) expect(() => deployedRuntimeConfig(f.intent, f.inventory)).toThrow();
    if (['unmarked-public', 'managed-with-source'].includes(fault)) expect(() => CoreInventorySchema.parse(f.inventory)).toThrow();
  });

  it('keeps default managed rendering and runtime shape unchanged', () => {
    const f = fixture(false); const rendered = renderDeployment(f.inventory, f.settings, f.root); const runtime = deployedRuntimeConfig(f.intent, f.inventory);
    expect(rendered.inventory.image_variant).toBe(`${f.inventory.lab_id}-catalog`); expect(rendered).not.toHaveProperty('imageVariant'); expect(runtime).not.toHaveProperty('imageVariant');
    expect(rendered.environments[0]!.config.vars).not.toHaveProperty('IMAGE_VARIANT_SELECTION_JSON');
    expect(ImageVariantSelectionSchema.parse(publicSelection)).toEqual(publicSelection);
  });
});
