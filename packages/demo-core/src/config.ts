import { z } from 'zod';
import { isIP } from 'node:net';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Digest, Role, TurnstileConfigSchema } from '../../contracts/src/schemas.js';
import { ApiShieldPolicySchema } from './api-shield.js';
import { AccessPolicySchema } from './access-policy.js';
import { WaitingRoomSettingsSchema, WaitingRoomExecutionSchema } from './waiting-room.js';
import { DdosSelectionSchema } from './ddos-evidence.js';
import { ImageVariantSelectionSchema } from './image-variant-selection.js';

const ResourceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
const CloudflareId = z.string().regex(/^[a-f0-9]{32}$/);
const SecretReference = z.string().regex(/^env:[A-Z][A-Z0-9_]{2,100}$/);
export function labOrigin(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || u.pathname !== '/') throw new Error('Exact HTTPS origin required');
  if (isIP(u.hostname) || u.hostname.includes(':') || !/^[a-z0-9.-]+$/.test(u.hostname) || !u.hostname.includes('.') || u.hostname.endsWith('.') || u.hostname.includes('..') || u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) throw new Error('Public lab DNS hostname required');
  return u.origin;
}
const Origin = z.string().superRefine((v, ctx) => {
  try { labOrigin(v); } catch { ctx.addIssue({ code: 'custom', message: 'Invalid lab HTTPS origin' }); }
});
const Environment = z.strictObject({
  role: Role, origin: Origin, workerName: ResourceId, containerBinding: ResourceId,
  d1Id: z.uuid(), r2Bucket: ResourceId, imageIds: z.array(ResourceId).min(1).max(50), releaseDigest: Digest,
});
const InventoryItem = z.strictObject({ type: z.enum(['worker', 'container', 'd1', 'r2', 'image', 'policy', 'telemetry']), id: ResourceId, role: Role, labId: ResourceId });
const OptionalRuntimeBase = z.object({
  resourceId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
  accountId: CloudflareId, zoneId: CloudflareId, labId: ResourceId, origin: Origin,
  releaseDigest: Digest, centralPlanDigest: Digest, optionalPlanDigest: Digest,
  operationId: Digest, functionalDigest: Digest, observedAt: z.iso.datetime(), mode: z.enum(['live', 'fixture']),
});
export const OptionalRuntimeResourceSchema = z.discriminatedUnion('module', [
  OptionalRuntimeBase.extend({ module: z.literal('api-shield'), resourceId: CloudflareId, certificateId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
    certificateSource: z.literal('zone-managed').optional(), certificateRef: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/), fingerprint: Digest }).strict(),
  OptionalRuntimeBase.extend({ module: z.literal('access'), audience: Digest,
    policyId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/),
    serviceTokenId: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/) }).strict(),
  OptionalRuntimeBase.extend({ module: z.literal('waiting-room'), resourceId: CloudflareId, settings: z.lazy(() => WaitingRoomSettingsSchema), execution: z.lazy(() => WaitingRoomExecutionSchema).optional() }).strict(),
]);
export type OptionalRuntimeResource = z.infer<typeof OptionalRuntimeResourceSchema>;
export const LabConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal('synthetic-lab'), ownedLab: z.literal(true), labId: ResourceId,
  accountId: CloudflareId, zoneId: CloudflareId,
  environments: z.tuple([Environment.extend({ role: z.literal('before') }), Environment.extend({ role: z.literal('after') })]),
  telemetryOrigin: Origin, apiOrigin: z.literal('https://api.cloudflare.com'),
  imageOrigins: z.array(Origin).min(1).max(2), imageVariant: ImageVariantSelectionSchema.optional(), rateLimitRuleId: CloudflareId.optional(),
  optionalResources: z.array(OptionalRuntimeResourceSchema).max(3).optional(),
  credentials: z.strictObject({ reader: SecretReference, collector: SecretReference, deployer: SecretReference.optional(), runner: SecretReference.optional(), setup: SecretReference.optional(), allowBroadApiToken: z.boolean().optional(), accessReaderTokenKind: z.enum(['user', 'account']).optional() }),
  inventory: z.array(InventoryItem).min(1).max(500), evidenceDirectory: z.string().min(1), liveOptIn: z.boolean(),
  demonstrations: z.strictObject({
    turnstile: z.strictObject({ expectedAfter: TurnstileConfigSchema, positiveTokenRef: SecretReference.optional() }).optional(),
    apiShield: z.lazy(() => ApiShieldPolicySchema).optional(), access: z.lazy(() => AccessPolicySchema).optional(),
    waitingRoom: z.strictObject({ id: CloudflareId, settings: z.lazy(() => WaitingRoomSettingsSchema), expectedTransitionMs: z.number().int().positive().max(110000), perNavigationRequests: z.number().int().min(1).max(10), refreshes: z.number().int().min(1).max(8), queueSelector: z.string().min(1).max(256), storefrontSelector: z.string().min(1).max(256), queueContractQualified: z.boolean() }).optional(),
    ddos: z.lazy(() => DdosSelectionSchema).optional(), analyticsRunId: z.uuid().optional(),
    certificates: z.array(z.strictObject({ ref: z.string().regex(/^certificate:lab-[a-z0-9-]{1,60}$/), certificateRef: SecretReference, privateKeyRef: SecretReference })).max(2).optional(),
    serviceToken: z.strictObject({ ref: z.string().regex(/^service-token:lab-[a-z0-9-]{1,60}$/), id: z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).optional(), clientIdRef: SecretReference, clientSecretRef: SecretReference }).optional(),
    accessIdentity: z.strictObject({ issuer: z.string().regex(/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/), source: z.literal('verified-rs256-service-jwt') }).optional(),
  }).optional(),
}).superRefine((v, ctx) => {
  const [before, after] = v.environments;
  if (v.rateLimitRuleId && !v.inventory.some(i => i.type === 'policy' && i.role === 'after' && i.id === v.rateLimitRuleId)) ctx.addIssue({ code: 'custom', message: 'Rate rule must belong to the After inventory' });
  for (const field of ['origin', 'workerName', 'containerBinding', 'd1Id', 'r2Bucket'] as const) if (before[field] === after[field]) ctx.addIssue({ code: 'custom', message: `Separate ${field} required` });
  if (before.releaseDigest !== after.releaseDigest) ctx.addIssue({ code: 'custom', message: 'Release parity required' });
  if (v.telemetryOrigin === before.origin || v.telemetryOrigin === after.origin) ctx.addIssue({ code: 'custom', message: 'Separate telemetry origin required' });
  const optionalModules = new Set<string>();
  for (const resource of v.optionalResources ?? []) {
    if (optionalModules.has(resource.module)) ctx.addIssue({ code: 'custom', message: 'Duplicate optional runtime module' });
    optionalModules.add(resource.module);
    if (resource.accountId !== v.accountId || resource.zoneId !== v.zoneId || resource.labId !== v.labId || resource.origin !== after.origin || resource.releaseDigest !== after.releaseDigest) ctx.addIssue({ code: 'custom', message: 'Optional runtime resource scope differs from the lab' });
    if (resource.module === 'waiting-room' && resource.settings.hostname !== new URL(after.origin).hostname) ctx.addIssue({ code: 'custom', message: 'Optional room hostname differs from the After host' });
  }
  const keys = new Set<string>();
  for (const item of v.inventory) {
    if (item.labId !== v.labId) ctx.addIssue({ code: 'custom', message: 'Resource belongs to another lab' });
    const key = `${item.type}:${item.role}:${item.id}`;
    if (keys.has(key)) ctx.addIssue({ code: 'custom', message: 'Duplicate ownership record' });
    keys.add(key);
  }
  for (const env of v.environments) {
    const required = [['worker', env.workerName], ['container', env.containerBinding], ['d1', env.d1Id], ['r2', env.r2Bucket], ...env.imageIds.map(id => ['image', id])] as const;
    for (const [type, id] of required) if (!keys.has(`${type}:${env.role}:${id}`)) ctx.addIssue({ code: 'custom', message: 'Binding missing from ownership inventory' });
  }
});
export type LabConfig = z.infer<typeof LabConfigSchema>;

