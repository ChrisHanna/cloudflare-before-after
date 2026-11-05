import { z } from 'zod';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LabConfigSchema, OptionalRuntimeResourceSchema, validateLabConfig, validateEvidenceDirectory, type LabConfig, type OptionalRuntimeResource } from './config.js';
import { CoreInventorySchema, assertInventoryImageVariant, type CoreInventory } from './infrastructure.js';
import type { DeploymentIntent } from './deployment-plan.js';
import { TEST_SITEKEY } from '../../contracts/src/turnstile-test.js';
export function deployedRuntimeConfig(intent: DeploymentIntent, input: CoreInventory, customRuleId?: string, additionalRuleIds: readonly string[] = [], rateLimitRuleId?: string, optionalResources: readonly OptionalRuntimeResource[] = [], turnstileSitekey?: string): LabConfig {
  const core = CoreInventorySchema.parse(input);
  if (core.lab_id !== intent.discovery.labId || core.account_id !== intent.discovery.accountId) throw new Error('Runtime inventory scope differs from approved intent');
  assertInventoryImageVariant(core, intent.discovery.imageVariant);
  const environments = (['before', 'after'] as const).map(role => ({ role, origin: intent.discovery.environments.find(e => e.role === role)!.origin, workerName: core.environments[role].worker_name, containerBinding: core.environments[role].container_name, d1Id: core.environments[role].database_id, r2Bucket: core.environments[role].bucket_name, imageIds: [core.environments[role].image_id], releaseDigest: intent.releaseDigest }));
  const inventory: LabConfig['inventory'] = environments.flatMap(e => [
    { type: 'worker' as const, id: e.workerName, role: e.role, labId: core.lab_id },
    { type: 'container' as const, id: e.containerBinding, role: e.role, labId: core.lab_id },
    { type: 'd1' as const, id: e.d1Id, role: e.role, labId: core.lab_id },
    { type: 'r2' as const, id: e.r2Bucket, role: e.role, labId: core.lab_id },
    { type: 'image' as const, id: e.imageIds[0]!, role: e.role, labId: core.lab_id },
    { type: 'telemetry' as const, id: `${core.lab_id}-telemetry`, role: e.role, labId: core.lab_id },
  ]);
  for (const id of new Set([...(customRuleId ? [customRuleId] : []), ...additionalRuleIds])) inventory.push({ type: 'policy', id: z.string().regex(/^[a-f0-9]{32}$/).parse(id), role: 'after', labId: core.lab_id });
  const confirmed = optionalResources.map(resource => OptionalRuntimeResourceSchema.parse(resource));
  const demonstrations: NonNullable<LabConfig['demonstrations']> = {};
  for (const resource of confirmed) {
    const pair = { beforeOrigin: environments[0]!.origin, afterOrigin: environments[1]!.origin,
      capability: 'available' as const, enabled: true, baselineExcluded: true };
    if (resource.module === 'api-shield') demonstrations.apiShield = { ...pair, policyId: resource.resourceId, path: '/api',
      authorizedCertificate: { ref: resource.certificateRef, hostname: new URL(resource.origin).hostname, fingerprint: resource.fingerprint }, invalidCertificateRef: null };
    if (resource.module === 'access') demonstrations.access = { ...pair, applicationId: resource.resourceId,
      policyId: resource.policyId, audience: resource.audience, path: '/admin', serviceTokenRef: null };
    if (resource.module === 'waiting-room' && resource.execution) {
      const execution = resource.execution;
      demonstrations.waitingRoom = { id: resource.resourceId, settings: resource.settings,
        expectedTransitionMs: execution.expectedTransitionMs, perNavigationRequests: execution.perNavigationRequests,
        refreshes: execution.refreshes, queueSelector: execution.queueSelector, storefrontSelector: execution.storefrontSelector,
        // This flag qualifies synthetic fixture selectors only. Live observations
        // still require the browser's privately branded documented JSON signal.
        queueContractQualified: resource.mode === 'fixture' };
    }
    // Timing and credentials are never inferred from resource existence alone.
  }
  if (intent.turnstile) demonstrations.turnstile = { expectedAfter: { mode: intent.turnstile.mode, sitekey: intent.turnstile.mode === 'live' ? turnstileSitekey ?? null : TEST_SITEKEY, hostname: new URL(environments[1]!.origin).hostname, action: 'register' } };
  // Runtime users never need deployment or setup-master references.
  return LabConfigSchema.parse({ ...intent.discovery, ...(confirmed.length ? { optionalResources: confirmed } : {}),
    ...(Object.keys(demonstrations).length ? { demonstrations } : {}), credentials: { reader: intent.discovery.credentials.reader, collector: intent.discovery.credentials.collector, ...(intent.discovery.credentials.runner ? { runner: intent.discovery.credentials.runner } : {}) }, imageOrigins: ['https://imagedelivery.net'], ...(rateLimitRuleId ? { rateLimitRuleId } : {}), environments, inventory });
}
function readConfig(path: string, root: string): LabConfig {
  if (!isAbsolute(path)) throw new Error('Absolute runtime configuration path required');
  const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) throw new Error('Invalid bounded runtime configuration');
  return validateLabConfig(JSON.parse(readFileSync(path, 'utf8')), root);
}
export function loadRuntimeConfig(projectRoot: string, explicit?: string): LabConfig {
  if (explicit) return readConfig(explicit, projectRoot);
  const local = join(projectRoot, '.lab/runtime.json');
  if (existsSync(local)) return readConfig(local, projectRoot);
  const directory = join(projectRoot, '.evidence/deployment/runtime');
  validateEvidenceDirectory(directory, projectRoot);
  if (!existsSync(directory)) throw new Error('Deploy an approved lab or provide an explicit runtime config');
  const candidates = readdirSync(directory).filter(name => z.uuid().safeParse(name).success);
  if (candidates.length > 100) throw new Error('Select an explicit runtime config; deployment history exceeds discovery cap');
  const successful: { config: LabConfig; completedAt: string }[] = [];
  for (const name of candidates) {
    const path = join(directory, name); validateEvidenceDirectory(path, projectRoot);
    const config = join(path, 'runtime-config.json'); const marker = join(path, 'deployment.json');
    if (!existsSync(config) || !existsSync(marker)) continue;
    const stat = lstatSync(marker); if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 65536) throw new Error('Invalid deployment marker');
    const complete = z.object({ completedAt: z.iso.datetime(), claims: z.object({ coreDeployed: z.literal(true) }) }).parse(JSON.parse(readFileSync(marker, 'utf8')));
    successful.push({ config: readConfig(config, projectRoot), completedAt: complete.completedAt });
  }
  if (!successful.length) throw new Error('No successfully deployed runtime configuration found');
  if (new Set(successful.map(s => `${s.config.accountId}:${s.config.zoneId}:${s.config.labId}`)).size !== 1) throw new Error('Multiple labs exist; choose an explicit runtime configuration');
  successful.sort((a, b) => b.completedAt.localeCompare(a.completedAt)); return successful[0]!.config;
}
