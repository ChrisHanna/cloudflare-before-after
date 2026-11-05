import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { desiredRateLimit, inspectRateLimit, rateReader } from './rate-policy.js';
import { observedWafPolicies } from './waf-modules.js';
import { CATALOG, IMPLEMENTED_SCENARIOS } from '../../../scenarios/catalog.js';
import { CoverageSchema, ReceiptSchema } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { validateLabConfig, type LabConfig } from './config.js';
import { BudgetLedger, limitsFor, validatePlan, type Limits, type Clock } from './budget.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { CloudflareReader } from './cloudflare.js';
import { LabLease } from './lifecycle.js';
import { assertSupportedNode } from './index.js';
import { desiredCustomWaf, inspectCustomWaf } from './custom-waf.js';
import { imageUrl, ImageAssetSchema, type ImageAsset } from '../../../apps/storefront-worker/src/assets.js';
import { SYNTHETIC_IMAGE_DIGEST } from './infrastructure.js';
import { selectedImageVariantId } from './image-variant-selection.js';
import { assertDeclaredPublicVariant, selectedVariantGroupSchema } from './public-variant-readback.js';
export const DemoCredentialsSchema = z.strictObject({ reader: z.string().min(24), collector: z.string().min(24), runner: z.string().min(24) }).refine(c => new Set(Object.values(c)).size === 3, 'Separate demo credentials required');
export type DemoCredentials = z.infer<typeof DemoCredentialsSchema>;
const Check = z.strictObject({ id: z.string().max(128), state: z.enum(['passed', 'failed', 'unavailable', 'unknown']), detail: z.string().max(256), correctiveAction: z.string().max(256) });
export const DoctorSchema = z.strictObject({
  schemaVersion: z.literal(1), mode: z.enum(['live', 'fixture']), scope: z.enum(['catalog', 'core-waf']), observedAt: z.iso.datetime(), labId: z.string(), accountId: z.string(), zoneId: z.string(),
  checks: z.array(Check).max(100), catalog: z.array(z.strictObject({ id: z.string(), product: z.string(), implemented: z.boolean(), state: z.enum(['available', 'unavailable']), reason: z.string().max(256) })).length(11),
  observedOwnedResources: z.array(z.string().max(256)).max(500), preflightReady: z.boolean(),
  claims: z.strictObject({ deploymentVerified: z.literal(false), interviewVerified: z.literal(false), workshopVerified: z.literal(false), mitigationVerified: z.literal(false) }),
  requestsUsed: z.number().int().nonnegative(), durationMs: z.number().nonnegative(),
});
export type DoctorReport = z.infer<typeof DoctorSchema>;
const Text = z.string().max(4096);
const Binding = z.object({ name: z.string().max(128), type: z.string().max(128), text: Text.optional(), id: z.string().max(128).optional(), bucket_name: z.string().max(128).optional(), class_name: z.string().max(128).optional(), namespace_id: z.string().max(128).optional() }).transform(b => ({ ...b, text: b.type === 'plain_text' && ['ROLE', 'ORIGIN', 'LAB_ID', 'RELEASE_DIGEST', 'IMAGE_ASSET_JSON'].includes(b.name) ? b.text : undefined }));
const Settings = z.object({ bindings: z.array(Binding).max(100) });
const OriginResponse = z.strictObject({ schemaVersion: z.literal(1), targetRole: z.enum(['before', 'after']), runId: z.uuid(), scenarioId: z.literal('waf-custom'), originCount: z.number().int().nonnegative().nullable(), receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema });
const OwnerEnvelope = <S extends z.ZodType>(schema: S) => z.object({ success: z.boolean(), result: schema.nullable(), errors: z.array(z.object({ code: z.number(), message: z.string().max(4096) })).max(30).nullable().optional().transform(() => []), result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional(), cursor: z.string().nullable().optional() }).optional() });
/** Work reads only; callers retain their existing cleanup reserve and hard cap. */
export function doctorMinimumRequests(config: Pick<LabConfig, 'imageVariant' | 'rateLimitRuleId'>): number {
  return 24 + (config.rateLimitRuleId ? 1 : 0) + (config.imageVariant ? 2 : 0);
}
export interface DoctorOptions {
  projectRoot: string; config: LabConfig; credentials: DemoCredentials; mode: 'live' | 'fixture'; scope?: 'catalog' | 'core-waf';
  limits?: Partial<Limits>; dispatch?: Dispatch; signal?: AbortSignal; parent?: BudgetLedger; clock?: Clock;
}
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const config = validateLabConfig(options.config, options.projectRoot); const credentials = DemoCredentialsSchema.parse(options.credentials);
  z.enum(['live', 'fixture']).parse(options.mode); const scope = z.enum(['catalog', 'core-waf']).parse(options.scope ?? 'catalog');
  if (options.mode === 'fixture' && !options.dispatch) throw new Error('Fixture doctor requires injected transport');
  if (!config.liveOptIn) throw new Error('Explicit owned-lab probe opt-in required');
  const limits = limitsFor('scenario', options.limits); validatePlan(limits, doctorMinimumRequests(config), 0, 1000);
  const claim = LabLease.claim({ projectRoot: options.projectRoot, evidenceDirectory: config.evidenceDirectory, labId: config.labId, idempotencyKey: randomUUID() });
  if (claim.kind !== 'claimed') throw new Error('Lab is owned by an active run');
  const ledger = new BudgetLedger({ limits, ...(options.parent ? { parent: options.parent } : {}), ...(options.clock ? { clock: options.clock } : {}) }); const startedClock = ledger.clock.now(); const startedAt = new Date().toISOString();
  const signal = options.signal ? AbortSignal.any([options.signal, ledger.signal]) : ledger.signal;
  const checks: z.infer<typeof Check>[] = []; const observed = new Set<string>(); const images = new Map<'before' | 'after', ImageAsset>();
  const namespaces = new Map<'before' | 'after', string>();
  const client = new GuardedClient(config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor: new Redactor(Object.values(credentials)) });
  const cf = new CloudflareReader(client, credentials.reader);
  const add = (id: string, state: z.infer<typeof Check>['state'], detail: string, correctiveAction = '') => { checks.push(Check.parse({ id, state, detail, correctiveAction })); };
  const mark = (type: string, role: string, id: string) => observed.add(`${type}:${role}:${id}`);
  const check = async (id: string, test: () => Promise<boolean>, fix: string) => {
    try { const good = await test(); add(id, good ? 'passed' : 'failed', good ? 'Declared lab configuration and observation match' : 'Declared lab configuration or observation differs', good ? '' : fix); }
    catch { add(id, 'unknown', 'Readiness could not be verified within the read-only budget', fix); }
  };
  const read = async <S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S>> => {
    const response = await client.requestJson({ url: `${config.apiOrigin}/client/v4${path}`, kind: 'cloudflare', headers: { authorization: `Bearer ${credentials.reader}` } }, OwnerEnvelope(schema), signal);
    const result: unknown = Reflect.get(response.data, 'result'); const page = response.data.result_info;
    if (response.status !== 200 || !response.data.success || result === null || (page && ((page.page ?? 1) !== 1 || (page.total_pages ?? 1) > 1 || page.cursor))) throw new Error('Read access or complete result unavailable');
    return schema.parse(result);
  };
  try {
    try { assertSupportedNode(); add('local-node', 'passed', 'Supported Node.js runtime'); } catch { add('local-node', 'failed', 'Unsupported Node.js runtime', 'Install the pinned supported Node.js version'); }
    add('local-config', 'passed', 'Exact HTTPS allowlists, isolated bindings and env references validated');
    add('local-manifests', 'passed', 'All eleven manifests validate; implementation availability is separate');
    await check('account', async () => (await read(`/accounts/${config.accountId}`, z.object({ id: z.string() }))).id === config.accountId, 'Use reader access for the configured lab account');
    await check('zone', async () => { const zone = await read(`/zones/${config.zoneId}`, z.object({ id: z.string(), status: z.string(), account: z.object({ id: z.string() }) })); return zone.id === config.zoneId && zone.account.id === config.accountId && zone.status === 'active'; }, 'Use an active zone belonging to the configured lab account');
    await check('hostname-routes', async () => {
      const domains = await read(`/accounts/${config.accountId}/workers/domains`, z.array(z.object({ hostname: z.string(), service: z.string() })).max(100)); if (domains.length >= 100) return false;
      return [...config.environments.map(e => ({ host: new URL(e.origin).hostname, worker: e.workerName })), { host: new URL(config.telemetryOrigin).hostname, worker: `${config.labId}-telemetry` }].every(e => domains.filter(d => d.hostname === e.host).length === 1 && domains.some(d => d.hostname === e.host && d.service === e.worker));
    }, 'Deploy the reviewed exact Before/After/telemetry custom domains; do not repair routing during a demo');
    let publicReady = config.imageVariant === undefined;
    const checkPublic = async (phase: 'before' | 'after') => {
      const selection = config.imageVariant; if (!selection) return;
      await check(`public-variant-${phase}`, async () => {
        const group = await read(`/accounts/${config.accountId}/images/v1/variants`, selectedVariantGroupSchema(selection.id));
        assertDeclaredPublicVariant(group, selection); publicReady = true; return true;
      }, 'Restore read-only access to the exact declared public dependency; never repair or adopt the shared variant');
    };
    await checkPublic('before');
    for (const env of config.environments) {
      await check(`${env.role}-worker-bindings`, async () => {
        const settings = await read(`/accounts/${config.accountId}/workers/scripts/${env.workerName}/settings`, Settings);
        if (new Set(settings.bindings.map(binding => binding.name)).size !== settings.bindings.length) return false;
        const plain = (name: string) => settings.bindings.find(b => b.name === name && b.type === 'plain_text')?.text;
        const d1 = settings.bindings.find(b => b.name === 'DB' && b.type === 'd1'); const r2 = settings.bindings.find(b => b.name === 'OBJECTS' && b.type === 'r2_bucket');
        const origin = settings.bindings.find(b => b.name === 'ORIGINS' && b.type === 'durable_object_namespace');
        const asset = ImageAssetSchema.parse(JSON.parse(plain('IMAGE_ASSET_JSON') ?? 'null'));
        const secrets = ['RUN_SECRET', 'INTERNAL_SECRET', 'REGISTRY_SECRET', 'INGEST_ROOT_SECRET', 'SETUP_SECRET'].every(name => settings.bindings.some(b => b.name === name && b.type === 'secret_text'));
        const good = plain('LAB_ID') === config.labId && plain('ROLE') === env.role && plain('ORIGIN') === env.origin && plain('RELEASE_DIGEST') === env.releaseDigest && d1?.id === env.d1Id && r2?.bucket_name === env.r2Bucket && (origin?.class_name === 'OriginContainer' || !!origin?.namespace_id) && asset.role === env.role && asset.labId === config.labId && env.imageIds.includes(asset.id) && asset.variant === selectedImageVariantId(config.labId, config.imageVariant) && config.imageOrigins.includes(asset.deliveryOrigin) && secrets;
        if (good) { mark('worker', env.role, env.workerName); images.set(env.role, asset); if (origin?.namespace_id) namespaces.set(env.role, origin.namespace_id); } return good;
      }, 'Redeploy the reviewed matching release/bindings/secret references; never paste secret values into reports');
      await check(`${env.role}-d1`, async () => {
        const db = await read(`/accounts/${config.accountId}/d1/database/${env.d1Id}`, z.object({ uuid: z.string(), name: z.string() }));
        const good = db.uuid === env.d1Id && db.name === `${config.labId}-${env.role}-storefront`; if (good) mark('d1', env.role, env.d1Id); return good;
      }, 'Bind the isolated owned D1 database for this lab role');
      await check(`${env.role}-r2`, async () => {
        const bucket = await read(`/accounts/${config.accountId}/r2/buckets/${env.r2Bucket}`, z.object({ name: z.string() }));
        const good = bucket.name === env.r2Bucket && bucket.name === `${config.labId}-${env.role}-objects`; if (good) mark('r2', env.role, env.r2Bucket); return good;
      }, 'Bind the isolated owned R2 bucket for this lab role');
      await check(`${env.role}-images`, async () => {
        if (env.imageIds.length !== 1) return false;
        const id = env.imageIds[0]!; const image = await read(`/accounts/${config.accountId}/images/v1/${id}`, z.object({ id: z.string(), meta: z.object({ owner: z.string(), sourceDigest: z.string() }) }));
        const good = image.id === id && image.meta.owner === `${config.labId}:${env.role}:immutable-catalog` && image.meta.sourceDigest === SYNTHETIC_IMAGE_DIGEST; if (good) mark('image', env.role, id); return good;
      }, 'Use the owned immutable synthetic image assets; do not replace unrelated images');
      await check(`${env.role}-containers`, async () => {
        const apps = await read(`/accounts/${config.accountId}/containers/applications?name=${encodeURIComponent(env.containerBinding)}`, z.array(z.object({ id: z.string(), name: z.string(), durable_objects: z.object({ namespace_id: z.string() }).optional() })).max(100));
        const candidates = apps.filter(a => a.name === env.containerBinding);
        const good = candidates.length === 1 && env.containerBinding === `${config.labId}-${env.role}-origin` && (!namespaces.has(env.role) || candidates[0]?.durable_objects?.namespace_id === namespaces.get(env.role)); if (good) mark('container', env.role, env.containerBinding); return good;
      }, 'Deploy and qualify the role-specific Container application with available account capacity');
    }
    await check('telemetry-bindings', async () => {
      const settings = await read(`/accounts/${config.accountId}/workers/scripts/${config.labId}-telemetry/settings`, Settings);
      const plain = (name: string) => settings.bindings.find(b => b.name === name && b.type === 'plain_text')?.text;
      const d1Good = config.environments.every(e => settings.bindings.some(b => b.name === `DB_${e.role.toUpperCase()}` && b.type === 'd1' && b.id === e.d1Id));
      const secrets = ['COLLECTOR_SECRET', 'INGEST_ROOT_SECRET_BEFORE', 'INGEST_ROOT_SECRET_AFTER', 'REGISTRY_SECRET_BEFORE', 'REGISTRY_SECRET_AFTER'].every(name => settings.bindings.some(b => b.name === name && b.type === 'secret_text'));
      const good = plain('LAB_ID') === config.labId && plain('ORIGIN') === config.telemetryOrigin && plain('RELEASE_DIGEST') === config.environments[0].releaseDigest && d1Good && secrets;
      if (good) for (const e of config.environments) mark('telemetry', e.role, `${config.labId}-telemetry`); return good;
    }, 'Restore the reviewed authenticated telemetry Worker bindings and collector reference');
    await check('waf-custom-policy', async () => {
      const policy = await inspectCustomWaf({ entrypoint: s => cf.customWafEntrypoint(s) }, desiredCustomWaf(config.labId, config.environments[1].origin), signal);
      const good = policy.state.owned && policy.state.enabled === true && policy.rule !== null;
      if (good && policy.ruleset) for (const id of observedWafPolicies(config, policy.ruleset)) observed.add(id); return good;
    }, 'Install the reviewed After-only /catalog synthetic-header custom rule; no demo-time policy changes');
    if (config.rateLimitRuleId) await check('rate-policy-ownership', async () => {
      const policy = await inspectRateLimit(rateReader(client, credentials.reader), desiredRateLimit(config.labId, config.environments[1].origin), signal);
      if (!policy.state.owned || !policy.rule || policy.rule.id !== config.rateLimitRuleId) return false; mark('policy', 'after', policy.rule.id); return true;
    }, 'Restore reviewed rate-rule ownership; do not reset counters');
    await check('security-events-access', async () => {
      const end = new Date().toISOString(); const start = new Date(Date.parse(end) - 60000).toISOString();
      await cf.securityEvents({ zoneId: config.zoneId, hostname: new URL(config.environments[1].origin).hostname, start, end, rayId: '0000000000000000', limit: 1 }, signal); return true;
    }, 'Grant read-only Security Events access; an empty result is access proof, not mitigation proof');
    const allOwned = ['account', 'zone', 'hostname-routes'].every(id => checks.some(c => c.id === id && c.state === 'passed')) && config.inventory.every(i => observed.has(`${i.type}:${i.role}:${i.id}`));
    if (allOwned && publicReady) {
      const runtime = new GuardedClient(config, ledger, { observedOwnedResources: observed, ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor: new Redactor(Object.values(credentials)) });
      const probes = new Map<'before' | 'after', string>();
      for (const env of config.environments) {
        const requestId = randomUUID(); probes.set(env.role, requestId);
        await check(`${env.role}-storefront-probe`, async () => {
          const response = await runtime.request({ url: `${env.origin}/catalog`, kind: env.role, headers: { 'x-demo-run-id': claim.lease.runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': credentials.runner } }, signal);
          return response.status === 200 && response.metadata.role === env.role && response.metadata.releaseDigest === env.releaseDigest && ['d1', 'r2', 'images-reference', 'container-completed'].every(s => response.metadata.services.includes(s));
        }, 'Check TLS, deployed application health and real Container/receipt delivery without editing infrastructure');
        await check(`${env.role}-image-delivery`, async () => {
          const asset = images.get(env.role); if (!asset) return false;
          const response = await runtime.request({ url: imageUrl(asset, env.role, config.labId), kind: 'image', headers: { accept: 'image/png' } }, signal);
          return response.status === 200 && response.metadata.bodyBytes > 0 && response.metadata.contentType?.startsWith('image/') === true;
        }, 'Restore delivery of the owned configured image variant');
      }
      const end = new Date().toISOString();
      for (const env of config.environments) await check(`${env.role}-telemetry-probe`, async () => {
        const checkpoint = await runtime.request({ url: `${env.origin}/internal/checkpoint?${new URLSearchParams({ runId: claim.lease.runId, scenarioId: 'waf-custom' })}`, kind: env.role, headers: { 'x-demo-run-token': credentials.runner } }, signal);
        if (checkpoint.status !== 200) return false;
        const response = await runtime.requestJson({ url: `${config.telemetryOrigin}/receipts?${new URLSearchParams({ role: env.role, runId: claim.lease.runId, scenarioId: 'waf-custom', start: startedAt, end })}`, kind: 'telemetry', headers: { authorization: `Bearer ${credentials.collector}` } }, OriginResponse, signal);
        const data = response.data;
        return response.status === 200 && data.targetRole === env.role && data.runId === claim.lease.runId && data.coverage.windowStart === startedAt && data.coverage.healthy && data.coverage.complete && !data.coverage.gaps.length && data.coverage.watermark !== null && data.coverage.watermark >= end && data.receipts.some(r => r.stage === 'entry' && r.requestId === probes.get(env.role) && r.targetRole === env.role && r.releaseDigest === env.releaseDigest && r.runId === claim.lease.runId && r.scenarioId === 'waf-custom' && r.observedAt >= startedAt && r.observedAt <= end);
      }, 'Repair trusted receipt ingestion/checkpoints during explicit setup, not during the interview');
    } else add('runtime-probes', 'unknown', 'Probes skipped because declared ownership is incomplete', 'Resolve the named binding/ownership checks before sending lab traffic');
    await checkPublic('after');
    const coreGood = allOwned && checks.every(c => c.state === 'passed');
    const catalog = CATALOG.map(m => {
      const implemented = (IMPLEMENTED_SCENARIOS as readonly string[]).includes(m.id);
      return { id: m.id, product: m.product, implemented, state: implemented && m.id === 'waf-custom' && coreGood ? 'available' as const : 'unavailable' as const, reason: !implemented ? 'Scenario execution is not implemented or qualified yet' : m.id !== 'waf-custom' ? 'This scoped doctor does not qualify this product policy; run its bounded comparison' : coreGood ? 'Scoped configuration, access and allowed-probe prerequisites passed; mitigation still requires the scenario test' : 'One or more scoped preflight checks failed or remain unknown' };
    });
    return DoctorSchema.parse({ schemaVersion: 1, mode: options.mode, scope, observedAt: new Date().toISOString(), labId: config.labId, accountId: config.accountId, zoneId: config.zoneId, checks, catalog, observedOwnedResources: [...observed], preflightReady: coreGood && (scope === 'core-waf' || catalog.every(c => c.state === 'available')), claims: { deploymentVerified: false, interviewVerified: false, workshopVerified: false, mitigationVerified: false }, requestsUsed: ledger.snapshot.requestsUsed, durationMs: ledger.clock.now() - startedClock });
  } finally { ledger.stop('Doctor finished'); claim.lease.release(); }
}
