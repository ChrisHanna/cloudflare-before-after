import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { assertCredentialSeparation } from './credential-policy.js';
import { desiredRateLimit, inspectRateLimit } from './rate-policy.js';
import { validateDiscoveryConfig, type TargetConfig } from './config.js';
import { ApiCapabilityProvider, CAPABILITY_KEYS, Profile, discoverCapabilities, capabilityDigest, type CapabilityProvider, type Finding, type CapabilitySnapshot } from './capabilities.js';
import { BudgetLedger } from './budget.js';
import { GuardedClient } from './transport.js';
import { CloudflareReader } from './cloudflare.js';
import { IntentSchema, assessCost, createDeploymentPlan, sourceDigest, digestValue, type DeploymentIntent, type DeploymentPlan, type PreparedArtifact } from './deployment-plan.js';
import { DeploymentStore } from './deployment-store.js';
import type { ExecutionAudit } from './execution-audit.js';
import { applyReviewedPlan, type SetupExecutor } from './deployment-apply.js';
import { freezeSource } from './deployment-source.js';
import { LocalDeploymentTools } from './deployment-tools.js';
import { DeploymentApi } from './deployment-api.js';
import { LiveSetupExecutor, type LiveSetupCredentials } from './deployment-live.js';
import { prepareTerraformPlans } from './terraform-plan.js';
import { LabLease } from './lifecycle.js';
import { CORE_VERSIONS } from './infrastructure.js';
import { IMPLEMENTED_DEPLOYMENT_MODULES, WafModule, type ProductState } from './product-state.js';
import { desiredCustomWaf, inspectCustomWaf } from './custom-waf.js';
import { planOptionalProductSetup, type OptionalProductProvider } from './optional-product-setup.js';
import { OptionalProductFileJournal } from './optional-product-setup-store.js';
import { defaultOptionalProvider, loadOptionalSelections, loadPriorOptionalOwnership, saveOptionalSetup, loadOptionalSetup, loadOptionalApproval, approveOptionalSetup } from './optional-product-integration.js';
const HELP = `Usage: pnpm lab capabilities|plan|approve|apply|recover [--config /absolute/intent.json] [--profile core|core-waf|waf-signatures|rate-limit|lab-core|bot|workshop] [--json]
Default configuration: .lab/intent.json in the checkout.
capabilities: bounded read-only discovery; --dry-run performs no network calls.
plan: save an immutable reviewed change plan; --dry-run neither prepares nor saves evidence.
approve: --plan /absolute/saved.plan.json; requires exact interactive APPROVE <digest>.
apply: --plan /absolute/saved.plan.json; requires prior exact approval and fresh rechecks.
recover: --plan /absolute/saved.plan.json --expected-owner UUID; requires exact interactive recovery and proven owner termination.
--token-kind user|account selects credential introspection. No command buys plans.
plan --optional-selections /absolute/public-selections.json saves an exact optionalPlanPath.
approve/apply --optional-plan /absolute/saved.optional.json additionally require exact optional approval.
No deployment occurs during capability discovery or planning.
Monthly limit: $100 USD total lab cost. Estimates are not provider-enforced billing caps.`;
export interface LabCliDependencies {
  projectRoot: string;
  loadConfig?: (path: string) => unknown;
  provider?: (config: TargetConfig, tokenKind: 'user' | 'account') => { provider: CapabilityProvider; close(): void };
  sourceDigest?: () => string;
  prepare?: (intent: DeploymentIntent, capability: CapabilitySnapshot) => Promise<PreparedArtifact[] | { artifacts: PreparedArtifact[]; productStates: ProductState[] }>;
  createExecutor?: (plan: DeploymentPlan, audit: ExecutionAudit) => Promise<SetupExecutor>;
  credentials?: () => LiveSetupCredentials;
  confirm?: (prompt: string) => Promise<{ confirmation: string; interactiveTTY: boolean }>;
  now?: () => number;
  implementedModules?: readonly string[];
  optionalProvider?: (plan: DeploymentPlan, audit?: ExecutionAudit) => OptionalProductProvider;
}
function secret(reference: string | undefined): string | undefined { return reference ? process.env[reference.slice(4)] : undefined; }
export function resolveSetupCredentials(config: TargetConfig): LiveSetupCredentials {
  const values = { reader: secret(config.credentials.reader), collector: secret(config.credentials.collector), deployer: secret(config.credentials.deployer), runner: secret(config.credentials.runner), setup: secret(config.credentials.setup) };
  if (Object.values(values).some(v => !v || v.length < 24)) throw new Error('Configured API credentials and separate application secrets must be resolved');
  assertCredentialSeparation(values, 'apiTokenMode' in config.credentials && config.credentials.apiTokenMode === 'shared');
  return values as LiveSetupCredentials;
}
export function inspectTooling(projectRoot: string): Finding {
  try {
    const terraform = JSON.parse(execFileSync(process.env['TERRAFORM_BIN'] ?? 'terraform', ['version', '-json'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    const wranglerFile = resolve(projectRoot, 'node_modules/wrangler/package.json');
    const wrangler = existsSync(wranglerFile) ? JSON.parse(readFileSync(wranglerFile, 'utf8')).version : '';
    if (terraform.terraform_version !== CORE_VERSIONS.terraform || wrangler !== CORE_VERSIONS.wrangler) return { state: 'unknown', source: 'local tool versions', reasons: ['Exact pinned Terraform and Wrangler versions are required'] };
    return { state: 'available', source: 'local tool versions', reasons: [] };
  } catch { return { state: 'unknown', source: 'local tool versions', reasons: ['Terraform or pinned Wrangler is unavailable for validation'] }; }
}
function liveProvider(config: TargetConfig, tokenKind: 'user' | 'account', root: string) {
  const readerToken = secret(config.credentials.reader); if (!readerToken) throw new Error('Reader reference is unresolved');
  const deploymentToken = secret(config.credentials.deployer); const ledger = new BudgetLedger();
  const options = { purpose: 'discovery' as const, observedOwnedResources: new Set<string>() };
  const client = new GuardedClient(config, ledger, options); const deploy = deploymentToken ? new GuardedClient(config, ledger, options) : undefined;
  const provider = new ApiCapabilityProvider(config, client, new CloudflareReader(client, readerToken), { ...(deploymentToken && deploy ? { deploymentToken, deploymentClient: deploy } : {}), tokenKind, tooling: inspectTooling(root), collectorConfigured: (secret(config.credentials.collector)?.length ?? 0) >= 24 });
  return { provider, close: () => ledger.stop('Discovery finished') };
}
async function confirmTTY(prompt: string) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return { confirmation: '', interactiveTTY: false };
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return { confirmation: await terminal.question(`${prompt}\n> `), interactiveTTY: true }; }
  finally { terminal.close(); }
}
async function prepareLive(root: string, intent: DeploymentIntent, capability: CapabilitySnapshot, credentials: LiveSetupCredentials): Promise<{ artifacts: PreparedArtifact[]; productStates: ProductState[] }> {
  const claim = LabLease.claim({ projectRoot: root, evidenceDirectory: intent.discovery.evidenceDirectory, labId: intent.discovery.labId, idempotencyKey: randomUUID() });
  if (claim.kind !== 'claimed') throw new Error('Another operation owns the lab');
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), intent.setup.maxRuntimeMs);
  const tool = new LocalDeploymentTools(root, intent.discovery.evidenceDirectory, credentials.deployer);
  const api = new DeploymentApi(root, intent, credentials.reader, credentials.deployer);
  try {
    await tool.verifyVersions(controller.signal); await api.assertNoForeignCollisions(controller.signal); await api.checkImagesBeforePlan(controller.signal);
    const productStates: ProductState[] = [];
    for (const module of WafModule.options.filter(m => capability.includedModules.includes(m))) productStates.push((await inspectCustomWaf(api.customWaf(undefined, module), desiredCustomWaf(intent.discovery.labId, intent.discovery.environments[1].origin, module), controller.signal)).state);
    if (capability.includedModules.includes('rate-limit')) productStates.push((await inspectRateLimit(api.rateLimit(), desiredRateLimit(intent.discovery.labId, intent.discovery.environments[1].origin), controller.signal)).state);
    if (productStates.some(s => !s.owned)) return { artifacts: [], productStates };
    const snapshot = freezeSource(root, intent.discovery.evidenceDirectory);
    return { artifacts: await prepareTerraformPlans(root, intent, tool, controller.signal, snapshot.path), productStates };
  } finally { clearTimeout(timer); api.close(); await tool.close(); claim.lease.release(); }
}
export async function runLabCli(args: readonly string[], deps: LabCliDependencies): Promise<{ exitCode: number; output: string }> {
  const json = args.includes('--json'); const now = deps.now ?? Date.now;
  if (args.includes('--help') || args.length === 0) return { exitCode: 0, output: HELP };
  try {
    const command = z.enum(['capabilities', 'plan', 'approve', 'apply', 'recover']).parse(args[0]);
    let profile: z.infer<typeof Profile> | undefined; let configFile = resolve(deps.projectRoot, '.lab/intent.json'); let planPath: string | undefined;
    let dry = false; let tokenKind: 'user' | 'account' = 'user'; let expectedOwner: string | undefined;
    let selectionsPath: string | undefined; let optionalPath: string | undefined;
    const seen = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const flag = args[i]!; if (seen.has(flag)) throw new Error('Duplicate flag'); seen.add(flag);
      if (flag === '--json') continue;
      if (flag === '--dry-run') { dry = true; continue; }
      if (flag === '--profile') { profile = Profile.parse(args[++i]); continue; }
      if (flag === '--config') { configFile = args[++i]!; continue; }
      if (flag === '--plan') { planPath = args[++i]; continue; }
      if (flag === '--optional-selections') { selectionsPath = args[++i]; if (!selectionsPath || !isAbsolute(selectionsPath)) throw new Error('Absolute selections path required'); continue; }
      if (flag === '--optional-plan') { optionalPath = args[++i]; if (!optionalPath || !isAbsolute(optionalPath)) throw new Error('Absolute optional plan path required'); continue; }
      if (flag === '--expected-owner') { expectedOwner = z.uuid().parse(args[++i]); continue; }
      if (flag === '--token-kind') { tokenKind = z.enum(['user', 'account']).parse(args[++i]); continue; }
      throw new Error('Unknown flag');
    }
    if (!isAbsolute(configFile)) throw new Error('Absolute configuration path required');
    if (selectionsPath && command !== 'plan' || optionalPath && !['approve', 'apply'].includes(command)) throw new Error('Optional setup flag is not applicable');
    if (dry && !['plan', 'capabilities'].includes(command)) throw new Error('Dry-run applies only to planning/discovery');
    if (planPath && !['approve', 'apply', 'recover'].includes(command)) throw new Error('Plan flag is not applicable');
    if (expectedOwner && command !== 'recover') throw new Error('Recovery owner flag is not applicable');
    if (['approve', 'recover'].includes(command) && (seen.has('--profile') || seen.has('--token-kind'))) throw new Error('Discovery flags are not applicable to approval or recovery');
    const raw = (deps.loadConfig ?? (path => JSON.parse(readFileSync(path, 'utf8'))))(configFile);
    const isIntent = typeof raw === 'object' && raw !== null && 'discovery' in raw;
    const parsedIntent = isIntent ? IntentSchema.parse(raw) : null;
    const config = validateDiscoveryConfig(parsedIntent?.discovery ?? raw, deps.projectRoot);
    const selected = profile ?? parsedIntent?.profile ?? 'core';
    if (command !== 'capabilities' && !parsedIntent) throw new Error('Deployment intent required');
    if (dry) return { exitCode: 0, output: JSON.stringify({ schemaVersion: 1, kind: 'planned', profile: selected, accountId: config.accountId, zoneId: config.zoneId, checks: CAPABILITY_KEYS, ...(parsedIntent ? { cost: assessCost(parsedIntent.costs, now()) } : {}), remoteWrites: 0, deploymentAuthorized: false }) };
    const discover = async () => {
      const resources = (deps.provider ?? ((c, kind) => liveProvider(c, kind, deps.projectRoot)))(config, tokenKind);
      try { return await discoverCapabilities(config, selected, resources.provider, undefined, new Date(now()).toISOString()); }
      finally { resources.close(); }
    };
    if (command === 'capabilities') {
      const snapshot = await discover();
      return { exitCode: snapshot.deployable ? 0 : 1, output: json ? JSON.stringify(snapshot) : [`Scope: ${selected}`, `Mode: ${snapshot.mode}`, ...snapshot.findings.map(f => `${f.product}: ${f.state}${f.reasons.length ? ` — ${f.reasons.join('; ')}` : ''}`), 'No deployment or purchase was performed.'].join('\n') };
    }
    if (!parsedIntent) throw new Error('Deployment intent required');
    const intent = IntentSchema.parse({ ...parsedIntent, profile: selected });
    const store = new DeploymentStore(deps.projectRoot, config.evidenceDirectory);
    const currentSource = () => (deps.sourceDigest ?? (() => sourceDigest(deps.projectRoot)))();
    if (command === 'plan') {
      const capability = await discover(); let artifacts: PreparedArtifact[] = []; let productStates: ProductState[] = [];
      const selections = selectionsPath ? loadOptionalSelections(selectionsPath) : [];
      const modules = [...(deps.implementedModules ?? IMPLEMENTED_DEPLOYMENT_MODULES), ...selections.map(s => s.module)];
      const canPrepare = capability.deployable && !assessCost(intent.costs, now()).blockers.length && capability.includedModules.every(id => modules.includes(id) || ['analytics', 'ddos-evidence'].includes(id));
      if (canPrepare) {
        const prepared = deps.prepare ? await deps.prepare(intent, capability) : capability.mode === 'live' ? await prepareLive(deps.projectRoot, intent, capability, resolveSetupCredentials(config)) : [];
        if (Array.isArray(prepared)) artifacts = prepared;
        else { artifacts = prepared.artifacts; productStates = prepared.productStates; }
      }
      const plan = createDeploymentPlan(intent, capability, currentSource(), deps.projectRoot, now(), modules, artifacts, productStates);
      let optionalSetup;
      if (selections.length && plan.status === 'review-required') {
        const provider = deps.optionalProvider?.(plan) ?? defaultOptionalProvider(plan, resolveSetupCredentials(config));
        const signal = AbortSignal.timeout(Math.min(intent.setup.maxRuntimeMs, 120000));
        const ownership = loadPriorOptionalOwnership(deps.projectRoot, plan, now());
        optionalSetup = await planOptionalProductSetup(plan, selections, provider, ownership, signal, now());
      }
      const saved = store.save(plan);
      const optionalPlanPath = optionalSetup ? saveOptionalSetup(deps.projectRoot, saved.planPath, optionalSetup) : null;
      return { exitCode: plan.status === 'blocked' ? 1 : 0, output: JSON.stringify({ ...saved, optionalPlanPath, optionalPlanDigest: optionalSetup ? digestValue(optionalSetup) : null, approvalState: 'not-approved', plan, risk: 'Estimates are not provider-enforced spending caps' }) };
    }
    if (!planPath || !isAbsolute(planPath)) throw new Error('Absolute saved plan path required');
    const saved = store.load(planPath);
    if (command === 'approve') {
      if (saved.plan.status !== 'review-required' || saved.plan.blockers.length || now() >= Date.parse(saved.plan.expiresAt) || currentSource() !== saved.plan.sourceDigest || digestValue(intent) !== saved.plan.intentDigest) throw new Error('Blocked, stale or changed plan cannot be approved');
      const answer = await (deps.confirm ?? confirmTTY)(`Review ${planPath}. Projected monthly lab cost: $${((saved.plan.cost.totalCents ?? 0) / 100).toFixed(2)} USD. Estimates do not cap provider bills. Type APPROVE ${saved.digest} to authorize only that exact plan.`);
      let optionalApproval;
      if (saved.plan.steps.some(s => s.kind === 'product-policy' && ['api-shield', 'access', 'waiting-room'].includes(s.module))) {
        if (!optionalPath) throw new Error('Exact optional setup extension required');
        const setup = loadOptionalSetup(deps.projectRoot, optionalPath, saved.plan);
        const reply = await (deps.confirm ?? confirmTTY)(`Review ${optionalPath}. Type APPROVE OPTIONAL ${digestValue(setup)} to authorize these exact scoped operations.`);
        optionalApproval = approveOptionalSetup(deps.projectRoot, optionalPath, saved.plan, reply.confirmation, reply.interactiveTTY, now());
      } else if (optionalPath) throw new Error('Optional extension is not applicable');
      const approval = store.approve(planPath, answer.confirmation, answer.interactiveTTY, now());
      return { exitCode: 0, output: JSON.stringify({ approvalState: 'approved', approval, optionalApproval, remoteWrites: 0 }) };
    }
    if (command === 'recover') {
      if (!expectedOwner) throw new Error('Expected owner ID required');
      const answer = await (deps.confirm ?? confirmTTY)(`After inspecting partial resources, type RECOVER ${expectedOwner}. No remote resource will be changed.`);
      if (!answer.interactiveTTY || answer.confirmation !== `RECOVER ${expectedOwner}`) throw new Error('Exact interactive recovery required');
      LabLease.recover({ projectRoot: deps.projectRoot, evidenceDirectory: saved.plan.intent.discovery.evidenceDirectory, labId: saved.plan.intent.discovery.labId, expectedOwnerId: expectedOwner, expectedIdempotencyKey: saved.plan.id, explicit: true });
      return { exitCode: 0, output: JSON.stringify({ recovered: true, remoteWrites: 0, newPlanRequired: true }) };
    }
    store.approval(saved.plan, saved.digest, now());
    const capability = await discover(); const credentials = (deps.credentials ?? (() => resolveSetupCredentials(config)))();
    const requiredOptional = saved.plan.steps.some(s => s.kind === 'product-policy' && ['api-shield', 'access', 'waiting-room'].includes(s.module));
    if (requiredOptional !== Boolean(optionalPath)) throw new Error('Exact optional setup extension required for selected modules only');
    const setup = optionalPath ? loadOptionalSetup(deps.projectRoot, optionalPath, saved.plan) : null;
    const approval = optionalPath ? loadOptionalApproval(deps.projectRoot, optionalPath, saved.plan, now()) : null;
    if (setup) {
      const provider = deps.optionalProvider?.(saved.plan) ?? defaultOptionalProvider(saved.plan, credentials);
      const ownership = Object.fromEntries(setup.operations.map(op => [op.module, op.ownershipIds]));
      const current = await planOptionalProductSetup(saved.plan, setup.operations.map(op => op.selection), provider, ownership, AbortSignal.timeout(Math.min(intent.setup.maxRuntimeMs, 120000)), now());
      if (digestValue(current.operations) !== digestValue(setup.operations)) throw new Error('Optional product drift before any central write');
    }
    const revalidate = async (signal: AbortSignal) => {
      signal.throwIfAborted(); const fresh = store.load(planPath!).plan;
      if (currentSource() !== fresh.sourceDigest || digestValue(intent) !== fresh.intentDigest || capabilityDigest(await discover()) !== capabilityDigest(capability)) throw new Error('Current source, intent or capabilities changed');
      store.approval(fresh, digestValue(fresh), now()); return fresh;
    };
    const record = await applyReviewedPlan(store, planPath, { intent, capability, sourceDigest: currentSource(), credentials, now, createExecutor: deps.createExecutor ?? (async (plan, audit) => new LiveSetupExecutor(deps.projectRoot, plan, credentials, { audit,
      ...(setup && approval ? { optionalProducts: { setup, approval, provider: deps.optionalProvider?.(plan, audit) ?? defaultOptionalProvider(plan, credentials, audit.hookProviderDispatch(fetch)), journal: new OptionalProductFileJournal(deps.projectRoot, config.evidenceDirectory), revalidate, now } } : {}),
    })) });
    return { exitCode: record.status === 'succeeded' ? 0 : 1, output: JSON.stringify({ record, interviewVerified: false, workshopVerified: false }) };
  } catch { return { exitCode: 2, output: json ? JSON.stringify({ error: 'Lab command refused: check configuration, credentials, exact approval, plan freshness, and lab ownership. Use pnpm lab --help.', ...(args[0] === 'apply' ? {} : { remoteWrites: 0 }) }) : 'Lab command refused: check configuration, credentials, exact approval, plan freshness, and lab ownership. Use pnpm lab --help.' }; }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = await runLabCli(process.argv.slice(2), { projectRoot: process.cwd() }); console.log(result.output); process.exitCode = result.exitCode;
}
