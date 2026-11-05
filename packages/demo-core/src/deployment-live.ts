import { z } from 'zod';
import { assertCredentialSeparation } from './credential-policy.js';
import { botConfigurationReason } from './bot-policy.js';
import { createHash, createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DeploymentApi } from './deployment-api.js';
import { LocalDeploymentTools, type DeploymentTools } from './deployment-tools.js';
import { verifyFrozenSource } from './deployment-source.js';
import { verifyTerraformPlans } from './terraform-plan.js';
import { CoreInventorySchema, assertInventoryImageVariant, provisionOwnedImage, renderDeployment, type CoreInventory, type DeploymentSettings } from './infrastructure.js';
import { validateEvidenceDirectory } from './config.js';
import { ImageAssetSchema } from '../../../apps/storefront-worker/src/assets.js';
import { TEST_SECRET, TEST_SITEKEY } from '../../contracts/src/turnstile-test.js';
import type { DeploymentPlan, DeploymentStep } from './deployment-plan.js';
import type { SetupContext, SetupExecutor } from './deployment-apply.js';
import type { Dispatch } from './transport.js';
import { boundedBytes } from './deployment-http.js';
import { readStorefront, type ReadbackOptions } from './storefront-readback.js';
import { desiredCustomWaf, inspectCustomWaf } from './custom-waf.js';
import { desiredRateLimit, inspectRateLimit, provisionRateLimit } from './rate-policy.js';
import { WafModule } from './product-state.js';
import { provisionWafModules } from './waf-modules.js';
import { digestValue } from './deployment-plan.js';
import { deployedRuntimeConfig } from './runtime-config.js';
import type { ExecutionAudit } from './execution-audit.js';
import { executeOptionalProductSetupStep, readConfirmedOptionalResources, type OptionalProductApplyOptions } from './optional-product-setup.js';
export interface LiveSetupCredentials { reader: string; collector: string; deployer: string; runner: string; setup: string }
export { boundedBytes } from './deployment-http.js';
export function derivedServiceSecrets(master: string, labId: string, role: 'before' | 'after') {
  if (master.length < 24) throw new Error('Operator setup root is required');
  const value = (purpose: string) => createHmac('sha256', master).update(`${labId}:${role}:${purpose}:v1`).digest('hex');
  return { INTERNAL_SECRET: value('internal'), INGEST_ROOT_SECRET: value('ingest'), REGISTRY_SECRET: value('registry'), SETUP_SECRET: value('seed') };
}
export class LiveSetupExecutor implements SetupExecutor {
  readonly mode = 'live' as const;
  readonly #source: string; readonly #runtime: string; readonly #api: DeploymentApi; readonly #tools: DeploymentTools;
  #inventory: CoreInventory | undefined; #rendered: ReturnType<typeof renderDeployment> | undefined;
  readonly #images = new Map<'before' | 'after', DeploymentSettings['images']['before']>();
  #verified = false;
  readonly #providerDispatch: Dispatch; readonly #runtimeDispatch: Dispatch;
  #customRuleId: string | undefined; #turnstile: { sitekey: string; secret: string } | null = null;
  #wafRules = new Map<WafModule, string>(); #wafCheckpoint: string | null = null; #rateRuleId: string | undefined; #rateCheckpoint: string | null = null;
  constructor(readonly projectRoot: string, readonly plan: DeploymentPlan, readonly credentials: LiveSetupCredentials, readonly options: { tools?: DeploymentTools; dispatch?: Dispatch; audit?: ExecutionAudit; optionalProducts?: Omit<OptionalProductApplyOptions, 'context' | 'plan'>; readback?: ReadbackOptions } = {}) {
    if (plan.mode !== 'live') throw new Error('Fixture plan cannot use the live setup executor');
    const values = Object.values(credentials);
    if (values.some(v => v.length < 24)) throw new Error('Resolved API credentials and separate application secrets are required');
    assertCredentialSeparation(credentials, plan.intent.discovery.credentials.apiTokenMode === 'shared');
    this.#source = verifyFrozenSource(projectRoot, plan.intent.discovery.evidenceDirectory, plan.sourceDigest);
    this.#runtime = join(plan.intent.discovery.evidenceDirectory, 'deployment', 'runtime', plan.id);
    validateEvidenceDirectory(this.#runtime, projectRoot); mkdirSync(this.#runtime, { recursive: true, mode: 0o700 });
    const raw = options.dispatch ?? ((url: string, init: RequestInit) => fetch(url, init));
    this.#providerDispatch = options.audit ? options.audit.hookProviderDispatch(raw) : raw;
    this.#runtimeDispatch = options.audit ? options.audit.hookRuntimeDispatch(raw) : raw;
    const tools = options.tools ?? new LocalDeploymentTools(projectRoot, plan.intent.discovery.evidenceDirectory, credentials.deployer);
    this.#tools = options.audit ? options.audit.hookDeploymentTools(tools) : tools;
    this.#api = new DeploymentApi(projectRoot, plan.intent, credentials.reader, credentials.deployer, this.#providerDispatch);
  }
  #dispatch(url: string, init: RequestInit): Promise<Response> { return this.#runtimeDispatch(url, init); }
  #workspace(kind: 'core' | 'routing'): string { return join(this.plan.intent.discovery.evidenceDirectory, 'deployment', 'work', this.plan.intent.discovery.labId, kind); }
  #config(role: 'before' | 'after' | 'telemetry'): string { return join(this.#runtime, `${role}.wrangler.json`); }
  #writeConfigs(): void {
    if (!this.#inventory || !this.#images.get('before') || !this.#images.get('after')) throw new Error('Infrastructure and image outputs must exist before Worker configuration');
    const intent = this.plan.intent;
    this.#rendered = renderDeployment(this.#inventory, { zoneId: intent.discovery.zoneId, origins: { before: intent.discovery.environments[0].origin, after: intent.discovery.environments[1].origin, telemetry: intent.discovery.telemetryOrigin }, releaseDigest: intent.releaseDigest, viewRunId: intent.viewRunId, ...(intent.discovery.imageVariant ? { imageVariant: intent.discovery.imageVariant } : {}), images: { before: this.#images.get('before')!, after: this.#images.get('after')! }, ...(intent.turnstile ? { turnstile: { mode: intent.turnstile.mode, sitekey: this.#turnstile?.sitekey ?? TEST_SITEKEY, hostname: new URL(intent.discovery.environments[1].origin).hostname, action: 'register' as const } } : {}) }, this.#source);
    for (const e of this.#rendered.environments) writeFileSync(this.#config(e.role), JSON.stringify(e.config), { flag: 'wx', mode: 0o600 });
    writeFileSync(this.#config('telemetry'), JSON.stringify(this.#rendered.telemetry.config), { flag: 'wx', mode: 0o600 });
  }
  async execute(step: DeploymentStep, context: SetupContext): Promise<void> {
    if (!this.#verified) {
      await this.#tools.verifyVersions(context.signal);
      await this.#api.assertNoForeignCollisions(context.signal); await this.#api.checkImagesBeforePlan(context.signal);
      if (this.plan.includedModules.includes('bot')) {
        const configuration = await this.#api.botConfiguration(context.signal);
        if (!this.plan.capability.findings.find(f => f.product === 'bot-management')?.reasons.includes(botConfigurationReason(configuration))) throw new Error('Reviewed Bot Management subscription changed or is unavailable');
      }
      for (const state of this.plan.productStates) {
        const current = state.module === 'rate-limit' ? await inspectRateLimit(this.#api.rateLimit(), desiredRateLimit(this.plan.intent.discovery.labId, this.plan.intent.discovery.environments[1].origin), context.signal) : await inspectCustomWaf(this.#api.customWaf(), desiredCustomWaf(this.plan.intent.discovery.labId, this.plan.intent.discovery.environments[1].origin, state.module), context.signal);
        if (!current.state.owned || current.state.digest !== state.digest) throw new Error('Reviewed product state changed before setup');
      }
      await verifyTerraformPlans(this.projectRoot, this.plan, this.#tools, context.signal, this.#source);
      this.#verified = true;
    }
    const intent = this.plan.intent; const lab = intent.discovery.labId;
    if (step.kind === 'terraform-core' || step.kind === 'terraform-routing') {
      const artifact = this.plan.preparedArtifacts.find(a => a.kind === step.kind); if (!artifact) throw new Error('Original reviewed Terraform artifact required');
      const workspace = this.#workspace(step.kind === 'terraform-core' ? 'core' : 'routing');
      await context.perform('terraform-apply', `${lab}-${step.kind}`, () => this.#tools.applyTerraform(resolve(intent.discovery.evidenceDirectory, 'deployment', artifact.relativePath), workspace, context.signal));
      if (step.kind === 'terraform-core') {
        this.#inventory = CoreInventorySchema.parse(JSON.parse(await this.#tools.terraform(['output', '-json', 'core_inventory'], workspace, context.signal)));
        if (this.#inventory.account_id !== intent.discovery.accountId || this.#inventory.lab_id !== lab) throw new Error('Terraform inventory scope mismatch');
        assertInventoryImageVariant(this.#inventory, intent.discovery.imageVariant);
        for (const role of ['before', 'after'] as const) {
          context.observeResource('d1-database', this.#inventory.environments[role].database_id);
          context.observeResource('r2-bucket', this.#inventory.environments[role].bucket_name);
        }
        if (!this.#inventory.image_variant_source) context.observeResource('images-variant', this.#inventory.image_variant);
        writeFileSync(join(this.#runtime, 'inventory.json'), JSON.stringify(this.#inventory), { flag: 'wx', mode: 0o600 });
      }
      return;
    }
    if (!this.#inventory) throw new Error('Core infrastructure output is required');
    if (step.kind === 'images-owned-upload') {
      for (const role of ['before', 'after'] as const) {
        const image = await provisionOwnedImage(this.#api.images(context), this.#inventory, role);
        const url = image.variants.map(value => new URL(value)).find(u => u.origin === 'https://imagedelivery.net' && !u.search && !u.hash && u.pathname.split('/')[2] === image.id && u.pathname.split('/')[3] === this.#inventory!.image_variant);
        if (!url || url.username || url.password) throw new Error('Owned Images variant delivery URL missing');
        const result = await context.perform('images-readback', image.id, async () => {
          const response = await this.#dispatch(url.href, { method: 'GET', redirect: 'error', headers: { accept: 'image/png' }, signal: context.signal });
          if (!response.ok || !/^image\//.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel(); throw new Error('Actual image delivery unavailable'); }
          const bytes = await boundedBytes(response, 65536, context.signal); if (!bytes.length) throw new Error('Empty image delivery');
          return createHash('sha256').update(bytes).digest('hex');
        });
        this.#images.set(role, ImageAssetSchema.parse({ id: image.id, role, labId: lab, immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: url.pathname.split('/')[1], variant: this.#inventory.image_variant, expectedDigest: result }));
      }
      if (intent.turnstile?.mode === 'live') this.#turnstile = await this.#api.ensureTurnstileWidget(context);
      this.#writeConfigs(); return;
    }
    if (!this.#rendered) throw new Error('Owned Worker configuration is not prepared');
    if (step.kind === 'd1-migrations') {
      for (const role of ['before', 'after'] as const) await context.perform('d1-migrations', this.#inventory.environments[role].database_id, () => this.#tools.wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--config', this.#config(role)], this.#runtime, context.signal));
      return;
    }
    if (step.kind === 'wrangler-before' || step.kind === 'wrangler-after' || step.kind === 'wrangler-telemetry') {
      const role = step.kind.slice('wrangler-'.length) as 'before' | 'after' | 'telemetry';
      await context.perform('wrangler-deploy', `${lab}-${role}`, () => this.#tools.wrangler(['deploy', '--config', this.#config(role)], this.#runtime, context.signal)); return;
    }
    if (step.kind === 'provision-secrets') {
      const before = derivedServiceSecrets(this.credentials.setup, lab, 'before'); const after = derivedServiceSecrets(this.credentials.setup, lab, 'after');
      for (const role of ['before', 'after'] as const) {
        // Test mode uses Cloudflare's public documented secret; live mode uses the widget secret returned at setup.
        const input = JSON.stringify({ ...(role === 'before' ? before : after), RUN_SECRET: this.credentials.runner, ...(role === 'after' && intent.turnstile ? { TURNSTILE_SECRET: this.#turnstile?.secret ?? TEST_SECRET } : {}) });
        await context.perform('secret-bindings', `${lab}-${role}`, () => this.#tools.wrangler(['secret', 'bulk', '--config', this.#config(role)], this.#runtime, context.signal, input));
      }
      const telemetry = JSON.stringify({ COLLECTOR_SECRET: this.credentials.collector, REGISTRY_SECRET_BEFORE: before.REGISTRY_SECRET, REGISTRY_SECRET_AFTER: after.REGISTRY_SECRET, INGEST_ROOT_SECRET_BEFORE: before.INGEST_ROOT_SECRET, INGEST_ROOT_SECRET_AFTER: after.INGEST_ROOT_SECRET });
      await context.perform('secret-bindings', `${lab}-telemetry`, () => this.#tools.wrangler(['secret', 'bulk', '--config', this.#config('telemetry')], this.#runtime, context.signal, telemetry)); return;
    }
    if (step.kind === 'product-policy' && WafModule.safeParse(step.module).success) {
      if (this.#wafCheckpoint === null) {
        const modules = WafModule.options.filter(m => this.plan.includedModules.includes(m));
        const configured = await provisionWafModules(module => this.#api.customWaf(context, module), lab, intent.discovery.environments[1].origin, modules, this.plan.productStates, context);
        this.#wafRules = configured.ids; this.#wafCheckpoint = digestValue(configured.ruleset); this.#customRuleId = configured.ids.get('waf-custom');
      } else if (digestValue(await this.#api.customWaf().entrypoint(context.signal)) !== this.#wafCheckpoint) throw new Error('Reviewed WAF policies changed during setup');
      return;
    }
    if (step.kind === 'product-policy' && step.module === 'rate-limit') {
      const state = this.plan.productStates.find(s => s.module === 'rate-limit'); if (!state) throw new Error('Reviewed rate product state required');
      const configured = await provisionRateLimit(this.#api.rateLimit(context), desiredRateLimit(lab, intent.discovery.environments[1].origin), state, context);
      this.#rateRuleId = configured.rule!.id; this.#rateCheckpoint = digestValue(configured.ruleset); return;
    }
    if (step.kind === 'product-policy' && ['api-shield', 'access', 'waiting-room'].includes(step.module)) {
      if (!this.options.optionalProducts) throw new Error('Exact reviewed optional setup extension is required');
      await executeOptionalProductSetupStep(step, { ...this.options.optionalProducts, plan: this.plan, context }); return;
    }
    if (step.kind === 'seed-before' || step.kind === 'seed-after') {
      const role = step.kind.slice('seed-'.length) as 'before' | 'after'; const origin = intent.discovery.environments.find(e => e.role === role)!.origin;
      await context.perform('owned-seeds', `${lab}-${role}`, async () => {
        const response = await this.#dispatch(`${origin}/internal/seed`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${derivedServiceSecrets(this.credentials.setup, lab, role).SETUP_SECRET}` }, signal: context.signal });
        const data = z.object({ seeded: z.literal(true), role: z.literal(role), detailDigest: z.string().regex(/^[a-f0-9]{64}$/) }).parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 4096, context.signal))));
        if (response.status !== 200 || data.role !== role) throw new Error('Owned seed verification failed');
      }); return;
    }
    if (step.kind === 'readback') {
      await this.#api.readback(this.#inventory, context.signal);
      if (this.plan.includedModules.includes('bot') && !this.plan.capability.findings.find(f => f.product === 'bot-management')?.reasons.includes(botConfigurationReason(await this.#api.botConfiguration(context.signal)))) throw new Error('Final Bot Management subscription readback drift');
      if (this.#rateCheckpoint !== null && digestValue(await this.#api.rateLimit().entrypoint(context.signal)) !== this.#rateCheckpoint) throw new Error('Final rate readback drift');
      if (this.#wafCheckpoint !== null && digestValue(await this.#api.customWaf().entrypoint(context.signal)) !== this.#wafCheckpoint) throw new Error('Final WAF readback drift');
      for (const environment of intent.discovery.environments) await context.perform('storefront-readback', `${lab}-${environment.role}`, () => readStorefront((url, init) => this.#dispatch(url, init), environment.origin, { role: environment.role, releaseDigest: intent.releaseDigest }, context.signal, this.options.readback));
      const optionalResources = this.options.optionalProducts ? await readConfirmedOptionalResources({ ...this.options.optionalProducts, plan: this.plan, context }) : [];
      writeFileSync(join(this.#runtime, 'runtime-config.json'), JSON.stringify(deployedRuntimeConfig(intent, this.#inventory, this.#customRuleId, [...this.#wafRules.values(), ...(this.#rateRuleId ? [this.#rateRuleId] : [])], this.#rateRuleId, optionalResources, this.#turnstile?.sitekey)), { flag: 'wx', mode: 0o600 });
      writeFileSync(join(this.#runtime, 'deployment.json'), JSON.stringify({ schemaVersion: 1, labId: lab, sourceDigest: this.plan.sourceDigest, releaseDigest: intent.releaseDigest, completedAt: new Date().toISOString(), claims: { coreDeployed: true, interviewVerified: false, workshopVerified: false } }), { flag: 'wx', mode: 0o600 }); return;
    }
    throw new Error('Selected product setup adapter is not implemented');
  }
  async close(): Promise<void> { this.#api.close(); await this.#tools.close(); }
}