// Fresh-checkout discovery has no deployed IDs yet. It cannot authorize storefront traffic.
export const DiscoveryConfigSchema = z.strictObject({
  schemaVersion: z.literal(1), purpose: z.literal('synthetic-lab'), ownedLab: z.literal(true), labId: ResourceId,
  accountId: CloudflareId, zoneId: CloudflareId,
  environments: z.tuple([
    z.strictObject({ role: z.literal('before'), origin: Origin }),
    z.strictObject({ role: z.literal('after'), origin: Origin }),
  ]),
  telemetryOrigin: Origin, apiOrigin: z.literal('https://api.cloudflare.com'),
  imageOrigins: z.array(Origin).max(2), imageVariant: ImageVariantSelectionSchema.optional(),
  credentials: z.strictObject({ reader: SecretReference, collector: SecretReference, deployer: SecretReference.optional(), runner: SecretReference.optional(), setup: SecretReference.optional(), apiTokenMode: z.enum(['separate', 'shared']).optional(), allowBroadApiToken: z.boolean().optional() }),
  evidenceDirectory: z.string().min(1), liveOptIn: z.boolean(),
}).superRefine((v, ctx) => {
  const origins = [...v.environments.map(e => labOrigin(e.origin)), labOrigin(v.telemetryOrigin)];
  if (new Set(origins).size !== 3) ctx.addIssue({ code: 'custom', message: 'Separate lab origins required' });
});
export type DiscoveryConfig = z.infer<typeof DiscoveryConfigSchema>;
export type TargetConfig = LabConfig | DiscoveryConfig;
export function validateDiscoveryConfig(input: unknown, projectRoot: string): TargetConfig {
  if (typeof input === 'object' && input !== null && 'inventory' in input) return validateLabConfig(input, projectRoot);
  const config = DiscoveryConfigSchema.parse(input);
  validateEvidenceDirectory(config.evidenceDirectory, projectRoot);
  return config;
}

