import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync, existsSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deploymentIntent } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { createDeploymentPlan, digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { DeploymentStore, type ApplyRecord } from '../packages/demo-core/src/deployment-store.js';
import { deployedRuntimeConfig } from '../packages/demo-core/src/runtime-config.js';
import { runLabCli } from '../packages/demo-core/src/lab-cli.js';
import { OptionalProductFileJournal } from '../packages/demo-core/src/optional-product-setup-store.js';
import { loadPriorOptionalOwnership, saveOptionalSetup, approveOptionalSetup } from '../packages/demo-core/src/optional-product-integration.js';
import { planOptionalProductSetup, applyOptionalProductSetup, readConfirmedOptionalResources, optionalProductDesired,
  type OptionalProductProvider, type OptionalProductState, type OptionalProductModule, type OptionalProductSelection } from '../packages/demo-core/src/optional-product-setup.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
// Synthetic marked history exercises local provenance contracts only. It never
// asserts that core resources were deployed; fresh provider checks remain mandatory.
async function fixture(publish = true) {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'prior-')); roots.push(root);
  const inventory = infrastructureFixture().inventory;
  const intent = deploymentIntent(root, NOW); intent.profile = 'workshop'; intent.discovery.labId = inventory.lab_id;
  const capability = await discoverCapabilities(intent.discovery, 'workshop', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, undefined, new Date(NOW).toISOString());
  const plan = createDeploymentPlan(intent, capability, 'b'.repeat(64), root, NOW, ['core', ...capability.includedModules]);
  expect(plan.blockers).toEqual([]);
  const hostname = new URL(intent.discovery.environments[1].origin).hostname;
  const selections: OptionalProductSelection[] = [
    { module: 'api-shield', certificateId: '4'.repeat(32), certificateRef: 'certificate:lab-api', fingerprint: 'f'.repeat(64) },
    { module: 'access', serviceTokenId: 'd'.repeat(32) },
    { module: 'waiting-room', settings: { hostname, path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, queue_all: false, suspended: false } },
  ];
  const modules = ['api-shield', 'access', 'waiting-room'] as const;
  const state = (module: OptionalProductModule): OptionalProductState => ({ module, resources: [], rulesetId: module === 'api-shield' ? 'e'.repeat(32) : null,
    certificate: module === 'api-shield' ? { id: '4'.repeat(32), hostname, fingerprint: 'f'.repeat(64), ready: true } : null,
    serviceTokenId: module === 'access' ? 'd'.repeat(32) : null });
  const states: Record<OptionalProductModule, OptionalProductState> = { 'api-shield': state('api-shield'), access: state('access'), 'waiting-room': state('waiting-room') };
  const create = vi.fn<OptionalProductProvider['create']>(async (current, selection) => {
    const body = optionalProductDesired(current, selection) as Record<string, unknown>;
    const id = String(modules.indexOf(selection.module) + 1).repeat(32);
    states[selection.module].resources.push({ ...body, id, name: String(body.name ?? body.description),
      ...(selection.module === 'access' ? { aud: '9'.repeat(64), policies: (body.policies as Record<string, unknown>[]).map(policy => ({ ...policy, id: '8'.repeat(32) })) } : {}) });
    return [id];
  });
  const provider: OptionalProductProvider = { mode: 'fixture', create, inspect: async (_plan, selection) => structuredClone(states[selection.module]) };
  const signal = new AbortController().signal;
  const setup = await planOptionalProductSetup(plan, selections, provider, {}, signal, NOW);
  const store = new DeploymentStore(root, intent.discovery.evidenceDirectory); const saved = store.save(plan);
  store.approve(saved.planPath, `APPROVE ${saved.digest}`, true, NOW);
  const setupPath = saveOptionalSetup(root, saved.planPath, setup);
  const approval = approveOptionalSetup(root, setupPath, plan, `APPROVE OPTIONAL ${digestValue(setup)}`, true, NOW);
  const journal = new OptionalProductFileJournal(root, intent.discovery.evidenceDirectory);
  const observed: ApplyRecord['resources'] = [];
  const context = { plan, signal, perform: async <T>(_kind: string, _id: string, action: () => Promise<T>) => action(),
    observeResource: (kind: string, id: string) => { observed.push({ kind, id, operationId: 'fixture', certainty: 'confirmed' }); } };
  const attempt = store.begin(plan, saved.digest, NOW);
  const options = { plan, setup, approval, provider, journal, context, revalidate: async () => plan, now: () => NOW };
  expect((await applyOptionalProductSetup(options)).status).toBe('succeeded');
  const resources = await readConfirmedOptionalResources(options);
  const runtime = deployedRuntimeConfig(intent, inventory, undefined, [], undefined, resources);
  const runtimeDirectory = join(intent.discovery.evidenceDirectory, 'deployment', 'runtime'); const runDirectory = join(runtimeDirectory, plan.id);
  const marker = { schemaVersion: 1, labId: intent.discovery.labId, sourceDigest: plan.sourceDigest, releaseDigest: intent.releaseDigest,
    completedAt: new Date(NOW + 50).toISOString(), claims: { coreDeployed: true, interviewVerified: false, workshopVerified: false } };
  store.update({ ...attempt, status: 'succeeded', finishedAt: new Date(NOW + 100).toISOString(), completedSteps: plan.steps.map(step => step.id), resources: observed });
  if (publish) {
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, 'runtime-config.json'), JSON.stringify(runtime));
    writeFileSync(join(runDirectory, 'deployment.json'), JSON.stringify(marker));
  }
  const later = NOW + 20 * 60000;
  const nextIntent = structuredClone(intent); nextIntent.costs.observedAt = new Date(later).toISOString();
  const freshCapability = await discoverCapabilities(intent.discovery, 'workshop', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, undefined, new Date(later).toISOString());
  const next = createDeploymentPlan(nextIntent, freshCapability, 'c'.repeat(64), root, later, ['core', ...freshCapability.includedModules]);
  expect(next.blockers).toEqual([]);
  return { root, plan, next, later, store, saved, setup, setupPath, journal, provider, create, selections, runtime, marker, runtimeDirectory, runDirectory,
    attemptPath: join(store.directory, `${plan.id}.attempt.json`), approvalPath: join(store.directory, `${plan.id}.approval.json`) };
}
function change(path: string, update: (value: any) => void) {
  const value = JSON.parse(readFileSync(path, 'utf8')); update(value); writeFileSync(path, JSON.stringify(value));
}
describe('prior optional ownership is scoped history, not write approval', () => {
  it('reuses confirmed identities for fresh read-only planning, never expired approval for writes', async () => {
    const f = await fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external calls'));
    expect(() => f.store.approval(f.plan, f.saved.digest, f.later)).toThrow('Approval');
    const owned = loadPriorOptionalOwnership(f.root, f.next, f.later);
    expect(owned).toEqual({ 'api-shield': ['1'.repeat(32)], access: ['2'.repeat(32)], 'waiting-room': ['3'.repeat(32)] });
    await expect(planOptionalProductSetup(f.next, f.selections, f.provider, {}, new AbortController().signal, f.later)).rejects.toThrow('prior owned-resource');
    const reviewed = await planOptionalProductSetup(f.next, f.selections, f.provider, owned, new AbortController().signal, f.later);
    expect(reviewed.centralPlanDigest).toBe(digestValue(f.next)); expect(reviewed.centralPlanDigest).not.toBe(f.setup.centralPlanDigest);
    expect(reviewed.operations.map(operation => operation.ownershipIds)).toEqual([['1'.repeat(32)], ['2'.repeat(32)], ['3'.repeat(32)]]);
    expect(f.create).toHaveBeenCalledTimes(3); expect(fetch).not.toHaveBeenCalled();
  });
  it('routes actual CLI re-planning through scoped history without creating resources', async () => {
    const f = await fixture(); const selectionsPath = join(f.root, 'selections.json');
    writeFileSync(selectionsPath, JSON.stringify(f.selections));
    const result = await runLabCli(['plan', '--config', join(f.root, 'intent.json'), '--optional-selections', selectionsPath, '--json'], {
      projectRoot: f.root, loadConfig: () => f.next.intent, sourceDigest: () => f.next.sourceDigest, now: () => f.later,
      implementedModules: ['core', ...f.next.includedModules], prepare: async () => [], optionalProvider: () => f.provider,
      provider: () => ({ provider: { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, close() {} }),
    });
    expect(result.exitCode, result.output).toBe(0);
    const output = JSON.parse(result.output); const setup = JSON.parse(readFileSync(output.optionalPlanPath, 'utf8'));
    expect(setup.operations.map((operation: { ownershipIds: string[] }) => operation.ownershipIds)).toEqual([['1'.repeat(32)], ['2'.repeat(32)], ['3'.repeat(32)]]);
    expect(output.approvalState).toBe('not-approved'); expect(f.create).toHaveBeenCalledTimes(3);
  });
  it('does not create history directories or accept an unmarked local override', async () => {
    const f = await fixture(false); mkdirSync(join(f.root, '.lab'));
    writeFileSync(join(f.root, '.lab', 'runtime.json'), JSON.stringify(f.runtime));
    expect(existsSync(f.runtimeDirectory)).toBe(false);
    expect(loadPriorOptionalOwnership(f.root, f.next, f.later)).toEqual({}); expect(existsSync(f.runtimeDirectory)).toBe(false);
  });
  it('ignores a runtime file until the successful marker exists', async () => {
    const f = await fixture(); unlinkSync(join(f.runDirectory, 'deployment.json'));
    expect(loadPriorOptionalOwnership(f.root, f.next, f.later)).toEqual({});
  });
  it.each(['account', 'zone', 'lab', 'host', 'mode'] as const)('never borrows prior identity across %s scope', async scope => {
    const f = await fixture(); const next = structuredClone(f.next);
    if (scope === 'account') next.intent.discovery.accountId = '0'.repeat(32);
    if (scope === 'zone') next.intent.discovery.zoneId = '0'.repeat(32);
    if (scope === 'lab') next.intent.discovery.labId = 'another-lab';
    if (scope === 'host') next.intent.discovery.environments[1].origin = 'https://other.example.test';
    if (scope === 'mode') next.mode = 'live';
    expect(loadPriorOptionalOwnership(f.root, next, f.later)).toEqual({});
  });
  it.each(['failed', 'steps', 'digest', 'approval', 'optional-approval', 'journal', 'uncertain', 'future', 'marker', 'lineage'] as const)('rejects %s history instead of granting IDs', async fault => {
    const f = await fixture();
    if (fault === 'failed') change(f.attemptPath, value => { value.status = 'failed'; });
    if (fault === 'steps') change(f.attemptPath, value => { value.completedSteps = []; });
    if (fault === 'digest') change(f.attemptPath, value => { value.planDigest = '0'.repeat(64); });
    if (fault === 'approval') change(f.approvalPath, value => { value.planDigest = '0'.repeat(64); });
    if (fault === 'optional-approval') change(`${f.setupPath}.approval.json`, value => { value.planDigest = '0'.repeat(64); });
    const resource = f.runtime.optionalResources![0]!;
    const key = `${resource.optionalPlanDigest}-${resource.operationId}`;
    const journalPath = join(f.journal.directory, `${key}.json`);
    if (fault === 'journal') unlinkSync(journalPath);
    if (fault === 'uncertain') change(journalPath, value => { value.state = 'possible'; value.afterDigest = null; });
    if (fault === 'future') change(f.attemptPath, value => { value.finishedAt = new Date(f.later + 1).toISOString(); });
    if (fault === 'marker') change(join(f.runDirectory, 'deployment.json'), value => { value.sourceDigest = '0'.repeat(64); });
    if (fault === 'lineage') change(join(f.runDirectory, 'runtime-config.json'), value => { value.optionalResources[0].centralPlanDigest = '0'.repeat(64); });
    expect(() => loadPriorOptionalOwnership(f.root, f.next, f.later)).toThrow(); expect(f.create).toHaveBeenCalledTimes(3);
  });
  it('rejects linked directories and limits the scan before reading more history', async () => {
    const f = await fixture(); const link = join(f.runtimeDirectory, randomUUID()); symlinkSync(f.runDirectory, link, 'dir');
    expect(() => loadPriorOptionalOwnership(f.root, f.next, f.later)).toThrow('Symlink'); unlinkSync(link);
    for (let index = 0; index < 100; index++) mkdirSync(join(f.runtimeDirectory, `unmarked-${index}`));
    expect(() => loadPriorOptionalOwnership(f.root, f.next, f.later)).toThrow('bounded');
  });
});
