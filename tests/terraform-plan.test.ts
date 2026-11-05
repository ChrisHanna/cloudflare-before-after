import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { terraformChanges, prepareTerraformPlans, verifyTerraformPlans, type TerraformReadTool } from '../packages/demo-core/src/terraform-plan.js';
import { createDeploymentPlan, IntentSchema, type DeploymentIntent } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { labConfig } from './fixtures/lab.js';
const NOW = Date.parse('2026-11-04T00:00:00.000Z'); const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function intentFixture(root: string): DeploymentIntent {
  const runtime = labConfig(root); const { inventory: _inventory, environments, ...discovery } = runtime;
  return IntentSchema.parse({ schemaVersion: 1, discovery: { ...discovery, credentials: { ...discovery.credentials, deployer: 'env:LAB_DEPLOYER' }, environments: environments.map(({ role, origin }) => ({ role, origin })) }, profile: 'core', releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), costs: { currency: 'USD', month: '2026-11', observedAt: new Date(NOW).toISOString(), pricingAsOf: '2026-11-03', materialUnknowns: [], lines: ['existing-spend', 'remaining-commitments', 'renewals', 'new-subscriptions', 'usage', 'tax', 'reserve'].map(category => ({ category, label: category, thisMonthCents: 500, source: 'fixture', assumption: 'Synthetic complete estimate' })) }, priorModules: [], setup: { maxRuntimeMs: 10000, maxOperations: 100 } });
}
function rawPlan(intent: DeploymentIntent, kind: 'terraform-core' | 'terraform-routing'): any {
  const lab = intent.discovery.labId; const account = intent.discovery.accountId; const zone = intent.discovery.zoneId;
  const changes: any[] = []; let variables: any;
  const add = (address: string, after: any) => changes.push({ address, provider_name: 'registry.terraform.io/cloudflare/cloudflare', mode: 'managed', change: { actions: ['create'], before: null, after, after_unknown: {} } });
  if (kind === 'terraform-core') {
    for (const role of ['before', 'after']) { add(`cloudflare_d1_database.storefront["${role}"]`, { account_id: account, name: `${lab}-${role}-storefront` }); add(`cloudflare_r2_bucket.storefront["${role}"]`, { account_id: account, name: `${lab}-${role}-objects` }); }
    add('cloudflare_image_variant.catalog', { account_id: account, id: `${lab}-catalog` }); variables = { account_id: account, lab_id: lab };
  } else {
    const routes: any = {};
    for (const role of ['before', 'after', 'telemetry']) { const hostname = new URL(role === 'telemetry' ? intent.discovery.telemetryOrigin : intent.discovery.environments.find(e => e.role === role)!.origin).hostname; routes[role] = { hostname, worker_name: `${lab}-${role}` }; add(`cloudflare_workers_custom_domain.lab["${role}"]`, { account_id: account, zone_id: zone, hostname, service: `${lab}-${role}` }); }
    variables = { account_id: account, zone_id: zone, routes };
  }
  return { terraform_version: '1.17.1', resource_changes: changes, configuration: { fixture: true }, variables: Object.fromEntries(Object.entries(variables).map(([k, value]) => [k, { value }])) };
}
function workspace() {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'tf-review-')); roots.push(root);
  for (const part of ['infra/terraform', 'infra/terraform/routing']) { mkdirSync(join(root, part), { recursive: true }); writeFileSync(join(root, part, 'main.tf'), '# Fixture source; no provider executes in this test.'); writeFileSync(join(root, part, '.terraform.lock.hcl'), '# Fixture lock'); }
  return root;
}
describe('terraform-plan', () => {
  it('accepts only exact owned resource scopes and rejects destructive/foreign changes', () => {
    const root = workspace(); const intent = intentFixture(root);
    expect(terraformChanges(rawPlan(intent, 'terraform-core'), intent, 'terraform-core').changes).toHaveLength(5);
    expect(terraformChanges(rawPlan(intent, 'terraform-routing'), intent, 'terraform-routing').changes).toHaveLength(3);
    for (const change of [
      (p: any) => { p.resource_changes[0].change.actions = ['delete', 'create']; },
      (p: any) => { p.resource_changes[0].change.after.account_id = 'e'.repeat(32); },
      (p: any) => { p.resource_changes[0].change.after.name = 'production'; },
      (p: any) => { p.resource_changes[0].change.before = { ...p.resource_changes[0].change.after, name: 'production' }; },
      (p: any) => { p.resource_changes[0].address = 'cloudflare_ruleset.unowned'; },
      (p: any) => { p.variables.lab_id.value = 'foreign'; },
      (p: any) => { p.resource_changes.pop(); },
    ]) { const p = rawPlan(intent, 'terraform-core'); change(p); expect(() => terraformChanges(p, intent, 'terraform-core')).toThrow(); }
  });
  it('saves reviewed binary hashes and rejects drift without applying a recheck plan', async () => {
    const root = workspace(); const intent = intentFixture(root); const files = new Map<string, any>(); let drift = false;
    const calls: string[] = [];
    const tool: TerraformReadTool = { terraform: vi.fn(async (args: readonly string[], cwd: string) => {
      calls.push(args[0]!); const kind = cwd.endsWith('/core') ? 'terraform-core' : 'terraform-routing';
      if (args[0] === 'init') return 'initialized';
      if (args[0] === 'plan') {
        const path = args.find(a => a.startsWith('-out='))!.slice(5); writeFileSync(path, `fixture-binary-${kind}`);
        const raw = rawPlan(intent, kind); if (drift) raw.resource_changes[0].change.before = { ...raw.resource_changes[0].change.after, unexpectedPreviousValue: true }; files.set(path, raw); return 'planned';
      }
      if (args[0] === 'show') return JSON.stringify(files.get(args[2]!));
      throw new Error('Write tool operation is forbidden in fixture planning');
    }) };
    const artifacts = await prepareTerraformPlans(root, intent, tool);
    expect(artifacts).toHaveLength(2); expect(artifacts.every(a => a.size > 0 && a.digest.length === 64)).toBe(true);
    const capability = await discoverCapabilities(intent.discovery, 'core', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, undefined, new Date(NOW).toISOString());
    const plan = createDeploymentPlan(intent, capability, 'a'.repeat(64), root, NOW, ['core'], artifacts);
    await verifyTerraformPlans(root, plan, tool); expect(calls).not.toContain('apply');
    drift = true; await expect(verifyTerraformPlans(root, plan, tool)).rejects.toThrow('drift');
    drift = false; const path = join(intent.discovery.evidenceDirectory, 'deployment', artifacts[0]!.relativePath); writeFileSync(path, readFileSync(path, 'utf8') + 'tamper');
    await expect(verifyTerraformPlans(root, plan, tool)).rejects.toThrow('integrity');
    expect(calls.every(call => ['init', 'plan', 'show'].includes(call))).toBe(true);
  });
  it('blocks live approval until real plan artifacts exist', async () => {
    const root = workspace(); const intent = intentFixture(root);
    const capability = await discoverCapabilities(intent.discovery, 'core', { mode: 'live', inspect: async () => ({ state: 'available', source: 'fixture-simulated-live-metadata', reasons: [] }) }, undefined, new Date(NOW).toISOString());
    const plan = createDeploymentPlan(intent, capability, 'a'.repeat(64), root, NOW);
    expect(plan.status).toBe('blocked'); expect(plan.blockers).toContain('Live Terraform plan artifacts must be prepared and reviewed before approval');
  });
});
