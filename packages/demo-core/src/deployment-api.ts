import { z } from 'zod';
import { BotConfigurationSchema } from './bot-policy.js';
import { desiredRateLimit, RateRulesetSchema } from './rate-policy.js';
import { createHash } from 'node:crypto';
import { boundedBytes } from './deployment-http.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { GuardedClient, type Dispatch } from './transport.js';
import { BudgetLedger } from './budget.js';
import { CORE_VERSIONS, CoreInventorySchema, SYNTHETIC_IMAGE_DIGEST, type CoreInventory, type OwnedImageApi } from './infrastructure.js';
import type { DeploymentIntent } from './deployment-plan.js';
import type { SetupContext } from './deployment-apply.js';
import { validateEvidenceDirectory } from './config.js';
import { ImageVariantSelectionSchema, selectedImageVariantId } from './image-variant-selection.js';
import { assertDeclaredPublicVariant, selectedVariantGroupSchema, SelectedVariantReadbackSchema } from './public-variant-readback.js';
import { CustomWafRulesetSchema, desiredCustomWaf, type CustomWafSetupApi } from './custom-waf.js';
const Text = z.string().max(512);
const Envelope = <S extends z.ZodType>(result: S) => z.object({ success: z.boolean(), result: result.nullable(), errors: z.array(z.object({ code: z.number(), message: Text })).nullable().optional(), result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional(), cursor: z.string().nullable().optional() }).optional() });
const Image = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/), meta: z.object({ owner: z.string(), sourceDigest: z.string() }).optional(), variants: z.array(z.url()).max(30) });
const VariantOptions = ImageVariantSelectionSchema.shape.options;
const CoreAddress = z.enum(['cloudflare_d1_database.storefront', 'cloudflare_r2_bucket.storefront', 'cloudflare_image_variant.catalog']);
const RetainedState = z.strictObject({
  version: z.literal(4), terraform_version: z.literal(CORE_VERSIONS.terraform), serial: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // Terraform lineages are UUID-shaped, but need not have an RFC UUID version.
  lineage: z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).refine(v => v !== '00000000-0000-0000-0000-000000000000'),
  outputs: z.record(z.string(), z.unknown()), check_results: z.array(z.unknown()).nullable().optional(),
  resources: z.array(z.strictObject({
    mode: z.literal('managed'), type: z.enum(['cloudflare_d1_database', 'cloudflare_r2_bucket', 'cloudflare_image_variant']),
    name: z.enum(['storefront', 'catalog']), provider: z.literal('provider["registry.terraform.io/cloudflare/cloudflare"]'),
    instances: z.array(z.strictObject({
      schema_version: z.literal(500), index_key: z.enum(['before', 'after']).optional(), attributes: z.record(z.string(), z.unknown()),
      sensitive_attributes: z.array(z.unknown()).max(100).optional(), private: z.string().max(512 * 1024).optional(),
      dependencies: z.array(CoreAddress).max(3).optional(), identity_schema_version: z.literal(0).optional(), identity: z.null().optional(),
      // status/deposed/module/aliased-provider ownership is never silently adopted.
    })).min(1).max(2),
  })).max(3),
});
type Role = 'before' | 'after';
type RetainedObject = { id: string; name: string };
type RetainedOwnership = { databases: Map<Role, RetainedObject>; buckets: Map<Role, RetainedObject>; variant: z.infer<typeof SelectedVariantReadbackSchema> | undefined };
function retainedOwnership(path: string, accountId: string, labId: string): RetainedOwnership {
  const owned: RetainedOwnership = { databases: new Map(), buckets: new Map(), variant: undefined };
  const initial = lstatSync(path, { throwIfNoEntry: false }); if (!initial) return owned;
  let fd: number | undefined;
  try {
    if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > 4 * 1024 * 1024) throw new Error();
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== initial.dev || before.ino !== initial.ino || before.size > 4 * 1024 * 1024) throw new Error();
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd); const current = lstatSync(path);
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) throw new Error();
    const state = RetainedState.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')));
    if (state.resources.length && state.serial === 0) throw new Error();
    const addresses = new Set<string>(); const ids = new Set<string>();
    for (const resource of state.resources) {
      const address = `${resource.type}.${resource.name}`;
      if (!CoreAddress.safeParse(address).success || addresses.has(address)) throw new Error(); addresses.add(address);
      if (resource.type === 'cloudflare_image_variant') {
        if (resource.instances.length !== 1) throw new Error();
        const instance = resource.instances[0]!; if (instance.index_key !== undefined) throw new Error();
        const a = z.object({ account_id: z.literal(accountId), id: z.literal(`${labId}-catalog`), options: VariantOptions, never_require_signed_urls: z.boolean() }).parse(instance.attributes);
        if (a.options.fit !== 'contain' || a.options.width !== 64 || a.options.height !== 64 || a.options.metadata !== 'none' || a.never_require_signed_urls) throw new Error();
        owned.variant = { id: a.id, options: a.options, neverRequireSignedURLs: a.never_require_signed_urls }; continue;
      }
      const target = resource.type === 'cloudflare_d1_database' ? owned.databases : owned.buckets;
      for (const instance of resource.instances) {
        const role = instance.index_key; if (!role || target.has(role)) throw new Error();
        const name = `${labId}-${role}-${resource.type === 'cloudflare_d1_database' ? 'storefront' : 'objects'}`;
        const a = z.object({ account_id: z.literal(accountId), id: resource.type === 'cloudflare_d1_database' ? z.uuid().refine(v => v !== '00000000-0000-0000-0000-000000000000') : z.literal(name), name: z.literal(name) }).parse(instance.attributes);
        const identity = resource.type === 'cloudflare_d1_database' ? a.id.toLowerCase() : a.id;
        const key = `${resource.type}:${identity}`; if (ids.has(key)) throw new Error(); ids.add(key); target.set(role, { id: a.id, name: a.name });
      }
    }
    return owned;
  } catch { throw new Error('Invalid retained core ownership state'); }
  finally { if (fd !== undefined) closeSync(fd); }
}
function uniqueOwnershipRows<T>(rows: readonly T[], id: (row: T) => string, name: (row: T) => string): void {
  if (new Set(rows.map(id)).size !== rows.length || new Set(rows.map(name)).size !== rows.length) throw new Error('Duplicate or ambiguous provider ownership');
}
export class DeploymentApi {
  readonly #active = new Set<BudgetLedger>();
  readonly #deadline: number;
  #requests = 0;
  #closed = false;
  constructor(readonly projectRoot: string, readonly intent: DeploymentIntent, readonly readerToken: string, readonly deploymentToken: string, readonly dispatch: Dispatch = fetch) {
    this.#deadline = Date.now() + intent.setup.maxRuntimeMs;
  }
  async read<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal, missing = false): Promise<z.infer<S> | null> {
    if (this.#closed || ++this.#requests > 100 || Date.now() >= this.#deadline) throw new Error('Setup read allowance exhausted');
    const ledger = new BudgetLedger({ limits: { requests: 1, maxRuntimeMs: Math.max(1, Math.min(120000, this.#deadline - Date.now())), cleanupRequests: 0, cleanupMs: 0 } });
    this.#active.add(ledger);
    const client = new GuardedClient(this.intent.discovery, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), dispatch: this.dispatch });
    const response = await client.requestJson({ url: `${this.intent.discovery.apiOrigin}/client/v4${path}`, kind: 'cloudflare', headers: { authorization: `Bearer ${this.readerToken}` } }, Envelope(schema), signal).finally(() => { ledger.stop('Read finished'); this.#active.delete(ledger); });
    if (missing && response.status === 404) return null;
    if (response.status !== 200 || !response.data.success) throw new Error('Required setup read is unavailable; no entitlement or ownership inferred');
    const page = response.data.result_info;
    if (page && ((page.page ?? 1) < (page.total_pages ?? 1) || page.cursor)) throw new Error('Setup ownership scan is incomplete');
    const result = Reflect.get(response.data, 'result'); if (result === null) throw new Error('Missing setup read result');
    return schema.parse(result);
  }
  async assertNoForeignCollisions(signal?: AbortSignal): Promise<void> {
    const { accountId, zoneId, labId, environments, telemetryOrigin, evidenceDirectory, imageVariant } = this.intent.discovery;
    const selection = imageVariant === undefined ? undefined : ImageVariantSelectionSchema.parse(imageVariant);
    const workspace = join(evidenceDirectory, 'deployment', 'work', labId, 'core'); validateEvidenceDirectory(workspace, this.projectRoot);
    const owned = retainedOwnership(join(workspace, 'terraform.tfstate'), accountId, labId);
    if (selection && owned.variant) throw new Error('Public Images mode cannot replace a retained managed catalog variant');
    const databases = await this.read(`/accounts/${accountId}/d1/database?per_page=100&page=1`, z.array(z.object({ uuid: Text.min(1), name: Text.min(1) })).max(100), signal);
    const buckets = await this.read(`/accounts/${accountId}/r2/buckets?per_page=100`, z.object({ buckets: z.array(z.object({ name: Text.min(1) })).max(100), cursor: z.string().nullable().optional() }), signal);
    if (!databases || !buckets || databases.length >= 100 || buckets.buckets.length >= 100 || buckets.cursor) throw new Error('Ownership scan exceeds the bounded window');
    uniqueOwnershipRows(databases, d => d.uuid.toLowerCase(), d => d.name); uniqueOwnershipRows(buckets.buckets, b => b.name, b => b.name);
    for (const role of ['before', 'after'] as const) {
      const db = databases.find(d => d.name === `${labId}-${role}-storefront`); const expectedDb = owned.databases.get(role);
      if ((db && db.uuid !== expectedDb?.id) || (expectedDb && (!db || db.uuid !== expectedDb.id))) throw new Error('Existing or retained D1 database is not owned by the reviewed lab state');
      const bucket = buckets.buckets.find(b => b.name === `${labId}-${role}-objects`); const expectedBucket = owned.buckets.get(role);
      if ((bucket && bucket.name !== expectedBucket?.id) || (expectedBucket && !bucket)) throw new Error('Existing or retained R2 bucket is not owned by the reviewed lab state');
    }
    const variantId = selectedImageVariantId(labId, selection);
    const variants = await this.read(`/accounts/${accountId}/images/v1/variants`, selectedVariantGroupSchema(variantId), signal);
    if (!variants) throw new Error('Images variant ownership scan is unavailable');
    if (selection) assertDeclaredPublicVariant(variants, selection);
    else {
      const variant = Object.hasOwn(variants.variants, variantId) ? variants.variants[variantId] : undefined;
      if (variant && !owned.variant) throw new Error('Existing Images variant is not owned by the reviewed lab state');
      if (owned.variant && (!variant || variant.id !== owned.variant.id || variant.neverRequireSignedURLs !== owned.variant.neverRequireSignedURLs || variant.options.fit !== owned.variant.options.fit || variant.options.width !== owned.variant.options.width || variant.options.height !== owned.variant.options.height || variant.options.metadata !== owned.variant.options.metadata)) throw new Error('Retained Images variant ownership or options changed');
    }
    const scripts = await this.read(`/accounts/${accountId}/workers/scripts`, z.array(z.object({ id: z.string() })).max(100), signal);
    const domains = await this.read(`/accounts/${accountId}/workers/domains`, z.array(z.object({ hostname: z.string(), service: z.string() })).max(100), signal);
    if (!scripts || !domains || scripts.length >= 100 || domains.length >= 100) throw new Error('Worker ownership scan exceeds the bounded window');
    const origins = [...environments.map(e => ({ role: e.role, origin: e.origin })), { role: 'telemetry', origin: telemetryOrigin }];
    for (const { role, origin } of origins) {
      const name = `${labId}-${role}`; const hostname = new URL(origin).hostname;
      if (scripts.some(s => s.id === name)) {
        const settings = await this.read(`/accounts/${accountId}/workers/scripts/${name}/settings`, z.object({ bindings: z.array(z.object({ name: z.string(), type: z.string(), text: z.string().optional() })).max(100) }), signal);
        const binding = (key: string) => settings?.bindings.find(b => b.name === key && b.type === 'plain_text')?.text;
        if (binding('ORIGIN') !== origin || binding('LAB_ID') !== labId) throw new Error('Existing Worker does not match owned lab markers');
      }
      const domain = domains.find(d => d.hostname === hostname);
      if (domain && domain.service !== name) throw new Error('Existing hostname routes to a foreign Worker');
      const dns = await this.read(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100&page=1`, z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })).max(100), signal);
      if (!dns || dns.length >= 100 || (dns.length && !domain)) throw new Error('Hostname already has unowned DNS; no automatic reassignment permitted');
    }
  }
  images(context?: SetupContext): OwnedImageApi {
    const account = this.intent.discovery.accountId;
    return {
      inspect: async id => {
        const result = await this.read(`/accounts/${account}/images/v1/${id}`, Image, context?.signal, true);
        if (!result) return null;
        if (!result.meta) throw new Error('Image ownership metadata is missing');
        return { id: result.id, metadata: result.meta, variants: result.variants };
      },
      upload: async input => {
        if (!context || this.#closed) throw new Error('Image writes require an active reviewed setup context');
        return context.perform('images-upload', input.id, async () => {
          const roles = ['before', 'after'] as const; const role = roles.find(r => input.id === `${this.intent.discovery.labId}-${r}-product`);
          if (createHash('sha256').update(input.bytes).digest('hex') !== SYNTHETIC_IMAGE_DIGEST) throw new Error('Arbitrary image payloads are forbidden');
          if (!role || input.metadata.owner !== `${this.intent.discovery.labId}:${role}:immutable-catalog` || input.metadata.sourceDigest !== SYNTHETIC_IMAGE_DIGEST) throw new Error('Only the declared synthetic owned image may be uploaded');
          const form = new FormData(); form.set('id', input.id); form.set('file', new Blob([Uint8Array.from(input.bytes)], { type: 'image/png' }), 'synthetic-shirt.png'); form.set('metadata', JSON.stringify(input.metadata)); form.set('requireSignedURLs', 'false');
          const response = await this.dispatch(`${this.intent.discovery.apiOrigin}/client/v4/accounts/${account}/images/v1`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${this.deploymentToken}` }, body: form, signal: context.signal });
          const text = new TextDecoder().decode(await boundedBytes(response, 65536, context.signal));
          const result = Envelope(Image).parse(JSON.parse(text)); if (!response.ok || !result.success || !result.result) throw new Error('Image setup failed');
          return { id: result.result.id, variants: result.result.variants };
        });
      },
    };
  }
  /** Finds or creates the lab's After registration widget; an existing owned widget gets a rotated secret because Cloudflare returns secrets only on create/rotate. */
  async ensureTurnstileWidget(context: SetupContext): Promise<{ sitekey: string; secret: string }> {
    if (this.#closed) throw new Error('Setup context closed');
    const account = this.intent.discovery.accountId; const name = `${this.intent.discovery.labId}-after-register`;
    const host = new URL(this.intent.discovery.environments[1].origin).hostname;
    const base = `${this.intent.discovery.apiOrigin}/client/v4/accounts/${account}/challenges/widgets`;
    const Sitekey = z.string().regex(/^0x[A-Za-z0-9_-]{10,60}$/);
    const call = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> => {
      const response = await this.dispatch(`${base}${path}`, { method, redirect: 'error', headers: { authorization: `Bearer ${this.deploymentToken}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: context.signal });
      const parsed = JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536, context.signal)));
      if (!response.ok || parsed?.success !== true) throw new Error('Turnstile widget setup failed');
      return parsed.result;
    };
    return context.perform('turnstile-widget', name, async () => {
      const listed = z.array(z.object({ sitekey: Sitekey, name: z.string().max(256), domains: z.array(z.string().max(253)).max(20) })).max(50).parse(await call('?per_page=50', 'GET'));
      const existing = listed.filter(widget => widget.name === name);
      if (existing.length > 1) throw new Error('Owned Turnstile widget name is ambiguous');
      const Secret = z.object({ sitekey: Sitekey, secret: z.string().min(20).max(200) });
      if (existing[0]) {
        if (existing[0].domains.length !== 1 || existing[0].domains[0] !== host) throw new Error('Existing Turnstile widget is scoped to a different hostname');
        return Secret.parse(await call(`/${existing[0].sitekey}/rotate_secret`, 'POST', { invalidate_immediately: true }));
      }
      return Secret.parse(await call('', 'POST', { name, domains: [host], mode: 'managed', bot_fight_mode: false, region: 'world' }));
    });
  }
  customWaf(context?: SetupContext, module: import('./product-state.js').WafModule = 'waf-custom'): CustomWafSetupApi {
    const zone = this.intent.discovery.zoneId;
    const expected = desiredCustomWaf(this.intent.discovery.labId, this.intent.discovery.environments[1].origin, module);
    const id = (value: string) => z.string().regex(/^[a-f0-9]{32}$/).parse(value);
    const body = (rule: ReturnType<typeof desiredCustomWaf>) => {
      if (JSON.stringify(rule) !== JSON.stringify(expected)) throw new Error('Custom WAF target differs from the declared owned contract');
      return { ref: expected.ref, action: expected.action, enabled: true, description: expected.description, expression: expected.expression };
    };
    const write = async (path: string, method: 'POST' | 'PATCH', payload: unknown, signal: AbortSignal) => {
      if (!context || this.#closed || !context.plan.includedModules.includes(module)) throw new Error('Selected reviewed custom-WAF setup context required');
      signal.throwIfAborted();
      const response = await this.dispatch(`${this.intent.discovery.apiOrigin}/client/v4/zones/${zone}/rulesets${path}`, { method, redirect: 'error', headers: { authorization: `Bearer ${this.deploymentToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
      const result = Envelope(CustomWafRulesetSchema).parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536, signal))));
      if (!response.ok || !result.success || !result.result) throw new Error('Custom WAF setup failed; no automatic overwrite or retry');
    };
    return {
      entrypoint: signal => this.read(`/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`, CustomWafRulesetSchema, signal, true),
      create: async (rule, signal) => write('', 'POST', { name: `${this.intent.discovery.labId}-security-demos`, kind: 'zone', phase: 'http_request_firewall_custom', rules: [body(rule)] }, signal),
      append: async (rulesetId, rule, signal) => write(`/${id(rulesetId)}/rules`, 'POST', body(rule), signal),
      enable: async (rulesetId, ruleId, signal) => write(`/${id(rulesetId)}/rules/${id(ruleId)}`, 'PATCH', { enabled: true }, signal),
    };
  }
  async botConfiguration(signal?: AbortSignal) {
    const result = await this.read(`/zones/${this.intent.discovery.zoneId}/bot_management`, BotConfigurationSchema, signal);
    if (!result) throw new Error('Current scored Bot Management subscription readback is unavailable'); return result;
  }
  rateLimit(context?: SetupContext): import('./rate-policy.js').RateSetupApi {
    const zone = this.intent.discovery.zoneId; const expected = desiredRateLimit(this.intent.discovery.labId, this.intent.discovery.environments[1].origin);
    const id = (value: string) => z.string().regex(/^[a-f0-9]{32}$/).parse(value);
    const body = (rule: ReturnType<typeof desiredRateLimit>) => { if (JSON.stringify(rule) !== JSON.stringify(expected)) throw new Error('Rate policy target differs from the declared contract'); return { ref: expected.ref, description: expected.description, action: expected.action, enabled: true, expression: expected.expression, ratelimit: expected.ratelimit }; };
    const write = async (path: string, method: 'POST' | 'PATCH', payload: unknown, signal: AbortSignal) => {
      if (!context || this.#closed || !context.plan.includedModules.includes('rate-limit')) throw new Error('Selected reviewed rate setup context required'); signal.throwIfAborted();
      const response = await this.dispatch(`${this.intent.discovery.apiOrigin}/client/v4/zones/${zone}/rulesets${path}`, { method, redirect: 'error', headers: { authorization: `Bearer ${this.deploymentToken}`, 'content-type': 'application/json' }, body: JSON.stringify(payload), signal });
      const result = Envelope(RateRulesetSchema).parse(JSON.parse(new TextDecoder().decode(await boundedBytes(response, 65536, signal))));
      if (!response.ok || !result.success || !result.result) throw new Error('Rate setup failed; no automatic overwrite or retry');
    };
    return { entrypoint: signal => this.read(`/zones/${zone}/rulesets/phases/http_ratelimit/entrypoint`, RateRulesetSchema, signal, true),
      create: async (rule, signal) => write('', 'POST', { name: `${this.intent.discovery.labId}-rate-demo`, kind: 'zone', phase: 'http_ratelimit', rules: [body(rule)] }, signal),
      append: async (rulesetId, rule, signal) => write(`/${id(rulesetId)}/rules`, 'POST', body(rule), signal),
      enable: async (rulesetId, ruleId, signal) => write(`/${id(rulesetId)}/rules/${id(ruleId)}`, 'PATCH', { enabled: true }, signal),
    };
  }
  async #checkPublicVariant(signal?: AbortSignal): Promise<void> {
    const input = this.intent.discovery.imageVariant;
    if (input === undefined) return;
    const selection = ImageVariantSelectionSchema.parse(input);
    const group = await this.read(`/accounts/${this.intent.discovery.accountId}/images/v1/variants`, selectedVariantGroupSchema(selection.id), signal);
    if (!group) throw new Error('Public Images variant dependency read is unavailable');
    assertDeclaredPublicVariant(group, selection);
  }
  async checkImagesBeforePlan(signal?: AbortSignal): Promise<void> {
    await this.#checkPublicVariant(signal);
    const api = this.images();
    for (const role of ['before', 'after'] as const) {
      signal?.throwIfAborted(); const id = `${this.intent.discovery.labId}-${role}-product`; const image = await api.inspect(id);
      if (image && (image.id !== id || image.metadata.owner !== `${this.intent.discovery.labId}:${role}:immutable-catalog` || image.metadata.sourceDigest !== SYNTHETIC_IMAGE_DIGEST)) throw new Error('Foreign or differing image cannot be adopted');
    }
  }
  async readback(inventory: CoreInventory, signal: AbortSignal): Promise<void> {
    const core = CoreInventorySchema.parse(inventory);
    const config = this.intent.discovery;
    if (core.account_id !== config.accountId || core.lab_id !== config.labId || core.image_variant !== selectedImageVariantId(config.labId, config.imageVariant)) throw new Error('Deployment readback inventory differs from the declared lab and Images selection');
    await this.#checkPublicVariant(signal);
    for (const role of ['before', 'after'] as const) {
      const db = await this.read(`/accounts/${core.account_id}/d1/database/${core.environments[role].database_id}`, z.object({ uuid: z.string(), name: z.string() }), signal);
      if (!db || db.uuid !== core.environments[role].database_id || db.name !== core.environments[role].database_name) throw new Error('Database deployment readback mismatch');
    }
  }
  close(): void { this.#closed = true; for (const ledger of this.#active) ledger.stop('Setup reads complete'); }
}
