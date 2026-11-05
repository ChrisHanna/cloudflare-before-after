import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, lstatSync, writeFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { PlanSchema, PreparedArtifactSchema, digestValue, type DeploymentIntent, type DeploymentPlan, type PreparedArtifact } from './deployment-plan.js';
import { validateEvidenceDirectory } from './config.js';
import { CORE_VERSIONS } from './infrastructure.js';
import { selectedImageVariantId } from './image-variant-selection.js';
const Action = z.enum(['no-op', 'create', 'update', 'read']);
const Change = z.object({ address: z.string().max(256), provider_name: z.literal('registry.terraform.io/cloudflare/cloudflare'), mode: z.literal('managed'), change: z.object({ actions: z.array(Action).min(1).max(1), before: z.union([z.record(z.string(), z.unknown()), z.null()]), after: z.record(z.string(), z.unknown()).nullable(), after_unknown: z.union([z.boolean(), z.record(z.string(), z.unknown())]).optional(), importing: z.never().optional(), before_identity: z.null().optional(), after_identity: z.null().optional() }), previous_address: z.never().optional(), before_identity: z.null().optional(), after_identity: z.null().optional() });
const TerraformJson = z.object({ terraform_version: z.literal(CORE_VERSIONS.terraform), resource_changes: z.array(Change).max(100).optional(), configuration: z.record(z.string(), z.unknown()), variables: z.record(z.string(), z.object({ value: z.unknown() })) });
export interface TerraformReadTool { terraform(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> }
export function terraformChanges(raw: unknown, intent: DeploymentIntent, kind: PreparedArtifact['kind']) {
  const value = TerraformJson.parse(raw); const lab = intent.discovery.labId;
  const expected = new Map<string, Record<string, unknown>>();
  if (kind === 'terraform-core') {
    for (const role of ['before', 'after']) {
      expected.set(`cloudflare_d1_database.storefront["${role}"]`, { account_id: intent.discovery.accountId, name: `${lab}-${role}-storefront` });
      expected.set(`cloudflare_r2_bucket.storefront["${role}"]`, { account_id: intent.discovery.accountId, name: `${lab}-${role}-objects` });
    }
    if (intent.discovery.imageVariant?.source !== 'existing-public-readonly') expected.set('cloudflare_image_variant.catalog', { account_id: intent.discovery.accountId, id: selectedImageVariantId(lab) });
  } else {
    for (const role of ['before', 'after', 'telemetry'] as const) {
      const origin = role === 'telemetry' ? intent.discovery.telemetryOrigin : intent.discovery.environments.find(e => e.role === role)!.origin;
      expected.set(`cloudflare_workers_custom_domain.lab["${role}"]`, { account_id: intent.discovery.accountId, zone_id: intent.discovery.zoneId, hostname: new URL(origin).hostname, service: `${lab}-${role}` });
    }
  }
  const changes = value.resource_changes ?? [];
  if (changes.length !== expected.size || new Set(changes.map(c => c.address)).size !== expected.size) throw new Error('Terraform plan resource scope differs from the declared core');
  const knownIds = new Set<string>();
  for (const change of changes) {
    const fields = expected.get(change.address); if (!fields || !change.change.after) throw new Error('Terraform plan includes an unowned or destructive operation');
    for (const [key, expectedValue] of Object.entries(fields)) {
      if (change.change.after[key] !== expectedValue || (change.change.before !== null && change.change.before[key] !== expectedValue)) throw new Error('Terraform resource ownership or hostname differs');
    }
    const beforeId = change.change.before?.id; const afterId = change.change.after.id;
    const mask = change.change.after_unknown; const idUnknown = typeof mask === 'boolean' ? mask : mask?.['id'];
    if (idUnknown !== undefined && typeof idUnknown !== 'boolean') throw new Error('Terraform identity drift: unqualified unknown-ID marker');
    const validId = (id: unknown): boolean => change.address.startsWith('cloudflare_d1_database.')
      ? z.uuid().refine(value => value !== '00000000-0000-0000-0000-000000000000').safeParse(id).success
      : change.address.startsWith('cloudflare_r2_bucket.') ? id === fields['name']
      : change.address === 'cloudflare_image_variant.catalog' ? id === fields['id']
      : z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/).safeParse(id).success;
    if (change.change.actions[0] === 'create') {
      if (change.change.before !== null) throw new Error('Terraform create-state drift; fresh create needs absent prior state');
      // Fresh provider-generated IDs can remain unknown, but not contradictory or malformed.
      if (afterId !== undefined && afterId !== null && (idUnknown === true || !validId(afterId))) throw new Error('Terraform new resource identity is unqualified');
    } else if (change.change.before === null || idUnknown === true || !validId(beforeId) || !validId(afterId) || beforeId !== afterId) {
      throw new Error('Terraform retained resource identity drift or unqualified ID');
    }
    if (afterId !== undefined && afterId !== null) {
      const type = change.address.split('.')[0]!;
      const identity = type === 'cloudflare_d1_database' ? String(afterId).toLowerCase() : String(afterId);
      const key = `${type}:${identity}`;
      if (knownIds.has(key)) throw new Error('Terraform duplicate resource identity'); knownIds.add(key);
    }
  }
  const variables: Record<string, unknown> = kind === 'terraform-core' ? { account_id: intent.discovery.accountId, lab_id: lab } : { account_id: intent.discovery.accountId, zone_id: intent.discovery.zoneId, routes: Object.fromEntries(['before', 'after', 'telemetry'].map(role => [role, { hostname: new URL(role === 'telemetry' ? intent.discovery.telemetryOrigin : intent.discovery.environments.find(e => e.role === role)!.origin).hostname, worker_name: `${lab}-${role}` }])) };
  if (digestValue(Object.fromEntries(Object.entries(value.variables).map(([k, v]) => [k, v.value]))) !== digestValue(variables)) throw new Error('Terraform plan variable scope differs from reviewed intent');
  // The full configuration joins the digest, including provider/provisioner blocks.
  // Applying requires equality with a fresh plan from the trusted pinned source copy.
  return { digest: digestValue({ changes, configuration: value.configuration, variables: value.variables }), changes: changes.map(c => ({ address: c.address, actions: c.change.actions })) };
}
function stagePaths(root: string, intent: DeploymentIntent, kind: PreparedArtifact['kind'], sourceRoot = root) {
  const stage = kind === 'terraform-core' ? 'core' : 'routing';
  const workspace = join(intent.discovery.evidenceDirectory, 'deployment', 'work', intent.discovery.labId, stage);
  validateEvidenceDirectory(workspace, root); mkdirSync(workspace, { recursive: true, mode: 0o700 }); validateEvidenceDirectory(workspace, root);
  // Public mode changes only the trusted source, never the existing state workspace.
  const coreSource = intent.discovery.imageVariant?.source === 'existing-public-readonly' ? 'infra/terraform/core-public' : 'infra/terraform';
  return { workspace, source: join(sourceRoot, kind === 'terraform-core' ? coreSource : 'infra/terraform/routing'), stage };
}
function copyConfiguration(source: string, destination: string): void {
  const expected = new Set(readdirSync(source).filter(name => name.endsWith('.tf') || name === '.terraform.lock.hcl'));
  for (const file of readdirSync(destination)) if ((file.endsWith('.tf') || file.endsWith('.tf.json') || file.endsWith('.tfvars') || file.endsWith('.tfvars.json')) && !expected.has(file) && file !== 'reviewed.auto.tfvars.json') throw new Error('Unreviewed Terraform workspace input rejected');
  for (const file of expected) {
    if (!(file.endsWith('.tf') || file === '.terraform.lock.hcl')) continue;
    const path = join(source, file); if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Invalid Terraform source');
    const target = join(destination, file);
    if (existsSync(target) && (!lstatSync(target).isFile() || lstatSync(target).isSymbolicLink())) throw new Error('Unsafe Terraform workspace destination');
    copyFileSync(path, target);
  }
}
function variables(intent: DeploymentIntent, kind: PreparedArtifact['kind']): Record<string, unknown> {
  const lab = intent.discovery.labId;
  if (kind === 'terraform-core') return { account_id: intent.discovery.accountId, lab_id: lab };
  return { account_id: intent.discovery.accountId, zone_id: intent.discovery.zoneId, routes: Object.fromEntries(['before', 'after', 'telemetry'].map(role => [role, { hostname: new URL(role === 'telemetry' ? intent.discovery.telemetryOrigin : intent.discovery.environments.find(e => e.role === role)!.origin).hostname, worker_name: `${lab}-${role}` }])) };
}
export async function prepareTerraformPlans(root: string, intent: DeploymentIntent, tool: TerraformReadTool, signal?: AbortSignal, sourceRoot = root): Promise<PreparedArtifact[]>  {
  const artifacts: PreparedArtifact[] = []; const nonce = randomUUID();
  const directory = join(intent.discovery.evidenceDirectory, 'deployment', 'prepared', nonce);
  validateEvidenceDirectory(directory, root); mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const kind of ['terraform-core', 'terraform-routing'] as const) {
    signal?.throwIfAborted(); const { workspace, source, stage } = stagePaths(root, intent, kind, sourceRoot);
    // Retain the original core/routing state workspaces across explicit source choices.
    copyConfiguration(source, workspace);
    const vars = join(workspace, 'reviewed.auto.tfvars.json');
    if (existsSync(vars) && (!lstatSync(vars).isFile() || lstatSync(vars).isSymbolicLink())) throw new Error('Unsafe Terraform variable destination');
    writeFileSync(vars, JSON.stringify(variables(intent, kind)), { mode: 0o600 });
    await tool.terraform(['init', '-backend=false', '-input=false', '-lockfile=readonly'], workspace, signal);
    const planFile = join(directory, `${stage}.tfplan`);
    await tool.terraform(['plan', '-input=false', '-lock-timeout=5s', `-out=${planFile}`], workspace, signal);
    const json = JSON.parse(await tool.terraform(['show', '-json', planFile], workspace, signal));
    const changes = terraformChanges(json, intent, kind);
    const stat = lstatSync(planFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid saved Terraform plan artifact');
    artifacts.push(PreparedArtifactSchema.parse({ kind, relativePath: `prepared/${nonce}/${stage}.tfplan`, digest: createHash('sha256').update(readFileSync(planFile)).digest('hex'), changeDigest: changes.digest, size: stat.size, changes: changes.changes }));
  }
  return artifacts;
}
export async function verifyTerraformPlans(root: string, input: DeploymentPlan, tool: TerraformReadTool, signal?: AbortSignal, sourceRoot = root): Promise<void> {
  const plan = PlanSchema.parse(input);
  for (const kind of ['terraform-core', 'terraform-routing'] as const) {
    const artifact = plan.preparedArtifacts.find(a => a.kind === kind); if (!artifact) throw new Error('Reviewed Terraform plan artifact missing');
    const path = resolve(plan.intent.discovery.evidenceDirectory, 'deployment', artifact.relativePath);
    validateEvidenceDirectory(dirname(path), root);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.size || createHash('sha256').update(readFileSync(path)).digest('hex') !== artifact.digest) throw new Error('Terraform plan artifact integrity mismatch');
    const { workspace, source, stage } = stagePaths(root, plan.intent, kind, sourceRoot); copyConfiguration(source, workspace);
    const original = JSON.parse(await tool.terraform(['show', '-json', path], workspace, signal));
    const reviewed = terraformChanges(original, plan.intent, kind);
    if (reviewed.digest !== artifact.changeDigest || digestValue(reviewed.changes) !== digestValue(artifact.changes)) throw new Error('Saved Terraform plan change digest differs');
    const check = join(dirname(path), `${stage}.recheck.tfplan`);
    await tool.terraform(['plan', '-input=false', '-lock-timeout=5s', `-out=${check}`], workspace, signal);
    const fresh = JSON.parse(await tool.terraform(['show', '-json', check], workspace, signal));
    if (terraformChanges(fresh, plan.intent, kind).digest !== artifact.changeDigest) throw new Error('Observed Terraform state or configuration drift requires a new reviewed plan');
    // Never apply the recheck file. Only the original immutable reviewed binary is eligible.
  }
}
