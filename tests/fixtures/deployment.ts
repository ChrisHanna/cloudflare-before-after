import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IntentSchema, type DeploymentIntent } from '../../packages/demo-core/src/deployment-plan.js';
import { labConfig } from './lab.js';
export const FIXTURE_CREDENTIALS = { reader: 'fixture-reader-secret-distinct-12345', collector: 'fixture-collector-secret-distinct-12345', deployer: 'fixture-deployer-secret-distinct-12345', runner: 'fixture-runner-secret-distinct-12345', setup: 'fixture-setup-root-distinct-12345' };
export function deploymentIntent(root: string, now = Date.now()): DeploymentIntent {
  const runtime = labConfig(root); const { inventory: _inventory, environments, ...discovery } = runtime;
  return IntentSchema.parse({ schemaVersion: 1, discovery: { ...discovery, liveOptIn: true, credentials: { ...discovery.credentials, deployer: 'env:LAB_DEPLOYER', runner: 'env:LAB_RUN_SECRET', setup: 'env:LAB_SETUP_SECRET' }, environments: environments.map(({ role, origin }) => ({ role, origin })) }, profile: 'core', releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), costs: { currency: 'USD', month: new Date(now).toISOString().slice(0, 7), observedAt: new Date(now).toISOString(), pricingAsOf: new Date(now).toISOString().slice(0, 10), materialUnknowns: [], lines: ['existing-spend', 'remaining-commitments', 'renewals', 'new-subscriptions', 'usage', 'tax', 'reserve'].map(category => ({ category, label: category, thisMonthCents: 500, source: 'fixture-only-pricing', assumption: 'Synthetic complete monthly estimate; not live billing proof' })) }, priorModules: [], setup: { maxRuntimeMs: 120000, maxOperations: 100 } });
}
export function minimalSourceTree(root: string) {
  for (const [file, text] of Object.entries({
    'apps/storefront-worker/src/deployed.ts': 'export default {};',
    'apps/storefront-worker/src/telemetry-deployed.ts': 'export default {};',
    'apps/storefront-container/Dockerfile': 'FROM scratch\n',
    'packages/test/src/index.ts': 'export const fixture = true;',
    'infra/terraform/main.tf': '# Fixture only',
    'infra/terraform/.terraform.lock.hcl': '# Fixture only',
    'infra/terraform/core-public/main.tf': '# Fixture read-only public source only',
    'infra/terraform/core-public/.terraform.lock.hcl': '# Fixture only',
    'infra/terraform/routing/main.tf': '# Fixture only',
    'infra/terraform/routing/.terraform.lock.hcl': '# Fixture only',
    'scripts/check-node.mjs': 'process.exitCode = 0;',
    'scenarios/catalog.ts': 'export const catalog = [];',
    'package.json': '{"name":"fixture","private":true,"type":"module"}',
    'pnpm-lock.yaml': 'lockfileVersion: "9.0"',
    'pnpm-workspace.yaml': 'packages: []',
    'tsconfig.json': '{}', 'tsconfig.build.json': '{}', '.dockerignore': 'node_modules\n.env\n',
  })) { const path = join(root, file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
}
export function rawTerraformPlan(intent: DeploymentIntent, kind: 'terraform-core' | 'terraform-routing'): any {
  const { labId, accountId, zoneId } = intent.discovery; const changes: any[] = [];
  const add = (address: string, after: any) => changes.push({ address, provider_name: 'registry.terraform.io/cloudflare/cloudflare', mode: 'managed', change: { actions: ['create'], before: null, after, after_unknown: {} } });
  let variables: any;
  if (kind === 'terraform-core') {
    for (const role of ['before', 'after']) { add(`cloudflare_d1_database.storefront["${role}"]`, { account_id: accountId, name: `${labId}-${role}-storefront` }); add(`cloudflare_r2_bucket.storefront["${role}"]`, { account_id: accountId, name: `${labId}-${role}-objects` }); }
    if (intent.discovery.imageVariant?.source !== 'existing-public-readonly') add('cloudflare_image_variant.catalog', { account_id: accountId, id: `${labId}-catalog` });
    variables = { account_id: accountId, lab_id: labId };
  } else {
    const routes: any = {};
    for (const role of ['before', 'after', 'telemetry']) { const origin = role === 'telemetry' ? intent.discovery.telemetryOrigin : intent.discovery.environments.find(e => e.role === role)!.origin; routes[role] = { hostname: new URL(origin).hostname, worker_name: `${labId}-${role}` }; add(`cloudflare_workers_custom_domain.lab["${role}"]`, { account_id: accountId, zone_id: zoneId, hostname: routes[role].hostname, service: routes[role].worker_name }); }
    variables = { account_id: accountId, zone_id: zoneId, routes };
  }
  return { terraform_version: '1.17.1', resource_changes: changes, configuration: { fixture: true }, variables: Object.fromEntries(Object.entries(variables).map(([k, value]) => [k, { value }])) };
}
