import { z } from 'zod';
import { PlanSchema, digestValue, assessCost, PLAN_LIFETIME_MS, type DeploymentPlan, type DeploymentStep } from './deployment-plan.js';
import { capabilityDigest } from './capabilities.js';
import { WaitingRoomSettingsSchema, WaitingRoomExecutionSchema } from './waiting-room.js';
import type { SetupContext } from './deployment-apply.js';
import { OptionalRuntimeResourceSchema, type OptionalRuntimeResource } from './config.js';

const Id = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Module = z.enum(['api-shield', 'access', 'waiting-room']);
export type OptionalProductModule = z.infer<typeof Module>;
const RequestSchema = z.discriminatedUnion('module', [
  z.strictObject({ module: z.literal('api-shield'), certificateId: Id, certificateSource: z.literal('zone-managed').optional(), certificateRef: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/), fingerprint: Hash }),
  z.strictObject({ module: z.literal('access'), serviceTokenId: Id }),
  z.strictObject({ module: z.literal('waiting-room'), settings: WaitingRoomSettingsSchema.extend({ path: z.literal('/launch') }), execution: WaitingRoomExecutionSchema.optional() }),
]);
export type OptionalProductSelection = z.infer<typeof RequestSchema>;
const Resource = z.object({ id: Id, name: z.string().min(1).max(256) }).passthrough();
type ResourceValue = z.infer<typeof Resource>;
export interface OptionalProductState {
  module: OptionalProductModule;
  /** Full bounded product scope, including foreign entries, for drift/collision checks. */
  resources: ResourceValue[];
  rulesetId: string | null;
  certificate: { id: string; fingerprint: string; hostname: string; ready: boolean } | null;
  serviceTokenId: string | null;
}
const StateSchema = z.strictObject({ module: Module, resources: z.array(Resource).max(100), rulesetId: Id.nullable(),
  certificate: z.strictObject({ id: Id, fingerprint: Hash, hostname: z.string(), ready: z.boolean() }).nullable(), serviceTokenId: Id.nullable() });
const OperationSchema = z.strictObject({ id: Hash, module: Module, selection: RequestSchema,
  beforeDigest: Hash, ownershipIds: z.array(Id).max(100) });
export const OptionalProductSetupPlanSchema = z.strictObject({ schemaVersion: z.literal(1), centralPlanDigest: Hash,
  operations: z.array(OperationSchema).max(3), wranglerVersion: z.literal('4.157.0'),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime() });
