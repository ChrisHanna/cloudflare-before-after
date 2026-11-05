import { z } from 'zod';
import { assertCredentialSeparation } from './credential-policy.js';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, existsSync, opendirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { validateEvidenceDirectory, validateLabConfig, labOrigin, type OptionalRuntimeResource } from './config.js';
import { DeploymentStore, ApplyRecordSchema } from './deployment-store.js';
import { OptionalProductRecordSchema } from './optional-product-setup-store.js';
import { PlanSchema, digestValue, PLAN_LIFETIME_MS, type DeploymentPlan } from './deployment-plan.js';
import { boundedBytes } from './deployment-http.js';
import type { Dispatch } from './transport.js';
import { WaitingRoomSettingsSchema, WaitingRoomExecutionSchema } from './waiting-room.js';
import { createOptionalProductProvider, OptionalProductSetupPlanSchema, type OptionalProductSetupPlan, type OptionalProductApproval, type OptionalProductProvider, type OptionalProductSelection, type OptionalProductModule, type OptionalProductWireIO } from './optional-product-setup.js';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Approval = z.strictObject({ planDigest: Hash, centralPlanDigest: Hash, approvedAt: z.iso.datetime() });
/** The CLI stores only public resource IDs and functional settings. */
export const OptionalSelectionsSchema = z.array(z.discriminatedUnion('module', [
  z.strictObject({ module: z.literal('api-shield'), certificateId: z.string().regex(/^[a-f0-9]{32}$/), certificateSource: z.literal('zone-managed').optional(), certificateRef: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/), fingerprint: Hash }),
  z.strictObject({ module: z.literal('access'), serviceTokenId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/) }),
  z.strictObject({ module: z.literal('waiting-room'), settings: WaitingRoomSettingsSchema.extend({ path: z.literal('/launch') }), execution: WaitingRoomExecutionSchema.optional() }),
])).min(1).max(3);
function readBounded(path: string, maximumBytes = 65536): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > maximumBytes) throw new Error('Invalid bounded optional plan file'); return JSON.parse(readFileSync(fd, 'utf8')); }
  finally { closeSync(fd); }
}
function exclusive(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
}
export function loadOptionalSelections(path: string): OptionalProductSelection[] { return OptionalSelectionsSchema.parse(readBounded(path)); }
export function saveOptionalSetup(root: string, centralPath: string, setup: OptionalProductSetupPlan): string {
  validateEvidenceDirectory(dirname(centralPath), root);
  const parsed = OptionalProductSetupPlanSchema.parse(setup);
  const path = join(dirname(centralPath), `${digestValue(parsed)}.optional.json`);
  exclusive(path, parsed); return path;
}
export function loadOptionalSetup(root: string, path: string, plan: DeploymentPlan): OptionalProductSetupPlan {
  validateEvidenceDirectory(dirname(path), root);
  const setup = OptionalProductSetupPlanSchema.parse(readBounded(path));
  if (setup.centralPlanDigest !== digestValue(plan)) throw new Error('Optional setup belongs to a different immutable central plan');
  const expected = plan.steps.filter(s => s.kind === 'product-policy' && ['api-shield', 'access', 'waiting-room'].includes(s.module)).map(s => s.module).sort();
  if (digestValue(expected) !== digestValue(setup.operations.map(op => op.module).sort())) throw new Error('Optional setup does not cover the exact selected modules');
  return setup;
}
export function approveOptionalSetup(root: string, path: string, plan: DeploymentPlan, confirmation: string, tty: boolean, now: number): OptionalProductApproval {
  const setup = loadOptionalSetup(root, path, plan); const planDigest = digestValue(setup);
  if (!tty || confirmation !== `APPROVE OPTIONAL ${planDigest}` || now < Date.parse(setup.createdAt) || now >= Date.parse(setup.expiresAt)) throw new Error('Fresh exact interactive optional approval required');
  const approval = Approval.parse({ planDigest, centralPlanDigest: setup.centralPlanDigest, approvedAt: new Date(now).toISOString() });
  exclusive(`${path}.approval.json`, approval); return approval;
}
export function loadOptionalApproval(root: string, path: string, plan: DeploymentPlan, now: number): OptionalProductApproval {
  const setup = loadOptionalSetup(root, path, plan); const a = Approval.parse(readBounded(`${path}.approval.json`));
  if (a.planDigest !== digestValue(setup) || a.centralPlanDigest !== digestValue(plan) || Date.parse(a.approvedAt) < Date.parse(setup.createdAt) || Date.parse(a.approvedAt) > now || now - Date.parse(a.approvedAt) > PLAN_LIFETIME_MS || now >= Date.parse(setup.expiresAt)) throw new Error('Optional approval expired or changed');
  return a;
}
/** Historical IDs are hints for fresh provider checks, never a new deployment approval. */
export function loadPriorOptionalOwnership(root: string, input: DeploymentPlan, now = Date.now()): Partial<Record<OptionalProductModule, readonly string[]>> {
  if (!Number.isFinite(now)) throw new Error('Current ownership time is required');
  const plan = PlanSchema.parse(input); const target = plan.intent.discovery;
  const directory = join(validateEvidenceDirectory(target.evidenceDirectory, root), 'deployment', 'runtime');
  validateEvidenceDirectory(directory, root);
  if (!existsSync(directory)) return {};
  const entries: string[] = []; const handle = opendirSync(directory);
  try {
    let entry; let count = 0;
    while ((entry = handle.readSync()) !== null) {
      if (++count > 100) throw new Error('Prior deployment history exceeds the bounded ownership scan');
      if (z.uuid().safeParse(entry.name).success) entries.push(entry.name);
    }
  } finally { handle.closeSync(); }
  const store = new DeploymentStore(root, target.evidenceDirectory);
  const histories: { completedAt: string; resources: OptionalRuntimeResource[] }[] = [];
  const Marker = z.object({ schemaVersion: z.literal(1), labId: z.string(), sourceDigest: Hash, releaseDigest: Hash,
    completedAt: z.iso.datetime(), claims: z.object({ coreDeployed: z.literal(true) }) });
  for (const id of entries) {
    const path = join(directory, id); validateEvidenceDirectory(path, root);
    const configPath = join(path, 'runtime-config.json'); const markerPath = join(path, 'deployment.json');
    if (!existsSync(configPath) || !existsSync(markerPath)) continue;
    const runtime = validateLabConfig(readBounded(configPath, 256000), root);
    if (!runtime.optionalResources?.length) continue;
    // Ignore a different lab, account, zone, or target. It cannot grant an ID.
    if (runtime.labId !== target.labId || runtime.accountId !== target.accountId || runtime.zoneId !== target.zoneId
      || runtime.environments[1].origin !== target.environments[1].origin) continue;
    if (runtime.evidenceDirectory !== target.evidenceDirectory) throw new Error('Prior optional output scope changed');
    const marker = Marker.parse(readBounded(markerPath));
    const saved = store.load(join(store.directory, `${id}.plan.json`)); const previous = saved.plan;
    const attempt = ApplyRecordSchema.parse(readBounded(join(store.directory, `${id}.attempt.json`), 2 * 1024 * 1024));
    if (previous.mode !== plan.mode) continue;
    if (previous.id !== id || previous.intent.discovery.labId !== runtime.labId || previous.intent.discovery.accountId !== runtime.accountId
      || previous.intent.discovery.zoneId !== runtime.zoneId || previous.intent.discovery.evidenceDirectory !== runtime.evidenceDirectory
      || previous.intent.discovery.environments[1].origin !== runtime.environments[1].origin || marker.labId !== runtime.labId
      || marker.sourceDigest !== previous.sourceDigest || marker.releaseDigest !== previous.intent.releaseDigest
      || runtime.environments[1].releaseDigest !== marker.releaseDigest) throw new Error('Prior optional deployment lineage differs');
    if (attempt.planId !== id || attempt.planDigest !== saved.digest || attempt.status !== 'succeeded' || !attempt.finishedAt
      || Date.parse(attempt.startedAt) < Date.parse(previous.createdAt) || Date.parse(attempt.startedAt) >= Date.parse(previous.expiresAt)
      || Date.parse(attempt.finishedAt) > now || Date.parse(marker.completedAt) < Date.parse(attempt.startedAt)
      || Date.parse(marker.completedAt) > Date.parse(attempt.finishedAt) || !previous.steps.every(step => attempt.completedSteps.includes(step.id))) throw new Error('Prior optional deployment is not confirmed complete');
    // Check the old approvals at their real execution time, not as fresh authority.
    store.approval(previous, saved.digest, Date.parse(attempt.startedAt));
    for (const resource of runtime.optionalResources) {
      if (resource.mode !== previous.mode || resource.centralPlanDigest !== saved.digest || Date.parse(resource.observedAt) > Date.parse(marker.completedAt)) throw new Error('Prior optional runtime provenance differs');
      const setupPath = join(store.directory, `${resource.optionalPlanDigest}.optional.json`);
      const setup = loadOptionalSetup(root, setupPath, previous);
      loadOptionalApproval(root, setupPath, previous, Date.parse(attempt.startedAt));
      if (digestValue(setup) !== resource.optionalPlanDigest || !setup.operations.some(operation => operation.module === resource.module && operation.id === resource.operationId)
        || !attempt.resources.some(item => item.kind === `optional-${resource.module}` && item.id === resource.resourceId && item.certainty === 'confirmed')) throw new Error('Prior optional resource is not in the completed plan');
      const key = `${resource.optionalPlanDigest}:${resource.operationId}`;
      const journalDirectory = join(target.evidenceDirectory, 'deployment', 'optional-products'); validateEvidenceDirectory(journalDirectory, root);
      const record = OptionalProductRecordSchema.parse(readBounded(join(journalDirectory, `${key.replace(':', '-')}.json`), 4096));
      if (record.key !== key || record.state !== 'confirmed' || !record.resourceIds.includes(resource.resourceId)) throw new Error('Prior optional journal is missing or uncertain');
    }
    histories.push({ completedAt: marker.completedAt, resources: runtime.optionalResources });
  }
  histories.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const owned: Partial<Record<OptionalProductModule, readonly string[]>> = {}; const times = new Map<OptionalProductModule, string>();
  for (const history of histories) for (const resource of history.resources) {
    if (times.get(resource.module) === history.completedAt && owned[resource.module]?.[0] !== resource.resourceId) throw new Error('Ambiguous prior optional resource identity');
    if (!owned[resource.module]) { owned[resource.module] = [resource.resourceId]; times.set(resource.module, history.completedAt); }
  }
  return owned;
}