// The trusted caller supplies the checkout root; config cannot widen the output root.
export function validateEvidenceDirectory(directory: string, projectRoot: string): string {
  if (!isAbsolute(projectRoot) || !isAbsolute(directory)) throw new Error('Absolute paths required');
  const root = resolve(projectRoot, '.evidence');
  const target = resolve(directory);
  const rel = relative(root, target);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Evidence must stay within the ignored checkout evidence directory');
  let cursor = resolve(projectRoot);
  if (!existsSync(cursor) || realpathSync(cursor) !== cursor) throw new Error('Trusted project root must be canonical');
  for (const part of relative(cursor, target).split(sep)) {
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink output path rejected');
    if (existsSync(cursor) && !lstatSync(cursor).isDirectory()) throw new Error('Output path is not a directory');
  }
  return target;
}
export function validateLabConfig(input: unknown, projectRoot: string): LabConfig {
  const config = LabConfigSchema.parse(input);
  validateEvidenceDirectory(config.evidenceDirectory, projectRoot);
  return config;
}
export type TargetKind = 'before' | 'after' | 'telemetry' | 'cloudflare' | 'image';
export function validateTarget(config: TargetConfig, value: string, kind: TargetKind): URL {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) throw new Error('Unsafe request URL');
  const allowed = kind === 'image' ? config.imageOrigins.map(labOrigin)
    : kind === 'telemetry' ? [labOrigin(config.telemetryOrigin)]
    : kind === 'cloudflare' ? [config.apiOrigin]
    : config.environments.filter(e => e.role === kind).map(e => labOrigin(e.origin));
  if (!allowed.includes(u.origin)) throw new Error('Target is not allowlisted for this role');
  if (/%(?:2f|5c|00|0d|0a)/i.test(u.pathname) || u.pathname.includes('\\')) throw new Error('Ambiguous request path');
  for (const key of u.searchParams.keys()) if (/token|secret|password|credential|assertion|cookie/i.test(key)) throw new Error('Credentials forbidden in URL');
  return u;
}
export function validateRedirect(config: TargetConfig, from: string, to: string, kind: TargetKind, headers: Readonly<Record<string, string>>, enabled = false): URL {
  if (!enabled) throw new Error('Redirects are disabled');
  const source = validateTarget(config, from, kind);
  const destination = validateTarget(config, new URL(to, source).href, kind);
  if (source.origin !== destination.origin && Object.keys(headers).some(h => /authorization|cookie|token|key|secret/i.test(h))) throw new Error('Cross-origin credential forwarding rejected');
  return destination;
}
export function assertLiveReady(config: LabConfig, observedOwnedResources: ReadonlySet<string>): void {
  if (!config.liveOptIn) throw new Error('Explicit live opt-in required');
  for (const item of config.inventory) if (!observedOwnedResources.has(`${item.type}:${item.role}:${item.id}`)) throw new Error('Live resource ownership is unverified');
}