export type OptionalProductSetupPlan = z.infer<typeof OptionalProductSetupPlanSchema>;
export interface OptionalProductApproval {
  planDigest: string; centralPlanDigest: string; approvedAt: string;
}
export interface OptionalProductJournal {
  /** Must be durable and exclusive, before provider dispatch; duplicate keys must fail. */
  begin(record: OptionalProductRecord): Promise<void>;
  get(key: string): Promise<OptionalProductRecord | null>;
  save(record: OptionalProductRecord): Promise<void>;
}
export interface OptionalProductRecord {
  key: string; planDigest: string; operationId: string; state: 'possible' | 'confirmed';
  resourceIds: string[]; afterDigest: string | null;
}
export interface OptionalProductProvider {
  readonly mode: 'live' | 'fixture';
  inspect(plan: DeploymentPlan, selection: OptionalProductSelection, signal: AbortSignal): Promise<OptionalProductState>;
  /** Only the closed selection union is accepted. No arbitrary URL, body or command. */
  create(plan: DeploymentPlan, selection: OptionalProductSelection, current: OptionalProductState, signal: AbortSignal): Promise<string[]>;
}
function scope(plan: DeploymentPlan) {
  const d = plan.intent.discovery;
  const before = d.environments.find(e => e.role === 'before'); const after = d.environments.find(e => e.role === 'after');
  if (!before || !after) throw new Error('Paired environment scope required');
  const b = new URL(before.origin); const a = new URL(after.origin);
  if (b.origin === a.origin || a.protocol !== 'https:' || b.protocol !== 'https:' || a.pathname !== '/' || b.pathname !== '/') throw new Error('Exact distinct HTTPS hosts required');
  return { accountId: d.accountId, zoneId: d.zoneId, labId: d.labId, beforeHost: b.hostname, afterHost: a.hostname };
}
function name(plan: DeploymentPlan, module: OptionalProductModule) { return `cf-demo-${scope(plan).labId}-${module}`; }
export function optionalProductDesired(plan: DeploymentPlan, input: OptionalProductSelection) {
  const selection = RequestSchema.parse(input); const s = scope(plan); const owner = name(plan, selection.module);
  if (selection.module === 'api-shield') return { ref: owner, description: owner, action: 'block', enabled: true,
    expression: `(http.host eq ${JSON.stringify(s.afterHost)} and http.request.uri.path eq "/api" and (not cf.tls_client_auth.cert_verified or cf.tls_client_auth.cert_revoked or not cf.tls_client_auth.cert_fingerprint_sha256 in {${JSON.stringify(selection.fingerprint)}}))` };
  if (selection.module === 'access') return { name: owner, type: 'self_hosted', domain: `${s.afterHost}/admin`, session_duration: '1h',
    // Inline policies are supported by the Access applications API. Never create a bypass.
    policies: [{ name: owner, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: selection.serviceTokenId } }], exclude: [], require: [] }] };
  if (selection.settings.hostname !== s.afterHost) throw new Error('Waiting Room hostname differs from approved After host');
  const { hostname, ...settings } = selection.settings;
  return { name: owner.replaceAll('-', '_'), host: hostname, ...settings };
}
function ownedResource(plan: DeploymentPlan, selection: OptionalProductSelection, resource: ResourceValue) {
  const desired = optionalProductDesired(plan, selection);
  return selection.module === 'api-shield' ? resource['ref'] === desired.ref : resource.name === desired.name;
}
function matchesDesired(plan: DeploymentPlan, selection: OptionalProductSelection, resource: ResourceValue): boolean {
  const desired = optionalProductDesired(plan, selection);
  // Compare only declared functional fields. Reject extra Access policies and altered selectors.
  return Object.entries(desired).every(([key, value]) => {
    if (key === 'policies') {
      const policies = resource[key];
      if (!Array.isArray(policies) || policies.length !== 1) return false;
      return Object.entries((value as Record<string, unknown>[])[0]!).every(([k, v]) => digestValue((policies[0] as Record<string, unknown>)[k]) === digestValue(v));
    }
    return digestValue(resource[key]) === digestValue(value);
  });
}
function validateState(plan: DeploymentPlan, selection: OptionalProductSelection, input: OptionalProductState, ownershipIds: readonly string[]) {
  const state = StateSchema.parse(input);
  if (state.module !== selection.module || state.resources.length >= 100 || new Set(state.resources.map(r => r.id)).size !== state.resources.length) throw new Error('Incomplete or ambiguous product readback');
  const s = scope(plan); optionalProductDesired(plan, selection);
  if (selection.module === 'api-shield' && (!state.certificate || !state.certificate.ready || state.certificate.id !== selection.certificateId || state.certificate.hostname !== s.afterHost || state.certificate.fingerprint !== selection.fingerprint)) throw new Error('Existing owned certificate and hostname association required');
  if (selection.module === 'access' && state.serviceTokenId !== selection.serviceTokenId) throw new Error('Existing lab service-token ID required; no token purchase or creation');
  const owned = state.resources.filter(r => ownedResource(plan, selection, r));
  if (owned.length > 1 || owned.some(r => !ownershipIds.includes(r.id))) throw new Error('Existing product lacks prior owned-resource identity');
  for (const resource of state.resources) {
    if (owned.includes(resource)) continue;
    if (selection.module === 'access' && typeof resource['domain'] === 'string') {
      const domain = resource['domain'];
      if ([s.beforeHost, s.afterHost].some(host => domain === host || domain.startsWith(`${host}/`) || domain.startsWith('*.'))) throw new Error('Overlapping Access application requires separate review');
    }
    if (selection.module === 'waiting-room' && [s.beforeHost, s.afterHost].includes(String(resource['host']))) throw new Error('Overlapping Waiting Room requires separate review');
  }
  if (owned.some(r => !matchesDesired(plan, selection, r))) throw new Error('Owned configuration drift requires a new explicit update plan');
  return { state, owned };
}
function validateCentral(plan: DeploymentPlan, now: number) {
  PlanSchema.parse(plan); scope(plan);
  if (plan.status !== 'review-required' || plan.blockers.length || !plan.capability.deployable || plan.capability.blockers.length) throw new Error('Central plan is blocked');
  if (now < Date.parse(plan.createdAt) || now >= Date.parse(plan.expiresAt) || now - Date.parse(plan.createdAt) > PLAN_LIFETIME_MS || now < Date.parse(plan.capability.observedAt) || now - Date.parse(plan.capability.observedAt) > PLAN_LIFETIME_MS) throw new Error('Central plan or capabilities stale');
  if (plan.toolVersions.wrangler !== '4.157.0' || plan.capability.mode !== plan.mode || plan.capability.accountId !== plan.intent.discovery.accountId || plan.capability.zoneId !== plan.intent.discovery.zoneId || plan.capability.profile !== plan.intent.profile) throw new Error('Central account, zone, tool or profile mismatch');
  if (digestValue(plan.intent) !== plan.intentDigest || capabilityDigest(plan.capability) !== plan.capabilityDigest || digestValue(plan.includedModules) !== digestValue(plan.capability.includedModules) || digestValue(plan.excludedModules) !== digestValue(plan.capability.excludedModules)) throw new Error('Central plan scope or capability drift');
  if (assessCost(plan.intent.costs, now).blockers.length || digestValue(assessCost(plan.intent.costs, now)) !== digestValue(plan.cost)) throw new Error('Monthly cost unresolved or changed');
}
function selected(plan: DeploymentPlan, module: OptionalProductModule) {
  if (!plan.includedModules.includes(module) || plan.excludedModules.some(m => m.id === module) || !plan.steps.some(s => s.kind === 'product-policy' && s.module === module && s.deletes === false)) throw new Error('Product excluded from exact central plan');
  const findings = plan.capability.findings.filter(f => f.product === module);
  if (findings.length !== 1 || findings[0]!.state !== 'available' || findings[0]!.accountId !== plan.intent.discovery.accountId || findings[0]!.zoneId !== plan.intent.discovery.zoneId) throw new Error('Selected product capability or entitlement unresolved');
}
/** Read-only extension. Its digest must be reviewed in addition to the central plan. */
export async function planOptionalProductSetup(plan: DeploymentPlan, selections: readonly OptionalProductSelection[], provider: OptionalProductProvider,
  ownership: Partial<Record<OptionalProductModule, readonly string[]>>, signal: AbortSignal, now = Date.now()): Promise<OptionalProductSetupPlan> {
  validateCentral(plan, now); signal.throwIfAborted();
  const parsedSelections = z.array(RequestSchema).max(3).parse(selections);
  if (provider.mode !== plan.mode || new Set(parsedSelections.map(selection => selection.module)).size !== parsedSelections.length) throw new Error('Duplicate modules or provider mode mismatch');
  const operations: OptionalProductSetupPlan['operations'] = [];
  for (const selection of parsedSelections) {
    selected(plan, selection.module);
    const ids = [...(ownership[selection.module] ?? [])]; ids.forEach(id => Id.parse(id));
    const { state } = validateState(plan, selection, await provider.inspect(plan, selection, signal), ids);
    const operation = { module: selection.module, selection, beforeDigest: digestValue(state), ownershipIds: ids };
    operations.push({ ...operation, id: digestValue({ centralPlanDigest: digestValue(plan), ...operation }) });
  }
  return OptionalProductSetupPlanSchema.parse({ schemaVersion: 1, centralPlanDigest: digestValue(plan), operations,
    wranglerVersion: '4.157.0', createdAt: new Date(now).toISOString(), expiresAt: plan.expiresAt });
}
export interface OptionalProductApplyOptions {
  plan: DeploymentPlan; setup: OptionalProductSetupPlan; approval: OptionalProductApproval | null;
  provider: OptionalProductProvider; journal: OptionalProductJournal; context: SetupContext;
  /** Reload the saved central plan and repeat read-only prerequisite/source checks. */
  revalidate(signal: AbortSignal): Promise<DeploymentPlan>;
  now?: () => number;
  /** Central executors dispatch exactly the current product-policy step. */
  module?: OptionalProductModule;
}
export async function applyOptionalProductSetup(options: OptionalProductApplyOptions): Promise<{ status: 'succeeded' | 'partial'; records: OptionalProductRecord[] }> {
  const { provider, journal, context } = options; const setup = OptionalProductSetupPlanSchema.parse(options.setup);
  const now = options.now ?? Date.now; const setupDigest = digestValue(setup); const records: OptionalProductRecord[] = [];
  if (new Set(setup.operations.map(op => op.module)).size !== setup.operations.length) throw new Error('Duplicate optional operations');
  function checkApproval() {
    context.signal.throwIfAborted(); const time = now(); const approval = options.approval;
    if (!approval || approval.planDigest !== setupDigest || approval.centralPlanDigest !== setup.centralPlanDigest || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) < Date.parse(setup.createdAt) || Date.parse(approval.approvedAt) > time || time - Date.parse(approval.approvedAt) > PLAN_LIFETIME_MS || time >= Date.parse(setup.expiresAt)) throw new Error('Fresh exact optional-plan approval required');
  }
  async function guard() {
    checkApproval();
    const fresh = PlanSchema.parse(await options.revalidate(context.signal)); validateCentral(fresh, now());
    checkApproval();
    if (digestValue(fresh) !== setup.centralPlanDigest || digestValue(options.plan) !== setup.centralPlanDigest || digestValue(context.plan) !== setup.centralPlanDigest || fresh.mode !== provider.mode || fresh.mode === 'live' && !fresh.intent.discovery.liveOptIn) throw new Error('Exact central plan, source, account or scope changed');
    return fresh;
  }
  // Validate ALL selections before the first write, not just the next selected module.
  const plan = await guard();
  for (const operation of setup.operations) {
    selected(plan, operation.module);
    if (operation.selection.module !== operation.module || operation.id !== digestValue({ centralPlanDigest: setup.centralPlanDigest, module: operation.module, selection: operation.selection, beforeDigest: operation.beforeDigest, ownershipIds: operation.ownershipIds })) throw new Error('Operation identity mismatch');
    const old = await journal.get(`${setupDigest}:${operation.id}`);
    if (old && (old.planDigest !== setupDigest || old.operationId !== operation.id || old.state !== 'confirmed')) throw new Error('Uncertain prior write; explicit recovery plan required');
    const state = await provider.inspect(plan, operation.selection, context.signal);
    validateState(plan, operation.selection, state, old?.resourceIds ?? operation.ownershipIds);
    if (digestValue(state) !== (old?.afterDigest ?? operation.beforeDigest)) throw new Error('Product drift requires new review');
  }
  if (options.module !== undefined && !setup.operations.some(op => op.module === Module.parse(options.module))) throw new Error('Current product step is not in approved optional plan');
  for (const operation of setup.operations.filter(op => options.module === undefined || op.module === options.module)) {
    const key = `${setupDigest}:${operation.id}`; const old = await journal.get(key);
    if (old) { records.push(old); continue; }
    const fresh = await guard(); selected(fresh, operation.module);
    const current = await provider.inspect(fresh, operation.selection, context.signal);
    const { owned } = validateState(fresh, operation.selection, current, operation.ownershipIds);
    if (digestValue(current) !== operation.beforeDigest) throw new Error('Product drift before write');
    const record: OptionalProductRecord = { key, planDigest: setupDigest, operationId: operation.id, state: 'possible', resourceIds: owned.map(r => r.id), afterDigest: null };
    await journal.begin(record); records.push(record);
    try {
      const ids = owned.length ? owned.map(r => r.id) : await context.perform(`optional-${operation.module}`, operation.id, async () => {
        // Last check after durable intent and immediately before the single provider write.
        const last = await guard(); selected(last, operation.module);
        const observed = await provider.inspect(last, operation.selection, context.signal);
        validateState(last, operation.selection, observed, operation.ownershipIds);
        if (digestValue(observed) !== operation.beforeDigest) throw new Error('Product drift at dispatch');
        checkApproval(); validateCentral(last, now());
        if (digestValue(await guard()) !== digestValue(last)) throw new Error('Central drift at dispatch');
        return provider.create(last, operation.selection, observed, context.signal);
      });
      ids.forEach(id => Id.parse(id)); record.resourceIds = ids;
      const after = await provider.inspect(fresh, operation.selection, context.signal);
      const checked = validateState(fresh, operation.selection, after, ids);
      if (checked.owned.length !== 1 || digestValue([...checked.owned.map(r => r.id)].sort()) !== digestValue([...ids].sort())) throw new Error('Created resource readback missing or ambiguous');
      // A create must not silently change any foreign resource in the same scope.
      if (digestValue(current.resources.filter(r => !ownedResource(fresh, operation.selection, r))) !== digestValue(after.resources.filter(r => !ownedResource(fresh, operation.selection, r)))) throw new Error('Foreign scope changed during setup');
      record.afterDigest = digestValue(after); record.state = 'confirmed'; await journal.save(record);
      for (const id of ids) context.observeResource(`optional-${operation.module}`, id);
    } catch { record.state = 'possible'; record.afterDigest = null; await journal.save(record); return { status: 'partial', records }; }
  }
  return { status: 'succeeded', records };
}