/** Fixed provider endpoints only; caller cannot choose an origin or credentials.
 * Unsupported certificate association facts remain unknown, never inferred.
 */
export function defaultOptionalProvider(plan: DeploymentPlan, credentials: { reader: string; deployer: string }, dispatch: Dispatch = fetch): OptionalProductProvider {
  plan = PlanSchema.parse(plan); credentials = Object.freeze({ ...credentials });
  const centralDigest = digestValue(plan);
  if (plan.mode !== 'live' || !plan.intent.discovery.liveOptIn) throw new Error('Explicit live optional setup required');
  if (credentials.reader.length < 24 || credentials.deployer.length < 24) throw new Error('Resolved API credentials required');
  assertCredentialSeparation(credentials, plan.intent.discovery.credentials.apiTokenMode === 'shared');
  const { accountId, zoneId, apiOrigin } = plan.intent.discovery;
  if (apiOrigin !== 'https://api.cloudflare.com') throw new Error('Exact provider origin required');
  let requests = 0;
  const deadline = Math.min(Date.parse(plan.expiresAt), Date.now() + plan.intent.setup.maxRuntimeMs);
  const exchange: OptionalProductWireIO['exchange'] = async (request, signal) => {
      signal.throwIfAborted(); if (++requests > 100 || Date.now() >= deadline) throw new Error('Optional setup read/write allowance exhausted');
      const path = request.path;
      const account = `/accounts/${accountId}/access/`; const zone = `/zones/${zoneId}`;
      if (!(path.startsWith(account) || path === zone || path.startsWith(`${zone}/`)) || /[%#\\]/.test(path)) throw new Error('Foreign optional provider scope');
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(120000, deadline - Date.now())));
      const effective = AbortSignal.any([signal, timeout]);
      const response = await dispatch(`${apiOrigin}/client/v4${path}`, { method: request.method, redirect: 'error', signal: effective,
        headers: { authorization: `Bearer ${request.method === 'GET' ? credentials.reader : credentials.deployer}`, ...(request.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
        ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {}) });
      const bytes = await boundedBytes(response, 65536, effective);
      if (response.status === 404 && request.method === 'GET' && path === `${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`) return { success: true, result: { id: null, rules: [] } };
      if (!response.ok) throw new Error('Optional provider request unavailable; no entitlement inferred');
      return JSON.parse(new TextDecoder().decode(bytes));
  };
  const provider = createOptionalProductProvider('live', {
    exchange,
    inspectCertificate: async (_current, selection, signal) => {
      // A client certificate ID and an uploaded account CA ID are not the same
      // resource. Never guess which one the operator intended.
      if (selection.certificateSource !== 'zone-managed') throw new Error('Explicit zone-managed client certificate source required; custom CA contracts remain unqualified');
      const certificateId = z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).parse(selection.certificateId);
      async function read<S extends z.ZodType>(path: Extract<Parameters<typeof exchange>[0], { method: 'GET' }>['path'], schema: S): Promise<z.infer<S>> {
        const envelope = z.object({ success: z.literal(true), result: schema,
          result_info: z.object({ page: z.number().optional(), total_pages: z.number().optional(), total_count: z.number().optional(), cursor: z.string().nullable().optional() }).optional() }).parse(await exchange({ method: 'GET', path }, signal));
        const page = envelope.result_info;
        if (page && ((page.page ?? 1) !== 1 || (page.total_pages ?? 1) > 1 || (page.total_count ?? 0) >= 100 || page.cursor)) throw new Error('Incomplete certificate or hostname readback');
        return schema.parse(Reflect.get(envelope, 'result'));
      }
      const certificate = await read(`/zones/${zoneId}/client_certificates/${certificateId}`, z.object({
        id: z.string(), status: z.literal('active'), issued_on: z.iso.datetime(), expires_on: z.iso.datetime(),
        fingerprint_sha256: z.string().regex(/^[a-f0-9]{64}$|^(?:[a-f0-9]{2}:){31}[a-f0-9]{2}$/i).transform(value => value.replaceAll(':', '').toLowerCase()),
      }));
      const time = Date.now();
      if (certificate.id !== certificateId || certificate.fingerprint_sha256 !== selection.fingerprint || Date.parse(certificate.issued_on) > time || Date.parse(certificate.expires_on) <= time) throw new Error('Client certificate identity, fingerprint or validity differs');
      const associations = await read(`/zones/${zoneId}/certificate_authorities/hostname_associations`, z.object({ hostnames: z.array(z.string().max(253)).max(100) }));
      const before = new URL(plan.intent.discovery.environments[0].origin).hostname; const after = new URL(plan.intent.discovery.environments[1].origin).hostname;
      if (associations.hostnames.length >= 100 || new Set(associations.hostnames).size !== associations.hostnames.length
        || associations.hostnames.some(hostname => labOrigin(`https://${hostname}`) !== `https://${hostname}`)
        || associations.hostnames.includes(before) || associations.hostnames.filter(hostname => hostname === after).length !== 1) throw new Error('Managed CA hostname association is missing, ambiguous or includes the baseline');
      if (Date.now() >= deadline || Date.parse(certificate.expires_on) <= Date.now()) throw new Error('Certificate readback expired');
      signal.throwIfAborted();
      return { id: certificate.id, fingerprint: certificate.fingerprint_sha256, hostname: associations.hostnames.find(hostname => hostname === after)!, ready: true };
    },
  });
  const samePlan = (current: DeploymentPlan) => { if (digestValue(current) !== centralDigest) throw new Error('Foreign immutable provider plan'); };
  return Object.freeze<OptionalProductProvider>({ mode: provider.mode,
    inspect: (current, selection, signal) => { samePlan(current); return provider.inspect(current, selection, signal); },
    create: (current, selection, state, signal) => { samePlan(current); return provider.create(current, selection, state, signal); },
  });
}
