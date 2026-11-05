import { z } from 'zod';
import type { LabConfig } from './config.js';
import type { GuardedClient } from './transport.js';
import { ImageAssetSchema } from '../../../apps/storefront-worker/src/assets.js';
import { SYNTHETIC_IMAGE_DIGEST } from './infrastructure.js';
import { CloudflareReader } from './cloudflare.js';
import { observedWafPolicies } from './waf-modules.js';
import { desiredRateLimit, inspectRateLimit, rateReader } from './rate-policy.js';

/** Reserve independent policy reads; resource inventory alone is not proof. */
export function policyOwnershipMinimum(config: LabConfig): number {
  const policies = config.inventory.filter(i => i.type === 'policy');
  return Number(policies.some(i => i.id !== config.rateLimitRuleId)) + Number(!!config.rateLimitRuleId);
}
export async function observePolicyOwnership(config: LabConfig, token: string, client: GuardedClient, owned: ReadonlySet<string>, signal: AbortSignal): Promise<ReadonlySet<string>> {
  const observed = new Set(owned);
  const missing = config.inventory.filter(i => i.type === 'policy' && !observed.has(`policy:${i.role}:${i.id}`));
  if (missing.some(i => i.id !== config.rateLimitRuleId)) {
    const ruleset = await new CloudflareReader(client, token).customWafEntrypoint(signal);
    if (ruleset.rules.length >= 100 || new Set(ruleset.rules.map(r => r.id)).size !== ruleset.rules.length) throw new Error('Incomplete or ambiguous policy ownership');
    for (const id of observedWafPolicies(config, ruleset)) observed.add(id);
  }
  if (config.rateLimitRuleId && missing.some(i => i.id === config.rateLimitRuleId)) {
    const read = await inspectRateLimit(rateReader(client, token), desiredRateLimit(config.labId, config.environments[1].origin), signal);
    if (read.state.owned && read.rule?.id === config.rateLimitRuleId) observed.add(`policy:after:${read.rule.id}`);
  }
  return observed;
}
export const OWNERSHIP_MIN_REQUESTS = 11;
const Text = z.string().max(4096);
const Binding = z.object({ name: z.string().max(128), type: z.string().max(128), text: Text.optional(), id: z.string().max(128).optional(), bucket_name: z.string().max(128).optional(), class_name: z.string().max(128).optional(), namespace_id: z.string().max(128).optional() }).transform(b => ({ ...b, text: b.type === 'plain_text' && ['ROLE', 'ORIGIN', 'LAB_ID', 'RELEASE_DIGEST', 'IMAGE_ASSET_JSON'].includes(b.name) ? b.text : undefined }));
const Settings = z.object({ bindings: z.array(Binding).max(100) });
export async function observeRuntimeOwnership(config: LabConfig, readerToken: string, client: GuardedClient, signal: AbortSignal): Promise<ReadonlySet<string>> {
  const read = async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    const envelope = z.object({ success: z.boolean(), result: schema.nullable(), errors: z.array(z.object({ code: z.number(), message: Text })).max(30).nullable(), result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional(), cursor: z.string().nullable().optional() }).optional() });
    const response = await client.requestJson({ url: `${config.apiOrigin}/client/v4${path}`, kind: 'cloudflare', headers: { authorization: `Bearer ${readerToken}` } }, envelope, signal);
    const result: unknown = Reflect.get(response.data, 'result'); const page = response.data.result_info;
    if (response.status !== 200 || !response.data.success || result === null || (page && ((page.page ?? 1) < (page.total_pages ?? 1) || page.cursor))) throw new Error('Current lab ownership readback is unavailable');
    return schema.parse(result);
  };
  const owned = new Set<string>(); const mark = (type: string, role: string, id: string) => owned.add(`${type}:${role}:${id}`);
  const zone = await read(`/zones/${config.zoneId}`, z.object({ id: z.string(), status: z.string(), account: z.object({ id: z.string() }) }));
  if (zone.id !== config.zoneId || zone.account.id !== config.accountId || zone.status !== 'active') throw new Error('Zone ownership differs from the declared lab');
  const domains = await read(`/accounts/${config.accountId}/workers/domains`, z.array(z.object({ hostname: z.string(), service: z.string() })).max(100));
  if (domains.length >= 100) throw new Error('Hostname scan is incomplete');
  for (const env of config.environments) {
    if (domains.filter(d => d.hostname === new URL(env.origin).hostname).length !== 1 || !domains.some(d => d.hostname === new URL(env.origin).hostname && d.service === env.workerName)) throw new Error('Storefront hostname does not route to the declared lab Worker');
    const settings = await read(`/accounts/${config.accountId}/workers/scripts/${env.workerName}/settings`, Settings);
    const plain = (name: string) => settings.bindings.find(b => b.name === name && b.type === 'plain_text')?.text;
    const d1 = settings.bindings.find(b => b.name === 'DB' && b.type === 'd1'); const bucket = settings.bindings.find(b => b.name === 'OBJECTS' && b.type === 'r2_bucket'); const container = settings.bindings.find(b => b.name === 'ORIGINS' && b.type === 'durable_object_namespace');
    const asset = ImageAssetSchema.parse(JSON.parse(plain('IMAGE_ASSET_JSON') ?? 'null'));
    if (plain('LAB_ID') !== config.labId || plain('ROLE') !== env.role || plain('ORIGIN') !== env.origin || plain('RELEASE_DIGEST') !== env.releaseDigest || d1?.id !== env.d1Id || bucket?.bucket_name !== env.r2Bucket || env.r2Bucket !== `${config.labId}-${env.role}-objects` || (!container?.namespace_id && container?.class_name !== 'OriginContainer') || asset.role !== env.role || asset.labId !== config.labId || !env.imageIds.includes(asset.id) || !config.imageOrigins.includes(asset.deliveryOrigin)) throw new Error('Scoped application bindings or release changed');
    for (const name of ['RUN_SECRET', 'INTERNAL_SECRET', 'INGEST_ROOT_SECRET', 'REGISTRY_SECRET']) if (!settings.bindings.some(b => b.name === name && b.type === 'secret_text')) throw new Error('Runtime service bindings are incomplete');
    const db = await read(`/accounts/${config.accountId}/d1/database/${env.d1Id}`, z.object({ uuid: z.string(), name: z.string() }));
    if (db.uuid !== env.d1Id || db.name !== `${config.labId}-${env.role}-storefront`) throw new Error('D1 target is not the isolated synthetic lab database');
    for (const id of env.imageIds) {
      const image = await read(`/accounts/${config.accountId}/images/v1/${id}`, z.object({ id: z.string(), meta: z.object({ owner: z.string(), sourceDigest: z.string() }) }));
      if (image.id !== id || image.meta.owner !== `${config.labId}:${env.role}:immutable-catalog` || image.meta.sourceDigest !== SYNTHETIC_IMAGE_DIGEST) throw new Error('Image asset is not owned synthetic lab content');
      mark('image', env.role, id);
    }
    const apps = await read(`/accounts/${config.accountId}/containers/applications?name=${encodeURIComponent(env.containerBinding)}`, z.array(z.object({ id: z.string(), name: z.string(), durable_objects: z.object({ namespace_id: z.string() }).optional() })).max(100));
    const candidates = apps.filter(a => a.name === env.containerBinding);
    if (candidates.length !== 1 || env.containerBinding !== `${config.labId}-${env.role}-origin` || (container?.namespace_id && candidates[0]?.durable_objects?.namespace_id !== container.namespace_id)) throw new Error('Container namespace ownership is unverified');
    mark('worker', env.role, env.workerName); mark('d1', env.role, env.d1Id);
    // R2 target ownership is the canonical scoped binding; allowed controls test its actual application path.
    mark('r2', env.role, env.r2Bucket); mark('container', env.role, env.containerBinding);
  }
  if (domains.filter(d => d.hostname === new URL(config.telemetryOrigin).hostname).length !== 1 || !domains.some(d => d.hostname === new URL(config.telemetryOrigin).hostname && d.service === `${config.labId}-telemetry`)) throw new Error('Telemetry hostname is not the declared lab service');
  const telemetry = await read(`/accounts/${config.accountId}/workers/scripts/${config.labId}-telemetry/settings`, Settings);
  const plain = (name: string) => telemetry.bindings.find(b => b.name === name && b.type === 'plain_text')?.text;
  if (plain('LAB_ID') !== config.labId || plain('ORIGIN') !== config.telemetryOrigin || plain('RELEASE_DIGEST') !== config.environments[0].releaseDigest) throw new Error('Telemetry release or host scope changed');
  for (const env of config.environments) {
    if (!telemetry.bindings.some(b => b.name === `DB_${env.role.toUpperCase()}` && b.type === 'd1' && b.id === env.d1Id)) throw new Error('Telemetry database scope changed');
    mark('telemetry', env.role, `${config.labId}-telemetry`);
  }
  return owned;
}