/** Re-read confirmed resources before publishing runtime IDs. This boundary cannot create or repair resources. */
export async function readConfirmedOptionalResources(options: OptionalProductApplyOptions): Promise<OptionalRuntimeResource[]> {
  const setup = OptionalProductSetupPlanSchema.parse(options.setup); const time = (options.now ?? Date.now)();
  options.context.signal.throwIfAborted();
  const fresh = PlanSchema.parse(await options.revalidate(options.context.signal)); validateCentral(fresh, time);
  const centralDigest = digestValue(fresh); const setupDigest = digestValue(setup); const approval = options.approval;
  if (centralDigest !== setup.centralPlanDigest || centralDigest !== digestValue(options.plan) || centralDigest !== digestValue(options.context.plan) || fresh.mode !== options.provider.mode) throw new Error('Optional runtime plan scope changed');
  if (!approval || approval.planDigest !== setupDigest || approval.centralPlanDigest !== centralDigest || !Number.isFinite(Date.parse(approval.approvedAt)) || Date.parse(approval.approvedAt) < Date.parse(setup.createdAt) || Date.parse(approval.approvedAt) > time || time >= Date.parse(setup.expiresAt)) throw new Error('Fresh exact optional runtime approval required');
  if (new Set(setup.operations.map(operation => operation.module)).size !== setup.operations.length) throw new Error('Duplicate optional runtime operations');
  const expectedModules = fresh.includedModules.filter(module => Module.safeParse(module).success).sort();
  if (digestValue(expectedModules) !== digestValue(setup.operations.map(operation => operation.module).sort())) throw new Error('Optional runtime plan omits selected modules');
  const resources: OptionalRuntimeResource[] = [];
  for (const operation of setup.operations) {
    selected(fresh, operation.module);
    if (operation.selection.module !== operation.module || operation.id !== digestValue({ centralPlanDigest: centralDigest, module: operation.module, selection: operation.selection, beforeDigest: operation.beforeDigest, ownershipIds: operation.ownershipIds })) throw new Error('Optional runtime operation identity mismatch');
    const key = `${setupDigest}:${operation.id}`; const record = await options.journal.get(key);
    if (!record || record.key !== key || record.planDigest !== setupDigest || record.operationId !== operation.id || record.state !== 'confirmed' || !record.afterDigest || !record.resourceIds.length || new Set(record.resourceIds).size !== record.resourceIds.length) throw new Error('Optional runtime confirmation is missing or uncertain');
    const readTime = (options.now ?? Date.now)();
    if (readTime < time || readTime >= Date.parse(setup.expiresAt) || readTime >= Date.parse(fresh.expiresAt)) throw new Error('Optional runtime readback expired');
    const state = await options.provider.inspect(fresh, operation.selection, options.context.signal);
    options.context.signal.throwIfAborted();
    const checked = validateState(fresh, operation.selection, state, record.resourceIds);
    if (digestValue(state) !== record.afterDigest || checked.owned.length !== 1 || digestValue(checked.owned.map(resource => resource.id).sort()) !== digestValue([...record.resourceIds].sort())) throw new Error('Optional runtime readback drift');
    const s = scope(fresh); const resource = checked.owned[0]!;
    const base = { resourceId: resource.id, accountId: s.accountId, zoneId: s.zoneId, labId: s.labId,
      origin: fresh.intent.discovery.environments[1].origin, releaseDigest: fresh.intent.releaseDigest,
      centralPlanDigest: centralDigest, optionalPlanDigest: setupDigest, operationId: operation.id,
      functionalDigest: digestValue(resource), observedAt: new Date(time).toISOString(), mode: fresh.mode };
    const selection = operation.selection;
    if (selection.module === 'api-shield') resources.push(OptionalRuntimeResourceSchema.parse({ ...base, module: selection.module, certificateId: selection.certificateId, ...(selection.certificateSource ? { certificateSource: selection.certificateSource } : {}), certificateRef: selection.certificateRef, fingerprint: selection.fingerprint }));
    else if (selection.module === 'access') {
      const policies = z.array(z.object({ id: Id })).length(1).parse(resource['policies']);
      resources.push(OptionalRuntimeResourceSchema.parse({ ...base, module: selection.module, audience: Hash.parse(resource['aud']), policyId: policies[0]!.id, serviceTokenId: selection.serviceTokenId }));
    } else resources.push(OptionalRuntimeResourceSchema.parse({ ...base, module: selection.module, settings: selection.settings, ...(selection.execution ? { execution: selection.execution } : {}) }));
  }
  const end = (options.now ?? Date.now)();
  if (end < time || end >= Date.parse(setup.expiresAt) || end >= Date.parse(fresh.expiresAt)) throw new Error('Optional runtime readback expired');
  return resources.map(resource => ({ ...resource, observedAt: new Date(end).toISOString() }));
}

