import { z } from 'zod';
import { readBotConfiguration, botConfigurationReason } from './bot-policy.js';
import { createHash } from 'node:crypto';
import { CapabilitySchema, CapabilityState, Time } from '../../contracts/src/schemas.js';
import { GuardedClient } from './transport.js';
import { CloudflareReader } from './cloudflare.js';
import type { TargetConfig } from './config.js';
import { ImageVariantSelectionSchema } from './image-variant-selection.js';
import { assertDeclaredPublicVariant, selectedVariantGroupSchema } from './public-variant-readback.js';
export const Profile = z.enum(['core', 'core-waf', 'waf-signatures', 'rate-limit', 'lab-core', 'bot', 'workshop']);
export type Profile = z.infer<typeof Profile>;
const Short = z.string().min(1).max(256);
export const FindingSchema = z.strictObject({ state: CapabilityState, source: Short, reasons: z.array(Short).max(20) });
export type Finding = z.infer<typeof FindingSchema>;
const CORE = ['account', 'zone', 'deployment-permissions', 'workers', 'd1', 'r2', 'images', 'containers', 'tooling', 'collector-configuration'] as const;
export const MODULES = {
  'waf-custom': ['custom-waf', 'security-events'],
  'waf-sqli': ['custom-waf', 'security-events'],
  'waf-xss': ['custom-waf', 'security-events'],
  'rate-limit': ['rate-limiting', 'security-events'],
  bot: ['bot-management', 'custom-waf', 'security-events'],
  turnstile: ['turnstile'],
  'api-shield': ['api-shield'],
  access: ['access'],
  'waiting-room': ['waiting-room'],
  'ddos-evidence': ['ddos-evidence'],
  analytics: ['security-events'],
} as const;
export const CAPABILITY_KEYS = [...new Set<string>([...CORE, ...Object.values(MODULES).flat()])];
export interface CapabilityProvider { readonly mode: 'live' | 'fixture'; inspect(key: string, signal?: AbortSignal): Promise<Finding> }
export const SnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(['live', 'fixture']), profile: Profile,
  accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/), observedAt: Time,
  findings: z.array(CapabilitySchema).max(50), required: z.array(Short).max(50), blockers: z.array(Short).max(50),
  includedModules: z.array(Short).max(20), excludedModules: z.array(z.strictObject({ id: Short, reasons: z.array(Short).min(1).max(20) })).max(20),
  deployable: z.boolean(), fullCatalogAvailable: z.boolean(),
});
export type CapabilitySnapshot = z.infer<typeof SnapshotSchema>;
export async function discoverCapabilities(config: TargetConfig, profile: Profile, provider: CapabilityProvider, signal?: AbortSignal, now = new Date().toISOString()): Promise<CapabilitySnapshot> {
  Profile.parse(profile); Time.parse(now);
  const findings: z.infer<typeof CapabilitySchema>[] = [];
  for (const key of CAPABILITY_KEYS) {
    signal?.throwIfAborted(); let finding: Finding;
    try { finding = FindingSchema.parse(await provider.inspect(key, signal)); }
    catch { finding = { state: 'unknown', source: 'read-only discovery', reasons: ['Capability could not be verified'] }; }
    findings.push(CapabilitySchema.parse({ schemaVersion: 1, product: key, ...finding, accountId: config.accountId, zoneId: config.zoneId, observedAt: now, confidence: finding.state === 'unknown' ? 'unknown' : 'confirmed', dependencies: key === 'account' ? [] : ['account', ...(key === 'zone' ? [] : ['zone'])] }));
  }
  const good = (key: string) => findings.find(f => f.product === key)?.state === 'available';
  const required = [...CORE, ...(['core-waf', 'waf-signatures', 'rate-limit', 'lab-core', 'bot'].includes(profile) ? MODULES['waf-custom'] : []), ...(['rate-limit', 'lab-core'].includes(profile) ? MODULES['rate-limit'] : []), ...(profile === 'bot' ? MODULES.bot : [])];
  const blockers = required.filter(key => !good(key));
  const includedModules: string[] = blockers.some(b => (CORE as readonly string[]).includes(b)) ? [] : ['core'];
  const excludedModules: { id: string; reasons: string[] }[] = [];
  for (const [id, dependencies] of Object.entries(MODULES)) {
    const gaps = dependencies.filter(dep => !good(dep));
    const selected = profile === 'workshop' || (profile === 'core-waf' && id === 'waf-custom') || (profile === 'waf-signatures' && ['waf-custom', 'waf-sqli', 'waf-xss'].includes(id)) || (profile === 'rate-limit' && ['waf-custom', 'rate-limit'].includes(id)) || (profile === 'lab-core' && ['waf-custom', 'waf-sqli', 'waf-xss', 'rate-limit', 'analytics'].includes(id)) || (profile === 'bot' && ['waf-custom', 'bot'].includes(id));
    if (!selected || gaps.length || !includedModules.includes('core')) excludedModules.push({ id, reasons: [...(selected ? [] : ['Not selected by this profile']), ...gaps.map(gap => `${gap}: ${findings.find(f => f.product === gap)!.state}`), ...(!includedModules.includes('core') ? ['Core prerequisites unresolved'] : [])] });
    else includedModules.push(id);
  }
  return SnapshotSchema.parse({ schemaVersion: 1, mode: provider.mode, profile, accountId: config.accountId, zoneId: config.zoneId, observedAt: now, findings, required, blockers, includedModules, excludedModules, deployable: blockers.length === 0, fullCatalogAvailable: CORE.every(good) && Object.values(MODULES).every(deps => deps.every(good)) });
}
export function capabilityDigest(snapshot: CapabilitySnapshot): string {
  const value = SnapshotSchema.parse(snapshot);
  // Observation time changes on every recheck; functional findings determine drift.
  return createHash('sha256').update(JSON.stringify({ accountId: value.accountId, zoneId: value.zoneId, profile: value.profile, mode: value.mode, findings: value.findings.map(f => ({ product: f.product, state: f.state, reasons: f.reasons, dependencies: f.dependencies })), required: value.required, includedModules: value.includedModules, excludedModules: value.excludedModules })).digest('hex');
}
const Id32 = z.string().regex(/^[a-f0-9]{32}$/);
const ListPage = z.object({ page: z.number().optional(), total_pages: z.number().optional(), cursor: z.string().nullable().optional() }).optional();
const ListEnvelope = <S extends z.ZodType>(result: S) => z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), result: result.nullable(), errors: z.array(z.object({ code: z.number(), message: z.string().max(4096) })).max(30).nullable().optional(), result_info: ListPage }),
  // Failed reads prove no result. Do not let an error-body result obscure a permission gap.
  z.object({ success: z.literal(false), result: z.unknown().optional().transform(() => null), errors: z.unknown().optional().transform(() => []), result_info: ListPage }),
]);
const Policy = z.object({ effect: z.enum(['allow', 'deny']), permission_groups: z.array(z.object({ id: Id32, name: z.string().max(128).optional() })).max(100), resources: z.record(z.string().max(256), z.union([z.literal('*'), z.record(z.string(), z.string())])) });
const Token = z.object({ id: Id32, status: z.string().max(30).optional(), expires_on: z.string().nullable().optional(), not_before: z.string().nullable().optional(), condition: z.object({ request_ip: z.unknown().optional() }).optional(), policies: z.array(Policy).max(100).optional() });
const PERMISSIONS = [
  { names: ['Workers Scripts Write', 'Workers Scripts Edit'], scope: 'account' },
  { names: ['D1 Write', 'D1 Edit'], scope: 'account' },
  { names: ['Workers R2 Storage Write', 'R2 Storage Write'], scope: 'account' },
  { names: ['Cloudflare Images Write', 'Images Write'], scope: 'account' },
  { names: ['Workers Containers Write', 'Workers Containers Edit', 'Containers Write', 'Containers Edit'], scope: 'account' },
  { names: ['DNS Write', 'DNS Edit'], scope: 'zone' },
] as const;
export class ApiCapabilityProvider implements CapabilityProvider {
  readonly mode = 'live' as const;
  readonly #cache = new Map<string, Promise<unknown>>();
  constructor(readonly config: TargetConfig, readonly client: GuardedClient, readonly reader: CloudflareReader, readonly options: {
    deploymentClient?: GuardedClient; deploymentToken?: string; tokenKind?: 'user' | 'account';
    tooling: Finding; collectorConfigured: boolean;
  }) {}
  async #read<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal, deploy = false): Promise<z.infer<S>> {
    const client = deploy ? this.options.deploymentClient : this.client;
    const token = deploy ? this.options.deploymentToken : this.reader.token;
    if (!client || !token) throw Object.assign(new Error('Deployment credential introspection unavailable'), { state: 'unknown' });
    const response = await client.requestJson({ url: `${this.config.apiOrigin}/client/v4${path}`, kind: 'cloudflare', headers: { authorization: `Bearer ${token}` } }, ListEnvelope(schema), signal);
    if ([401, 403].includes(response.status)) throw Object.assign(new Error('Read permission denied; entitlement is unknown'), { state: 'permission-denied' });
    const result: unknown = Reflect.get(response.data, 'result');
    if (response.status !== 200 || !response.data.success || result === null || result === undefined) throw Object.assign(new Error('Capability API response is not authoritative'), { state: 'unknown' });
    const page = response.data.result_info;
    if (page && ((page.page ?? 1) < (page.total_pages ?? 1) || page.cursor)) throw Object.assign(new Error('Capability pagination incomplete'), { state: 'unknown' });
    return schema.parse(result);
  }
  async #ownedImage(id: string, signal?: AbortSignal) {
    const schema = z.object({ id: z.string(), meta: z.object({ owner: z.string() }).optional() });
    const response = await this.client.requestJson({ url: `${this.config.apiOrigin}/client/v4/accounts/${this.config.accountId}/images/v1/${id}`, kind: 'cloudflare', headers: { authorization: `Bearer ${this.reader.token}` } }, ListEnvelope(schema), signal);
    if (response.status === 404) return null;
    if ([401, 403].includes(response.status)) throw Object.assign(new Error('Images read denied'), { state: 'permission-denied' });
    const value: unknown = Reflect.get(response.data, 'result');
    if (response.status !== 200 || !response.data.success || value === null) throw new Error('Image ownership unavailable');
    return schema.parse(value);
  }
  #once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.#cache.has(key)) this.#cache.set(key, fn());
    return this.#cache.get(key) as Promise<T>;
  }
  async #deploymentPermissions(signal?: AbortSignal, requirements: readonly { names: readonly string[]; scope: 'account' | 'zone' }[] = PERMISSIONS): Promise<Finding> {
    const token = await this.#once('deployment-token-detail', async () => {
      const prefix = this.options.tokenKind === 'account' ? `/accounts/${this.config.accountId}/tokens` : '/user/tokens';
      const verified = await this.#read(`${prefix}/verify`, Token.omit({ policies: true, condition: true }), signal, true);
      if (verified.status !== 'active') throw Object.assign(new Error('Deployment token not active'), { state: 'misconfigured' });
      const detail = await this.#read(`${prefix}/${Id32.parse(verified.id)}`, Token, signal, true);
      if (detail.id !== verified.id || (detail.status && detail.status !== 'active')) throw Object.assign(new Error('Token identity mismatch'), { state: 'misconfigured' });
      return detail;
    });
    const now = Date.now();
    if ((token.expires_on && (!Number.isFinite(Date.parse(token.expires_on)) || Date.parse(token.expires_on) <= now)) || (token.not_before && (!Number.isFinite(Date.parse(token.not_before)) || Date.parse(token.not_before) > now))) return { state: 'misconfigured', source: 'token introspection', reasons: ['Deployment token time constraints do not allow use'] };
    if (!token.policies || token.condition?.request_ip) return { state: 'unknown', source: 'token introspection', reasons: ['Token policy or IP constraints need verification'] };
    const grants = token.policies;
    if (grants.some(p => p.effect === 'deny')) return { state: 'unknown', source: 'token introspection', reasons: ['Deny-policy effects require a resolved permission proof'] };
    const unresolved = requirements.filter(permission => !grants.some(policy => {
      const scope = permission.scope === 'account' ? `com.cloudflare.api.account.${this.config.accountId}` : `com.cloudflare.api.account.zone.${this.config.zoneId}`;
      const broadScope = permission.scope === 'account' ? 'com.cloudflare.api.account.*' : 'com.cloudflare.api.account.zone.*';
      const permittedScope = policy.resources[scope] === '*'
        || (this.config.credentials.allowBroadApiToken === true && policy.resources[broadScope] === '*');
      return policy.effect === 'allow' && permittedScope && policy.permission_groups.some(group => permission.names.some(name => name === group.name));
    }));
    return { state: unresolved.length ? 'permission-denied' : 'available', source: 'token introspection', reasons: unresolved.length ? ['Exact account/zone core deployment grants missing'] : [] };
  }
  async inspect(key: string, signal?: AbortSignal): Promise<Finding> {
    try {
      const account = this.config.accountId; const zone = this.config.zoneId;
      switch (key) {
        case 'tooling': return FindingSchema.parse(this.options.tooling);
        case 'collector-configuration': return { state: this.options.collectorConfigured ? 'available' : 'misconfigured', source: 'local secret references', reasons: this.options.collectorConfigured ? [] : ['Collector credential reference is unresolved'] };
        case 'deployment-permissions': return await this.#once(key, () => this.#deploymentPermissions(signal));
        case 'account': { const a = await this.#read(`/accounts/${account}`, z.object({ id: Id32 }), signal); if (a.id !== account) throw new Error('Account mismatch'); break; }
        case 'zone': { const a = await this.#read(`/zones/${zone}`, z.object({ id: Id32, status: z.string(), account: z.object({ id: Id32 }) }), signal); if (a.id !== zone || a.account.id !== account || a.status !== 'active') return { state: 'misconfigured', source: 'zone readback', reasons: ['Zone account or active status mismatch'] }; break; }
        case 'workers': await this.#read(`/accounts/${account}/workers/account-settings`, z.object({ default_usage_model: z.string().optional() }), signal); break;
        case 'd1': await this.#read(`/accounts/${account}/d1/database?per_page=100&page=1`, z.array(z.object({ uuid: z.string() })).max(100), signal); break;
        case 'r2': await this.#read(`/accounts/${account}/r2/buckets?per_page=100`, z.object({ buckets: z.array(z.object({ name: z.string() })).max(100) }), signal); break;
        case 'images': {
          const stats = await this.#read(`/accounts/${account}/images/v1/stats`, z.object({ count: z.object({ current: z.number().int().nonnegative(), allowed: z.number().int().nonnegative() }) }), signal);
          if (stats.count.allowed - stats.count.current < 2) {
            let existing = 0;
            for (const role of ['before', 'after']) {
              const image = await this.#ownedImage(`${this.config.labId}-${role}-product`, signal);
              if (!image) continue;
              if (image.id !== `${this.config.labId}-${role}-product` || image.meta?.owner !== `${this.config.labId}:${role}:immutable-catalog`) return { state: 'unknown', source: 'Images quota and ownership', reasons: ['Existing image ownership is not proven'] };
              existing++;
            }
            if (2 - existing > stats.count.allowed - stats.count.current) return { state: 'unknown', source: 'Images quota and ownership', reasons: ['Capacity for both owned lab images is not proven'] };
          }
          if (this.config.imageVariant !== undefined) {
            const selection = ImageVariantSelectionSchema.parse(this.config.imageVariant);
            // Deliberately uncached: each Images inspection must observe this dependency afresh.
            const group = await this.#read(`/accounts/${account}/images/v1/variants`, selectedVariantGroupSchema(selection.id), signal);
            assertDeclaredPublicVariant(group, selection);
          }
          break;
        }
        case 'containers': {
          const subscriptions = await this.#once('account-subscriptions', () => this.#read(`/accounts/${account}/subscriptions`, z.array(z.object({ state: z.string().optional(), current_period_end: z.string().optional(), rate_plan: z.object({ id: z.string().optional() }).optional() })).max(100), signal));
          const workersPaid = subscriptions.some(subscription => subscription.rate_plan?.id === 'workers_paid' && ['Paid', 'Provisioned'].includes(subscription.state ?? '') && subscription.current_period_end && Date.parse(subscription.current_period_end) > Date.now());
          if (!workersPaid) return { state: 'unknown', source: 'account subscription readback', reasons: ['An active Workers Paid prerequisite for Containers is not proven; no subscription will be purchased automatically'] };
          await this.#read(`/accounts/${account}/containers/applications?per_page=100`, z.array(z.object({ id: z.string() })).max(100), signal); break;
        }
        case 'custom-waf': case 'rate-limiting': await this.#once('rulesets', () => this.reader.rulesets(signal)); break;
        case 'turnstile': await this.reader.turnstileWidgets(signal); break;
        case 'access': await this.reader.accessApplications(signal); break;
        case 'waiting-room': await this.reader.waitingRooms(signal); break;
        case 'security-events': {
          const end = new Date(); const start = new Date(end.getTime() - 60000);
          await this.reader.securityEvents({ zoneId: zone, start: start.toISOString(), end: end.toISOString(), rayId: '0000000000000000', hostname: new URL(this.config.environments[1].origin).hostname, limit: 1 }, signal); break;
        }
        case 'bot-management': return { state: 'available', source: 'current Bot Management subscription configuration', reasons: [botConfigurationReason(await readBotConfiguration(this.client, this.reader.token, signal))] };
        case 'api-shield': case 'ddos-evidence': return { state: 'unknown', source: 'product-specific qualification', reasons: ['No authoritative entitlement and proof source has been established'] };
        default: return { state: 'unknown', source: 'capability registry', reasons: ['Capability has no supported read adapter'] };
      }
      const productPermissions: Record<string, { names: string[]; scope: 'account' | 'zone' }> = {
        'custom-waf': { names: ['Zone WAF Write', 'Zone WAF Edit'], scope: 'zone' },
        'rate-limiting': { names: ['Zone WAF Write', 'Zone WAF Edit'], scope: 'zone' },
        turnstile: { names: ['Turnstile Sites Write'], scope: 'account' },
        access: { names: ['Access: Apps and Policies Write'], scope: 'account' },
        'waiting-room': { names: ['Waiting Rooms Write', 'Waiting Rooms Edit'], scope: 'zone' },
      };
      if (productPermissions[key]) {
        const permission = await this.#deploymentPermissions(signal, [productPermissions[key]!]);
        if (permission.state !== 'available') return permission;
      }
      // A successful API read confirms discoverable API access, not runtime enforcement or billing safety.
      return { state: 'available', source: 'Cloudflare read-only API', reasons: [] };
    } catch (error) {
      const state = FindingSchema.shape.state.safeParse((error as { state?: unknown }).state);
      return { state: state.success ? state.data : 'unknown', source: 'Cloudflare read-only API', reasons: [state.success && state.data === 'permission-denied' ? 'API read denied; entitlement not inferred' : 'Required capability could not be verified'] };
    }
  }
}
