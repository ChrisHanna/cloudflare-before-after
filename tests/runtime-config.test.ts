import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deployedRuntimeConfig, loadRuntimeConfig } from '../packages/demo-core/src/runtime-config.js';
import { deploymentIntent } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
import type { OptionalRuntimeResource } from '../packages/demo-core/src/config.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'runtime-config-')); roots.push(root);
  const intent = deploymentIntent(root); const inventory = infrastructureFixture().inventory; intent.discovery.labId = inventory.lab_id;
  return { root, intent, inventory, config: deployedRuntimeConfig(intent, inventory, 'c'.repeat(32)) };
}
function optionalResources(f: ReturnType<typeof fixture>): OptionalRuntimeResource[] {
  const base = { accountId: f.config.accountId, zoneId: f.config.zoneId, labId: f.config.labId,
    origin: f.config.environments[1].origin, releaseDigest: f.intent.releaseDigest,
    centralPlanDigest: 'a'.repeat(64), optionalPlanDigest: 'b'.repeat(64), operationId: 'c'.repeat(64),
    functionalDigest: 'd'.repeat(64), observedAt: new Date().toISOString(), mode: 'fixture' as const };
  return [
    { ...base, module: 'api-shield', resourceId: '1'.repeat(32), certificateId: '4'.repeat(32), certificateRef: 'certificate:lab-api', fingerprint: 'f'.repeat(64) },
    { ...base, module: 'access', resourceId: '2'.repeat(32), policyId: '5'.repeat(32), serviceTokenId: '6'.repeat(32), audience: 'e'.repeat(64) },
    { ...base, module: 'waiting-room', resourceId: '3'.repeat(32), settings: { hostname: new URL(base.origin).hostname, path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, queue_all: false, suspended: false } },
  ];
}
describe('runtime-config', () => {
  it('retains confirmed public resources without guessing credentials or queue timing', () => {
    const f = fixture(); const resources = optionalResources(f);
    const runtime = deployedRuntimeConfig(f.intent, f.inventory, 'c'.repeat(32), [], undefined, resources);
    expect(runtime.optionalResources).toEqual(resources);
    expect(runtime.demonstrations?.apiShield).toMatchObject({ policyId: '1'.repeat(32), authorizedCertificate: { ref: 'certificate:lab-api', hostname: new URL(f.config.environments[1].origin).hostname }, invalidCertificateRef: null });
    expect(runtime.demonstrations?.access).toMatchObject({ applicationId: '2'.repeat(32), policyId: '5'.repeat(32), audience: 'e'.repeat(64), serviceTokenRef: null });
    expect(runtime.demonstrations?.certificates).toBeUndefined(); expect(runtime.demonstrations?.serviceToken).toBeUndefined();
    expect(runtime.demonstrations?.waitingRoom).toBeUndefined(); // Resource existence is not queue timing proof.
    expect(runtime.credentials).toEqual(f.config.credentials); expect(runtime.inventory).toEqual(f.config.inventory);
    expect(f.config.optionalResources).toBeUndefined();
  });
  it.each(['account', 'zone', 'lab', 'origin', 'release', 'duplicate', 'room-host', 'secret'] as const)('rejects optional runtime %s mismatch', fault => {
    const f = fixture(); const resources = optionalResources(f);
    if (fault === 'account') resources[0]!.accountId = '0'.repeat(32);
    if (fault === 'zone') resources[0]!.zoneId = '0'.repeat(32);
    if (fault === 'lab') resources[0]!.labId = 'another-lab';
    if (fault === 'origin') resources[0]!.origin = f.config.environments[0].origin;
    if (fault === 'release') resources[0]!.releaseDigest = '0'.repeat(64);
    if (fault === 'duplicate') resources[1] = structuredClone(resources[0]!);
    if (fault === 'room-host') { const room = resources[2]!; if (room.module === 'waiting-room') room.settings.hostname = new URL(f.config.environments[0].origin).hostname; }
    if (fault === 'secret') Object.assign(resources[0]!, { client_secret: 'private-value' });
    expect(() => deployedRuntimeConfig(f.intent, f.inventory, undefined, [], undefined, resources)).toThrow();
  });
  it('emits complete typed isolated runtime bindings with only demo credential references', () => {
    const f = fixture();
    expect(f.config.credentials).toEqual({ reader: f.intent.discovery.credentials.reader, collector: f.intent.discovery.credentials.collector, runner: f.intent.discovery.credentials.runner });
    expect(f.config.credentials).not.toHaveProperty('deployer'); expect(f.config.credentials).not.toHaveProperty('setup');
    expect(f.config.environments[0].d1Id).toBe(f.inventory.environments.before.database_id);
    expect(f.config.environments[0].d1Id).not.toBe(f.config.environments[1].d1Id);
    expect(f.config.inventory.find(i => i.type === 'policy')?.id).toBe('c'.repeat(32));
  });
  it('selects only a marked successful single-lab runtime without assuming files exist', () => {
    const f = fixture(); expect(() => loadRuntimeConfig(f.root)).toThrow('Deploy');
    const directory = join(f.root, '.evidence/deployment/runtime', randomUUID()); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'runtime-config.json'), JSON.stringify(f.config));
    expect(() => loadRuntimeConfig(f.root)).toThrow('successfully');
    writeFileSync(join(directory, 'deployment.json'), JSON.stringify({ completedAt: new Date().toISOString(), claims: { coreDeployed: true } }));
    expect(loadRuntimeConfig(f.root)).toEqual(f.config);
  });
  it('rejects foreign inventory and explicit nonabsolute paths', () => {
    const f = fixture();
    expect(() => deployedRuntimeConfig(f.intent, { ...f.inventory, account_id: 'f'.repeat(32) })).toThrow('scope');
    expect(() => loadRuntimeConfig(f.root, 'relative.json')).toThrow('Absolute');
  });
});