/** Hook for LiveSetupExecutor.execute's product-policy branch; no shared-file edits needed here. */
export async function executeOptionalProductSetupStep(step: DeploymentStep, options: OptionalProductApplyOptions): Promise<void> {
  const module = Module.parse(step.module);
  if (step.kind !== 'product-policy' || !options.plan.steps.some(s => s.id === step.id && digestValue(s) === digestValue(step))) throw new Error('Undeclared optional setup step');
  const result = await applyOptionalProductSetup({ ...options, module });
  if (result.status !== 'succeeded') throw new Error('Optional product setup uncertain; stop and review owned recovery inventory');
}

/** Fixed Cloudflare REST contracts bundled with Wrangler 4.157.0. No fake Wrangler commands. */
export type OptionalProductWireRequest =
  | { method: 'GET'; path: `/zones/${string}` | `/zones/${string}/client_certificates/${string}` | `/zones/${string}/certificate_authorities/hostname_associations` | `/zones/${string}/rulesets/phases/http_request_firewall_custom/entrypoint` | `/accounts/${string}/access/apps?per_page=100&page=1` | `/zones/${string}/waiting_rooms?per_page=100&page=1` | `/accounts/${string}/access/apps/${string}/policies?per_page=100&page=1` | `/accounts/${string}/access/service_tokens/${string}` }
  | { method: 'POST'; path: `/zones/${string}/rulesets` | `/zones/${string}/rulesets/${string}/rules` | `/accounts/${string}/access/apps` | `/zones/${string}/waiting_rooms`; body: ReturnType<typeof optionalProductDesired> | { name: string; kind: 'zone'; phase: 'http_request_firewall_custom'; rules: ReturnType<typeof optionalProductDesired>[] } };
