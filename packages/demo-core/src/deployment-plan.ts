import { z } from 'zod';
import { assertCredentialSeparation } from './credential-policy.js';
import { canonical, digestValue } from './canonical.js';
export { canonical, digestValue } from './canonical.js';
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Digest, Id, Time } from '../../contracts/src/schemas.js';
import { DiscoveryConfigSchema, validateEvidenceDirectory } from './config.js';
import { Profile, SnapshotSchema, capabilityDigest, type CapabilitySnapshot } from './capabilities.js';
import { CORE_VERSIONS } from './infrastructure.js';
import { IMPLEMENTED_DEPLOYMENT_MODULES, PolicyModule, WafModule, ProductStateSchema, type ProductState } from './product-state.js';
const Text = z.string().min(1).max(256);
export const MAX_MONTHLY_CENTS = 10000;
export const PLAN_LIFETIME_MS = 15 * 60 * 1000;
const CostCategory = z.enum(['existing-spend', 'remaining-commitments', 'renewals', 'new-subscriptions', 'usage', 'tax', 'reserve']);
export const CostEstimateSchema = z.strictObject({
  currency: z.literal('USD'), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), observedAt: Time,
  pricingAsOf: z.iso.date(), materialUnknowns: z.array(Text).max(30),
  lines: z.array(z.strictObject({ category: CostCategory, label: Text, thisMonthCents: z.number().int().min(0).max(100000000).nullable(), source: Text, assumption: Text })).min(7).max(100),
});
export type CostEstimate = z.infer<typeof CostEstimateSchema>;
export function assessCost(input: CostEstimate, now = Date.now()) {
  const cost = CostEstimateSchema.parse(input); const blockers: string[] = [];
  for (const category of CostCategory.options) if (!cost.lines.some(l => l.category === category)) blockers.push(`Cost category missing: ${category}`);
  if (cost.month !== new Date(now).toISOString().slice(0, 7)) blockers.push('Cost estimate does not cover the current month');
  if (Date.parse(cost.observedAt) > now || now - Date.parse(cost.observedAt) > PLAN_LIFETIME_MS) blockers.push('Current commitments and usage estimate is stale');
  if (Date.parse(cost.pricingAsOf) > now || now - Date.parse(cost.pricingAsOf) > 30 * 86400000) blockers.push('Pricing date is stale or in the future');
  if (cost.lines.some(l => l.thisMonthCents === null) || cost.materialUnknowns.length) blockers.push('Material monthly costs are unresolved');
  const totalCents = cost.lines.reduce((sum, line) => sum + (line.thisMonthCents ?? 0), 0);
  if (totalCents > MAX_MONTHLY_CENTS) blockers.push('Projected total monthly lab cost exceeds $100 USD');
  return { totalCents: blockers.includes('Material monthly costs are unresolved') ? null : totalCents, ceilingCents: MAX_MONTHLY_CENTS, remainingCents: blockers.includes('Material monthly costs are unresolved') ? null : Math.max(0, MAX_MONTHLY_CENTS - totalCents), blockers, providerEnforcedCap: false as const };
}
export const IntentSchema = z.strictObject({
  schemaVersion: z.literal(1), discovery: DiscoveryConfigSchema, profile: Profile,
  releaseDigest: Digest, viewRunId: Id, costs: CostEstimateSchema,
  turnstile: z.strictObject({ mode: z.enum(['test', 'live']) }).optional(),
  priorModules: z.array(Text).max(20),
  setup: z.strictObject({ maxRuntimeMs: z.number().int().min(1000).max(1800000), maxOperations: z.number().int().min(1).max(100) }),
}).superRefine((v, ctx) => {
  if (!/^[a-z][a-z0-9-]{2,19}$/.test(v.discovery.labId)) ctx.addIssue({ code: 'custom', message: 'Deployment lab ID must be 3 to 20 lowercase name characters' });
  if (!v.discovery.credentials.deployer) ctx.addIssue({ code: 'custom', message: 'Deployment credential reference required' });
  const { apiTokenMode: _mode, ...references } = v.discovery.credentials;
  try { assertCredentialSeparation(references, _mode === 'shared'); }
  catch { ctx.addIssue({ code: 'custom', message: 'Credential references must be separate except matching API references in explicit shared mode' }); }
});
export type DeploymentIntent = z.infer<typeof IntentSchema>;
const StepKind = z.enum(['terraform-core', 'images-owned-upload', 'd1-migrations', 'wrangler-telemetry', 'wrangler-before', 'wrangler-after', 'provision-secrets', 'terraform-routing', 'seed-before', 'seed-after', 'product-policy', 'readback']);
export const StepSchema = z.strictObject({ id: Text, kind: StepKind, module: Text, resources: z.array(Text).max(20), changes: z.literal('create-or-update-owned'), deletes: z.literal(false) });
export type DeploymentStep = z.infer<typeof StepSchema>;
export const PreparedArtifactSchema = z.strictObject({
  kind: z.enum(['terraform-core', 'terraform-routing']),
  relativePath: z.string().regex(/^prepared\/[a-f0-9-]{36}\/(core|routing)\.tfplan$/),
  digest: Digest, changeDigest: Digest, size: z.number().int().positive().max(16 * 1024 * 1024),
  changes: z.array(z.strictObject({ address: Text, actions: z.array(z.enum(['no-op', 'create', 'update', 'read'])).min(1).max(1) })).max(100),
});
export type PreparedArtifact = z.infer<typeof PreparedArtifactSchema>;
export const PlanSchema = z.strictObject({
  schemaVersion: z.literal(1), id: Id, mode: z.enum(['live', 'fixture']), createdAt: Time, expiresAt: Time,
  intent: IntentSchema, intentDigest: Digest, sourceDigest: Digest, capabilityDigest: Digest, capability: SnapshotSchema,
  toolVersions: z.strictObject({ terraform: z.literal(CORE_VERSIONS.terraform), cloudflareProvider: z.literal(CORE_VERSIONS.cloudflareProvider), wrangler: z.literal(CORE_VERSIONS.wrangler), containersSdk: z.literal(CORE_VERSIONS.containersSdk) }),
  includedModules: z.array(Text).max(20), excludedModules: z.array(z.strictObject({ id: Text, reasons: z.array(Text).max(20) })).max(20),
  steps: z.array(StepSchema).max(100), preparedArtifacts: z.array(PreparedArtifactSchema).max(2), productStates: z.array(ProductStateSchema).max(20), blockers: z.array(Text).max(100), status: z.enum(['blocked', 'review-required']),
  cost: z.strictObject({ totalCents: z.number().int().nonnegative().nullable(), ceilingCents: z.literal(10000), remainingCents: z.number().int().nonnegative().nullable(), blockers: z.array(Text).max(30), providerEnforcedCap: z.literal(false) }),
  approvalState: z.literal('not-approved'),
});
export type DeploymentPlan = z.infer<typeof PlanSchema>;
export function sourceEntries(projectRoot: string): [string, string][] {
  const hashes: [string, string][] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error('Symlink source rejected');
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!['node_modules', 'dist', '.terraform', '.git', '.lab', '.evidence'].includes(name) && !name.startsWith('.env')) walk(join(path, name));
    } else if (stat.isFile() && /\.(?:ts|tsx|mjs|json|yaml|tf|hcl|sql|html|css|svg)$/.test(path) && !/\.tfstate(?:\.|$)|\.tfvars(?:\.|$)/.test(path)) {
      if (stat.size > 4 * 1024 * 1024) throw new Error('Source file exceeds hashing cap');
      hashes.push([relative(projectRoot, path), createHash('sha256').update(readFileSync(path)).digest('hex')]);
    } else if (stat.isFile() && (path.endsWith('/Dockerfile') || path.endsWith('/.dockerignore'))) hashes.push([relative(projectRoot, path), createHash('sha256').update(readFileSync(path)).digest('hex')]);
  };
  for (const name of ['apps', 'packages', 'infra', 'scripts', 'scenarios', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json', 'tsconfig.build.json', '.dockerignore']) walk(join(projectRoot, name));
  return hashes;
}
export function sourceDigest(projectRoot: string): string { return digestValue(sourceEntries(projectRoot)); }
export function deploymentSteps(intent: DeploymentIntent, snapshot: CapabilitySnapshot): DeploymentStep[] {
  const lab = intent.discovery.labId;
  const step = (kind: DeploymentStep['kind'], resources: string[], module = 'core'): DeploymentStep => ({ id: `${module}:${kind}`, kind, module, resources, changes: 'create-or-update-owned', deletes: false });
  if (!snapshot.includedModules.includes('core')) return [];
  return [
    step('terraform-core', [`${lab}-before-storefront`, `${lab}-after-storefront`, `${lab}-before-objects`, `${lab}-after-objects`, ...(intent.discovery.imageVariant?.source === 'existing-public-readonly' ? [] : [`${lab}-catalog`])]),
    step('images-owned-upload', [`${lab}-before-product`, `${lab}-after-product`]),
    step('d1-migrations', [`${lab}-before-storefront`, `${lab}-after-storefront`]),
    step('wrangler-telemetry', [`${lab}-telemetry`]), step('wrangler-before', [`${lab}-before`, `${lab}-before-origin`]), step('wrangler-after', [`${lab}-after`, `${lab}-after-origin`]),
    step('provision-secrets', [`${lab}-before`, `${lab}-after`, `${lab}-telemetry`]),
    step('terraform-routing', [...intent.discovery.environments.map(e => new URL(e.origin).hostname), new URL(intent.discovery.telemetryOrigin).hostname]),
    ...snapshot.includedModules.filter(m => m !== 'core' && m !== 'analytics' && m !== 'ddos-evidence').map(m => step('product-policy', [new URL(intent.discovery.environments[1].origin).hostname, ...(PolicyModule.safeParse(m).success ? [`cf-demo-${lab}-${m}`] : [])], m)),
    step('seed-before', [`${lab}-before`]), step('seed-after', [`${lab}-after`]), step('readback', [`${lab}-before`, `${lab}-after`, `${lab}-telemetry`]),
  ];
}
// A Durable Object binds its producer identity to the release digest, so a reused viewRunId 503s public views.
export function viewRunReuseBlockers(intent: DeploymentIntent): string[] {
  const directory = join(intent.discovery.evidenceDirectory, 'deployment', 'plans');
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  const blockers = new Set<string>();
  for (const name of names) {
    if (!name.endsWith('.attempt.json')) continue;
    try {
      const saved = JSON.parse(readFileSync(join(directory, `${name.slice(0, -'.attempt.json'.length)}.plan.json`), 'utf8')) as { plan?: { intent?: { releaseDigest?: unknown; viewRunId?: unknown } } };
      const prior = saved.plan?.intent;
      if (prior?.viewRunId === intent.viewRunId && typeof prior.releaseDigest === 'string' && prior.releaseDigest !== intent.releaseDigest) blockers.add('viewRunId was already deployed with a different release digest; mint a new viewRunId for this release');
    } catch { /* A missing or unreadable plan cannot prove reuse. */ }
  }
  return [...blockers];
}
export function createDeploymentPlan(input: DeploymentIntent, capability: CapabilitySnapshot, sources: string, projectRoot: string, now = Date.now(), implementedModules: readonly string[] = IMPLEMENTED_DEPLOYMENT_MODULES, preparedArtifacts: readonly PreparedArtifact[] = [], productStates: readonly ProductState[] = []): DeploymentPlan {
  const intent = IntentSchema.parse(input); const snapshot = SnapshotSchema.parse(capability); Digest.parse(sources);
  validateEvidenceDirectory(intent.discovery.evidenceDirectory, projectRoot);
  if (snapshot.accountId !== intent.discovery.accountId || snapshot.zoneId !== intent.discovery.zoneId || snapshot.profile !== intent.profile) throw new Error('Capability snapshot scope differs from intent');
  const age = now - Date.parse(snapshot.observedAt); const cost = assessCost(intent.costs, now);
  const steps = deploymentSteps(intent, snapshot); const blockers = [...snapshot.blockers, ...cost.blockers];
  if (age < 0 || age > PLAN_LIFETIME_MS) blockers.push('Capability snapshot is stale');
  const prepared = preparedArtifacts.map(a => PreparedArtifactSchema.parse(a));
  if (new Set(prepared.map(a => a.kind)).size !== prepared.length) throw new Error('Duplicate prepared plan artifact');
  const states = productStates.map(state => ProductStateSchema.parse(state));
  if (new Set(states.map(s => s.module)).size !== states.length || states.some(s => !snapshot.includedModules.includes(s.module))) throw new Error('Product readback does not match selected modules');
  if (snapshot.mode === 'live' && snapshot.includedModules.includes('bot') && !snapshot.findings.find(f => f.product === 'bot-management')?.reasons.some(r => /^Bot configuration digest: [a-f0-9]{64}$/.test(r))) blockers.push('Current scored Bot Management subscription fingerprint is required; no upgrade is authorized');
  for (const id of snapshot.includedModules.filter(m => PolicyModule.safeParse(m).success)) {
    const state = states.find(s => s.module === id);
    if (snapshot.mode === 'live' && (!state || !state.owned)) blockers.push(`Selected product readback is missing or not owned: ${id}`);
  }
  if (snapshot.mode === 'live' && (!prepared.some(a => a.kind === 'terraform-core') || !prepared.some(a => a.kind === 'terraform-routing'))) blockers.push('Live Terraform plan artifacts must be prepared and reviewed before approval');
  if (snapshot.mode === 'live') {
    if (!intent.discovery.credentials.runner || !intent.discovery.credentials.setup) blockers.push('Runner and setup secret references are required for live setup');
    blockers.push(...viewRunReuseBlockers(intent));
    try { if (sourceDigest(join(intent.discovery.evidenceDirectory, 'deployment', 'source', sources)) !== sources) blockers.push('Frozen source does not match the reviewed release'); }
    catch { blockers.push('Frozen source snapshot must exist before live approval'); }
  }
  if (steps.length > intent.setup.maxOperations) blockers.push('Setup operation plan exceeds allowance');
  for (const id of snapshot.includedModules) if (!implementedModules.includes(id) && id !== 'analytics' && id !== 'ddos-evidence') blockers.push(`Deployment module not implemented: ${id}`);
  return PlanSchema.parse({ schemaVersion: 1, id: randomUUID(), mode: snapshot.mode, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PLAN_LIFETIME_MS).toISOString(), intent, intentDigest: digestValue(intent), sourceDigest: sources, capabilityDigest: capabilityDigest(snapshot), capability: snapshot, toolVersions: CORE_VERSIONS, includedModules: snapshot.includedModules, excludedModules: snapshot.excludedModules, steps, preparedArtifacts: prepared, productStates: states, blockers, status: blockers.length ? 'blocked' : 'review-required', cost, approvalState: 'not-approved' });
}