export interface OptionalProductWireIO {
  /** Adapter owns auth, exact api.cloudflare.com origin, error redaction, byte/deadline caps and redirect refusal. */
  exchange(request: OptionalProductWireRequest, signal: AbortSignal): Promise<unknown>;
  /** Existing certificate/association readback only. No private keys or certificate uploads. */
  inspectCertificate(plan: DeploymentPlan, selection: Extract<OptionalProductSelection, { module: 'api-shield' }>, signal: AbortSignal): Promise<NonNullable<OptionalProductState['certificate']>>;
}
const Envelope = z.object({ success: z.boolean(), result: z.unknown(), result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional(), total_count: z.number().optional(), cursor: z.string().nullable().optional() }).optional() });
export function createOptionalProductProvider(mode: 'live' | 'fixture', io: OptionalProductWireIO): OptionalProductProvider {
  async function call(request: OptionalProductWireRequest, signal: AbortSignal) {
    signal.throwIfAborted(); const response = Envelope.parse(await io.exchange(request, signal)); signal.throwIfAborted();
    if (!response.success || response.result === null) throw new Error('Optional product API unavailable; no entitlement inferred');
    const page = response.result_info;
    if (request.method === 'GET' && request.path.includes('?per_page=') && (!page || page.page !== 1 || page.total_pages === undefined)) throw new Error('Missing bounded product pages');
    if (page && ((page.page ?? 1) !== 1 || (page.total_pages ?? 1) > 1 || (page.total_count ?? 0) >= 100 || page.cursor)) throw new Error('Incomplete bounded product inventory');
    return response.result;
  }
  return { mode,
    async inspect(plan, selection, signal) {
      const s = scope(plan); const zone = z.object({ id: Id, account: z.object({ id: Id }), name: z.string() }).parse(await call({ method: 'GET', path: `/zones/${s.zoneId}` }, signal));
      if (zone.id !== s.zoneId || zone.account.id !== s.accountId || ![s.beforeHost, s.afterHost].every(host => host.endsWith(`.${zone.name}`))) throw new Error('Provider account, zone or hostname scope mismatch');
      const state: OptionalProductState = { module: selection.module, resources: [], rulesetId: null, certificate: null, serviceTokenId: null };
      if (selection.module === 'api-shield') {
        state.certificate = await io.inspectCertificate(plan, selection, signal);
        // A missing entrypoint is supplied as success/result {id:null,rules:[]}; transport must distinguish 404 from denied reads.
        const result = z.object({ id: Id.nullable(), rules: z.array(z.object({ id: Id, description: z.string().optional() }).passthrough()).max(100) }).parse(await call({ method: 'GET', path: `/zones/${s.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint` }, signal));
        state.rulesetId = result.id; state.resources = result.rules.map(r => ({ ...r, name: r.description ?? r.id }));
      } else if (selection.module === 'access') {
        const token = z.object({ id: Id }).parse(await call({ method: 'GET', path: `/accounts/${s.accountId}/access/service_tokens/${selection.serviceTokenId}` }, signal));
        if (token.id !== selection.serviceTokenId) throw new Error('Service-token identity mismatch'); state.serviceTokenId = token.id;
        state.resources = z.array(Resource).max(100).parse(await call({ method: 'GET', path: `/accounts/${s.accountId}/access/apps?per_page=100&page=1` }, signal));
        for (const resource of state.resources.filter(r => ownedResource(plan, selection, r))) resource['policies'] = await call({ method: 'GET', path: `/accounts/${s.accountId}/access/apps/${Id.parse(resource.id)}/policies?per_page=100&page=1` }, signal);
      } else state.resources = z.array(Resource).max(100).parse(await call({ method: 'GET', path: `/zones/${s.zoneId}/waiting_rooms?per_page=100&page=1` }, signal));
      return StateSchema.parse(state);
    },
    async create(plan, selection, current, signal) {
      const s = scope(plan); const body = optionalProductDesired(plan, selection);
      let request: OptionalProductWireRequest;
      if (selection.module === 'api-shield') request = current.rulesetId ? { method: 'POST', path: `/zones/${s.zoneId}/rulesets/${Id.parse(current.rulesetId)}/rules`, body } :
        { method: 'POST', path: `/zones/${s.zoneId}/rulesets`, body: { name: `${s.labId}-security-demos`, kind: 'zone', phase: 'http_request_firewall_custom', rules: [body] } };
      else request = { method: 'POST', path: selection.module === 'access' ? `/accounts/${s.accountId}/access/apps` : `/zones/${s.zoneId}/waiting_rooms`, body };
      const result = await call(request, signal);
      if (selection.module === 'api-shield') {
        const ruleset = z.object({ id: Id, rules: z.array(z.object({ id: Id, ref: z.string().optional() })).max(100) }).parse(result);
        const rules = ruleset.rules.filter(r => r.ref === name(plan, selection.module));
        if (rules.length !== 1) throw new Error('mTLS rule identity unresolved'); return [rules[0]!.id];
      }
      return [z.object({ id: Id }).parse(result).id];
    },
  };
}
