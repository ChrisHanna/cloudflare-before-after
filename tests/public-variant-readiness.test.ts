import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runDoctor } from '../packages/demo-core/src/doctor.js';
import { SYNTHETIC_IMAGE_BASE64, SYNTHETIC_IMAGE_DIGEST } from '../packages/demo-core/src/infrastructure.js';
import { TrustedCollectors, createTrustedCollectors, isObservedPublicVariantProof } from '../packages/demo-core/src/trusted-collectors.js';
import { collectTrustedImage } from '../packages/demo-core/src/trusted-collectors-image.js';
import * as imageCollector from '../packages/demo-core/src/trusted-collectors-image.js';
import { ServiceReadReceiptSchema } from '../packages/contracts/src/service-read.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { evaluateDeployment, deploymentFingerprint, collectDeploymentVerification, type DeploymentProbeOptions } from '../packages/demo-core/src/deployment-verification-core.js';
import { PublicVariantProofSchema, type PublicVariantProof, type PublicVariantFunctional } from '../packages/contracts/src/public-variant-proof.js';
import { ArtifactSchema, makeArtifact } from '../packages/demo-core/src/reports.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { deploymentFixture, time, end } from './workshop-core-fixtures.js';

const roots: string[] = []; const ledgers: BudgetLedger[] = [];
const selection = () => ({ source: 'existing-public-readonly' as const, id: 'public' as const, options: { fit: 'cover' as const, width: 320, height: 240, metadata: 'keep' as const }, neverRequireSignedURLs: true });
beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); })));
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.stop(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(realTime = false) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'public-readiness-')); roots.push(root);
  let now = Date.parse(time); const lab = demoLabFixture(root, undefined, () => realTime ? Date.now() : now); lab.config.imageVariant = selection();
  const { source: _source, ...variant } = selection();
  const remote = { group: { variants: { public: variant } } as any, status: 200, info: undefined as unknown,
    assets: { before: 'public', after: 'public' },
    delivery: { before: {}, after: {} } as Record<'before' | 'after', { accountHash?: string; expectedDigest?: string; deliveryOrigin?: string }>,
    duplicate: false, groupCalls: 0, afterDrift: false };
  const calls: { url: string; method: string }[] = [];
  const dispatch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET' }); const path = new URL(url).pathname;
    if (path.endsWith('/images/v1/variants')) {
      expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); remote.groupCalls++;
      const group = structuredClone(remote.group); if (remote.afterDrift && remote.groupCalls > 1) group.variants.public.options.width++;
      return Response.json({ success: remote.status === 200, result: group, errors: [], ...(remote.info === undefined ? {} : { result_info: remote.info }) }, { status: remote.status });
    }
    const response = await lab.dispatch(url, init);
    const env = lab.config.environments.find(env => path.endsWith(`/workers/scripts/${env.workerName}/settings`));
    if (!env) return response;
    const data = await response.json() as any;
    for (const binding of data.result.bindings) if (binding.name === 'IMAGE_ASSET_JSON') {
      const asset = JSON.parse(binding.text); asset.variant = remote.assets[env.role]; Object.assign(asset, remote.delivery[env.role]); binding.text = JSON.stringify(asset);
      if (remote.duplicate) data.result.bindings.push({ ...binding });
      break;
    }
    return Response.json(data);
  });
  const collector = (mode: 'live' | 'fixture' = 'fixture') => {
    const ledger = new BudgetLedger({ limits: { requests: 100 } }); ledgers.push(ledger);
    return createTrustedCollectors({ config: lab.config, ledger, mode, credentials: lab.credentials, dispatch, now: () => now,
      observedOwnedResources: new Set(lab.config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)) });
  };
  return { root, ...lab, remote, calls, dispatch, collector, now: () => now, setNow: (value: string) => { now = Date.parse(value); } };
}
function expectedFunctional(f: ReturnType<typeof fixture>): PublicVariantFunctional {
  return { variant: selection(), assets: f.config.environments.map(env => ({ role: env.role, workerName: env.workerName, origin: env.origin,
    releaseDigest: env.releaseDigest, imageId: env.imageIds[0]!, variant: 'public', deliveryOrigin: 'https://imagedelivery.net', accountHash: 'fixture-account', expectedDigest: SYNTHETIC_IMAGE_DIGEST })) as PublicVariantFunctional['assets'] };
}
async function evaluation() {
  const f = fixture(); const d = deploymentFixture(); d.config = f.config;
  d.state.releaseDigest = f.config.environments[0].releaseDigest;
  for (const env of f.config.environments) {
    d.state.bindings[env.role] = { d1: env.d1Id, r2: env.r2Bucket, images: env.imageIds, container: env.containerBinding };
    const probe = d.probes.find(probe => probe.role === env.role)!; probe.releaseDigest = env.releaseDigest;
    for (const operation of probe.operations) {
      operation.releaseDigest = env.releaseDigest; operation.evidence.mode = 'live';
      operation.resourceId = operation.service === 'images' ? env.imageIds[0]! : d.state.bindings[env.role][operation.service]!;
      if (operation.service === 'images') {
        operation.imageVariant = 'public'; operation.contentDigest = SYNTHETIC_IMAGE_DIGEST;
        operation.imageDelivery = { deliveryOrigin: 'https://imagedelivery.net', accountHash: 'fixture-account', resourceId: operation.resourceId, variant: 'public', encodedDigest: SYNTHETIC_IMAGE_DIGEST };
      }
    }
  }
  d.state.publicImages = expectedFunctional(f);
  const runId = randomUUID(); const collector = f.collector('live');
  const before = (await collector.publicVariantProof({ runId, phase: 'before', startedAt: time })).value!;
  f.setNow(end);
  const after = (await collector.publicVariantProof({ runId, phase: 'after', startedAt: time })).value!;
  const input = { mode: 'live' as const, config: f.config, expected: d.state, before: d.state, after: d.state,
    probes: d.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: end, verificationRunId: runId,
    publicVariantProofs: [before, after] };
  return { f, d, input, collector, before, after, runId };
}

describe('public Doctor and actual image selection', () => {
  it('passes matching public observations and both actual public assets, while all stronger claims stay false', async () => {
    const f = fixture(true); const result = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
    expect(result.preflightReady).toBe(true); expect(result.requestsUsed).toBe(26); expect(f.calls).toHaveLength(26);
    expect(result.checks.filter(check => check.id.startsWith('public-variant')).map(check => check.state)).toEqual(['passed', 'passed']);
    expect(Object.values(result.claims).every(claim => claim === false)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['before', 'after'] as const)('fixes F1: public config with managed %s asset cannot pass Doctor or image collection', async role => {
    const f = fixture(true); f.remote.assets[role] = `${f.config.labId}-catalog`;
    const read = await f.collector().imageAsset(role); expect(read.state).toBe('mismatch'); expect(read.value).toBeNull();
    const result = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
    expect(result.preflightReady).toBe(false); expect(result.checks.find(check => check.id === `${role}-worker-bindings`)?.state).toBe('failed');
    expect(f.calls.some(call => call.url.startsWith('https://imagedelivery.net'))).toBe(false);
  });
  it.each(['missing', 'denied', 'unknown-transform', 'ambiguous', 'width', 'metadata', 'signing', 'after-drift'] as const)('blocks %s public evidence without any repair', async fault => {
    const f = fixture(true);
    if (fault === 'missing') f.remote.group = { variants: {} };
    if (fault === 'denied') f.remote.status = 403;
    if (fault === 'unknown-transform') f.remote.group.variants.public.options.rotate = 90;
    if (fault === 'ambiguous') f.remote.group.variants.public.id = 'alias';
    if (fault === 'width') f.remote.group.variants.public.options.width++;
    if (fault === 'metadata') f.remote.group.variants.public.options.metadata = 'none';
    if (fault === 'signing') f.remote.group.variants.public.neverRequireSignedURLs = false;
    if (fault === 'after-drift') f.remote.afterDrift = true;
    const result = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
    expect(result.preflightReady).toBe(false); expect(result.checks.some(check => check.id.startsWith('public-variant') && check.state !== 'passed')).toBe(true);
    expect(f.calls.filter(call => call.url.endsWith('/variants')).every(call => call.method === 'GET')).toBe(true);
    expect(Object.values(result.claims).every(claim => claim === false)).toBe(true);
  });
  it('requires 26 public reads plus the existing cleanup reserve before any I/O or lease', async () => {
    const f = fixture(true);
    await expect(runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch, limits: { requests: 26 } })).rejects.toThrow('fit');
    expect(f.calls).toEqual([]); expect(existsSync(f.config.evidenceDirectory)).toBe(false);
    expect((await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch, limits: { requests: 27 } })).preflightReady).toBe(true);
  });
  it('rejects duplicate Worker image bindings and direct managed-variant decode before any I/O/browser', async () => {
    const f = fixture(true); f.remote.duplicate = true;
    const result = await runDoctor({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scope: 'core-waf', dispatch: f.dispatch });
    expect(result.preflightReady).toBe(false);
    const count = f.calls.length; const ledger = new BudgetLedger(); ledgers.push(ledger);
    await expect(collectTrustedImage({ config: f.config, ledger, mode: 'fixture', credentials: f.credentials, dispatch: f.dispatch,
      observedOwnedResources: new Set(f.config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)) }, { role: 'before', runId: randomUUID(), requestId: randomUUID(), scenarioId: 'waf-custom',
      releaseDigest: f.config.environments[0].releaseDigest, resourceId: f.config.environments[0].imageIds[0]!, deliveryAccount: 'fixture-account', variant: `${f.config.labId}-catalog` })).rejects.toThrow('variant');
    expect(f.calls).toHaveLength(count); expect(fetch).not.toHaveBeenCalled();
  });
});

describe('scoped actual public proofs and deployment fingerprints', () => {
  it('fixes F2: desired public state alone cannot verify without actual observations', async () => {
    const f = await evaluation(); const { publicVariantProofs: _proofs, ...withoutObservations } = f.input;
    const result = evaluateDeployment(withoutObservations);
    expect(result.deploymentVerified).toBe(false); expect(result.beforeFingerprint).toBeNull(); expect(result.afterFingerprint).toBeNull();
    expect(result.blockers).toContain('public-variant-before');
  });
  it('accepts fresh matched actual before/after proofs, excludes time/read IDs from functional fingerprints', async () => {
    const f = await evaluation(); const result = evaluateDeployment(f.input);
    expect(result.deploymentVerified).toBe(true); expect(result.blockers).toEqual([]);
    expect(f.before.observedAt).not.toBe(f.after.observedAt); expect(f.before.readId).not.toBe(f.after.readId);
    expect(result.beforeFingerprint).toBe(result.afterFingerprint);
    expect(result.beforeFingerprint).toBe(deploymentFingerprint({ ...f.d.state, publicImages: f.before.functional }));
    expect(isObservedPublicVariantProof(f.before)).toBe(true); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['width', 'metadata', 'signing'] as const)('observed %s drift changes the fingerprint and blocks verification', async field => {
    const f = await evaluation();
    if (field === 'width') f.f.remote.group.variants.public.options.width = 1000;
    if (field === 'metadata') f.f.remote.group.variants.public.options.metadata = 'none';
    if (field === 'signing') f.f.remote.group.variants.public.neverRequireSignedURLs = false;
    const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time });
    expect(read.state).toBe('mismatch'); expect(read.value).not.toBeNull();
    const result = evaluateDeployment({ ...f.input, publicVariantProofs: [f.before, read.value!] });
    expect(result.deploymentVerified).toBe(false); expect(result.beforeFingerprint).not.toBe(result.afterFingerprint);
    expect(result.blockers).toContain('public-variant-after'); expect(result.historical).toBe(true);
    expect(f.d.state.publicImages!.variant).toEqual(selection());
  });
  it.each([['before', 'accountHash'], ['after', 'accountHash'], ['before', 'expectedDigest'], ['after', 'expectedDigest']] as const)('rejects actual %s post-probe %s-only changes', async (role, field) => {
    const f = await evaluation();
    f.f.remote.delivery[role][field] = field === 'accountHash' ? 'another-delivery-account' : 'f'.repeat(64);
    const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time });
    expect(read.value).not.toBeNull(); expect(isObservedPublicVariantProof(read.value!)).toBe(true);
    const result = evaluateDeployment({ ...f.input, publicVariantProofs: [f.before, read.value!] });
    expect(result.deploymentVerified, `${role}/${field}`).toBe(false); expect(result.historical).toBe(true);
    expect(result.beforeFingerprint).not.toBe(result.afterFingerprint); expect(result.blockers).toContain('public-variant-stable');
    expect(read.value!.functional).not.toEqual(f.before.functional);
  });
  it('rejects a late full Before timestamp even with correctly sealed public phases', async () => {
    const f = await evaluation();
    expect(isObservedPublicVariantProof(f.before)).toBe(true); expect(isObservedPublicVariantProof(f.after)).toBe(true);
    const result = evaluateDeployment({ ...f.input, beforeObservedAt: end });
    expect(result.deploymentVerified).toBe(false); expect(result.historical).toBe(true);
    expect(result.blockers).toContain('readback-brackets-probes');
  });
  it.each(['before', 'after'] as const)('rejects unsupported actual %s delivery origin without substituting expected data', async role => {
    const f = await evaluation(); f.f.remote.delivery[role].deliveryOrigin = 'https://foreign.example.test';
    const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time });
    expect(read.value).toBeNull();
    const result = evaluateDeployment({ ...f.input, publicVariantProofs: [f.before] });
    expect(result.deploymentVerified).toBe(false); expect(result.historical).toBe(true);
    expect(f.d.state.publicImages!.assets.find(asset => asset.role === role)!.deliveryOrigin).toBe('https://imagedelivery.net');
  });
  it.each(['missing', 'denied', 'partial', 'cursor', 'unknown-transform', 'missing-signing', 'duplicate-assets'] as const)('missing or unsafe %s reads cannot become observations', async fault => {
    const f = fixture();
    if (fault === 'missing') f.remote.group = { variants: {} };
    if (fault === 'denied') f.remote.status = 403;
    if (fault === 'partial') f.remote.info = { page: 1, total_pages: 2 };
    if (fault === 'cursor') f.remote.info = { cursor: 'next-page' };
    if (fault === 'unknown-transform') f.remote.group.variants.public.options.rotate = 90;
    if (fault === 'duplicate-assets') f.remote.duplicate = true;
    if (fault === 'missing-signing') delete f.remote.group.variants.public.neverRequireSignedURLs;
    const read = await f.collector().publicVariantProof({ runId: randomUUID(), phase: 'before', startedAt: time });
    expect(read.value).toBeNull(); expect(read.state).not.toBe('observed');
    expect(f.calls.filter(call => call.url.endsWith('/variants'))).toHaveLength(1);
  });
  it.each(['clone', 'missing-phase', 'phase-replay', 'wrong-run', 'wrong-mode', 'wrong-account', 'wrong-source', 'stale', 'future', 'mutated-settings'] as const)('rejects %s proof substitution/replay', async fault => {
    const f = await evaluation(); let proofs = [f.before, f.after]; let runId = f.runId;
    if (fault === 'clone') proofs = JSON.parse(JSON.stringify(proofs));
    if (fault === 'missing-phase') proofs = [f.before];
    if (fault === 'phase-replay') proofs = [f.before, f.before];
    if (fault === 'wrong-run') runId = randomUUID();
    if (fault === 'wrong-mode') { const read = await f.f.collector('fixture').publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time }); proofs[1] = read.value!; }
    if (fault === 'wrong-account') f.after.accountId = '0'.repeat(32);
    if (fault === 'wrong-source') Object.assign(f.after, { source: 'desired-configuration' });
    if (fault === 'stale') { f.f.setNow('2026-11-03T23:59:00.000Z'); const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'before', startedAt: '2026-11-03T23:59:00.000Z' }); proofs[0] = read.value!; }
    if (fault === 'future') { f.f.setNow('2026-11-04T00:01:01.000Z'); const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time }); proofs[1] = read.value!; }
    if (fault === 'mutated-settings') f.after.functional.variant.options.width++;
    const result = evaluateDeployment({ ...f.input, verificationRunId: runId, publicVariantProofs: proofs });
    expect(result.deploymentVerified).toBe(false); expect(result.blockers.some(blocker => blocker.startsWith('public-variant'))).toBe(true);
  });
  it.each(['account', 'lab', 'origin', 'release'] as const)('rejects %s config substitution against genuinely observed proofs', async field => {
    const f = await evaluation(); const config = structuredClone(f.input.config);
    if (field === 'account') config.accountId = '0'.repeat(32);
    if (field === 'lab') { config.labId = 'other-lab'; for (const item of config.inventory) item.labId = config.labId; }
    if (field === 'origin') config.environments[1].origin = 'https://other.example.test';
    if (field === 'release') for (const env of config.environments) env.releaseDigest = 'f'.repeat(64);
    expect(evaluateDeployment({ ...f.input, config }).deploymentVerified).toBe(false);
  });
  it.each(['before', 'after'] as const)('requires actual public asset use in %s image decode, not merely global existence', async role => {
    const f = await evaluation(); const operation = f.d.probes.find(probe => probe.role === role)!.operations.find(operation => operation.service === 'images')!;
    delete operation.imageVariant;
    const missing = evaluateDeployment(f.input); expect(missing.deploymentVerified).toBe(false); expect(missing.blockers).toContain(`${role}-images-decode`);
    operation.imageVariant = `${f.f.config.labId}-catalog`; expect(evaluateDeployment(f.input).deploymentVerified).toBe(false);
  });
  it.each(['before', 'after'] as const)('requires the complete measured %s decode delivery tuple', async role => {
    for (const field of ['missing', 'accountHash', 'encodedDigest', 'resourceId', 'variant', 'deliveryOrigin'] as const) {
      const f = await evaluation();
      const operation = f.d.probes.find(probe => probe.role === role)!.operations.find(operation => operation.service === 'images')!;
      if (field === 'missing') delete operation.imageDelivery;
      else if (field === 'encodedDigest') { operation.imageDelivery!.encodedDigest = 'f'.repeat(64); operation.contentDigest = 'f'.repeat(64); }
      else if (field === 'deliveryOrigin') Object.assign(operation.imageDelivery!, { deliveryOrigin: 'https://foreign.example.test' });
      else operation.imageDelivery![field] = field === 'accountHash' ? 'different-account' : 'different-image';
      if (field === 'deliveryOrigin') expect(() => evaluateDeployment(f.input)).toThrow();
      else {
        const result = evaluateDeployment(f.input); expect(result.deploymentVerified, `${role}/${field}`).toBe(false);
        expect(result.blockers).toContain(`${role}-images-decode`);
      }
    }
  });
  it('rejects missing expected delivery fields rather than synthesizing an expected tuple', async () => {
    const f = await evaluation(); const expected = structuredClone(f.input.expected);
    Reflect.deleteProperty(expected.publicImages!.assets[0], 'accountHash');
    expect(() => evaluateDeployment({ ...f.input, expected })).toThrow();
  });
  it.each(['stale', 'future', 'cancelled'] as const)('refuses %s collection scopes before provider I/O', async fault => {
    const f = fixture(); const collector = f.collector(); const signal = new AbortController();
    if (fault === 'cancelled') signal.abort();
    const startedAt = fault === 'stale' ? '2026-11-03T23:57:59.000Z' : fault === 'future' ? end : time;
    const read = await collector.publicVariantProof({ runId: randomUUID(), phase: 'before', startedAt }, signal.signal);
    expect(read.value).toBeNull(); expect(f.calls).toEqual([]);
  });
  it('binds both actual Worker assets and registers strict scoped artifacts without retaining private fields', async () => {
    const f = await evaluation(); f.f.remote.assets.after = `${f.f.config.labId}-catalog`;
    const read = await f.collector.publicVariantProof({ runId: f.runId, phase: 'after', startedAt: time }); expect(read.value).not.toBeNull();
    const result = evaluateDeployment({ ...f.input, publicVariantProofs: [f.before, read.value!] });
    expect(result.blockers).toContain('after-public-asset-after'); expect(result.deploymentVerified).toBe(false);
    const built = makeArtifact({ id: randomUUID(), mode: 'live', runId: f.runId, scenarioId: 'waf-custom', targetRole: 'before', requestId: null,
      observedAt: f.before.observedAt, source: 'cloudflare', payload: f.before });
    expect(ArtifactSchema.parse(built.artifact)).toEqual(built.artifact); expect(built.text).not.toContain(f.f.canary);
    expect(PublicVariantProofSchema.safeParse({ ...f.before, private: 'do-not-publish' }).success).toBe(false);
    expect(ArtifactSchema.safeParse({ ...built.artifact, observedAt: end }).success).toBe(false);
    expect(isObservedPublicVariantProof(JSON.parse(built.text).payload)).toBe(false);
  });
});

function collection() {
  const f = fixture(); const d = deploymentFixture(); const expected = { ...d.state, publicImages: expectedFunctional(f) };
  const options: DeploymentProbeOptions = { projectRoot: f.root, config: f.config, expected, mode: 'fixture', credentials: f.credentials,
    observedOwnedResources: new Set(f.config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)), plannedRequests: 14,
    now: f.now, dispatch: f.dispatch, operations: async () => [], inspect: async (client, signal) => {
      await client.request({ kind: 'cloudflare', url: `${f.config.apiOrigin}/client/v4/accounts/${f.config.accountId}` }, signal);
      return { state: d.state, observedAt: time };
    } };
  return { f, options };
}
describe('public observation request accounting and default unknown state', () => {
  it('rejects omitted added reads and small hard caps before any provider I/O', async () => {
    const { f, options } = collection();
    await expect(collectDeploymentVerification({ ...options, plannedRequests: 13 })).rejects.toThrow('six required'); expect(f.calls).toEqual([]);
    await expect(collectDeploymentVerification({ ...options, limits: { requests: 13 } })).rejects.toThrow('fit'); expect(f.calls).toEqual([]);
    const { reader: _reader, ...credentials } = options.credentials;
    await expect(collectDeploymentVerification({ ...options, credentials })).rejects.toThrow('reader'); expect(f.calls).toEqual([]);
  });
  it('counts six actual added reads and lets explicit full-state adapters coexist with actual public observations', async () => {
    const { f, options } = collection(); const result = await collectDeploymentVerification(options);
    expect(result.requestsUsed).toBe(14); expect(f.calls).toHaveLength(14); expect(result.publicVariantProofs).toHaveLength(2);
    expect(result.artifacts?.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'public-variant-proof')).toHaveLength(2);
    for (const artifact of result.artifacts ?? []) expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
    expect(result.checks.filter(check => check.id.startsWith('public-variant')).every(check => check.passed)).toBe(true);
    expect(result.deploymentVerified).toBe(false); // Missing service proofs remain missing.
  });
  it('carries returned decode delivery facts through default operations and strict artifacts, not expected tuples', async () => {
    const { f, options } = collection(); delete options.operations; options.plannedRequests = 22;
    const coverage = { healthy: true, complete: true, windowStart: time, watermark: time, producerSequence: 1, gaps: [] };
    const origin = { receipts: [], coverage, originCount: 1, requestEntered: true, requestCompleted: true, absenceProven: false };
    vi.spyOn(TrustedCollectors.prototype, 'serviceRead').mockImplementation(async scope => {
      const env = f.config.environments.find(env => env.role === scope.role)!;
      const operations = (['d1', 'r2', 'container'] as const).map(service => ({ service, operation: service === 'container' ? 'execute' as const : 'read' as const,
        resourceId: service === 'd1' ? env.d1Id : service === 'r2' ? env.r2Bucket : env.containerBinding, contentDigest: 'a'.repeat(64) }));
      const receipt = ServiceReadReceiptSchema.parse({ schemaVersion: 1, targetRole: scope.role, runId: scope.runId, requestId: scope.requestId,
        scenarioId: scope.scenarioId, releaseDigest: scope.releaseDigest, observedAt: time, operations });
      return { state: 'observed', permission: 'granted', entitlement: 'unknown', mode: 'fixture', observedAt: time, gaps: [],
        value: { scope, status: 200, container: origin, receipt, operations, serviceStates: { d1: 'observed', r2: 'observed', images: 'unknown', container: 'observed' } } };
    });
    vi.spyOn(TrustedCollectors.prototype, 'origin').mockResolvedValue({ state: 'observed', permission: 'granted', entitlement: 'unknown', mode: 'fixture', observedAt: time, gaps: [], value: origin });
    vi.spyOn(imageCollector, 'collectTrustedImage').mockImplementation(async (_options, input) => {
      const bytes = Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64');
      const delivery = imageCollector.observedImageDelivery(`https://imagedelivery.net/measured-account/measured-${input.role}-image/${input.variant}`, bytes);
      return { state: 'observed', permission: 'granted', entitlement: 'unknown', mode: 'fixture', observedAt: time, gaps: [], value: {
        role: input.role, runId: input.runId, requestId: input.requestId, scenarioId: input.scenarioId, releaseDigest: input.releaseDigest,
        resourceId: delivery.resourceId, variant: delivery.variant, delivery, source: 'observed-browser', width: 1, height: 1, bodyBytes: bytes.length,
        encodedDigest: delivery.encodedDigest, pixelDigest: 'b'.repeat(64), applicationJoin: 'unknown' } };
    });
    const result = await collectDeploymentVerification(options);
    expect(result.probes).toHaveLength(2); expect(result.deploymentVerified).toBe(false);
    for (const role of ['before', 'after'] as const) {
      const operation = result.probes.find(probe => probe.role === role)!.operations.find(operation => operation.service === 'images')!;
      expect(operation.imageDelivery?.accountHash).toBe('measured-account'); expect(operation.imageDelivery?.encodedDigest).toBe(SYNTHETIC_IMAGE_DIGEST);
      expect(operation.resourceId).toBe(`measured-${role}-image`); expect(operation.imageDelivery?.resourceId).toBe(operation.resourceId);
      expect(result.blockers).toContain(`${role}-images-decode`);
      const artifact = result.artifacts!.find(artifact => artifact.id === operation.evidence.id)!;
      expect(ArtifactSchema.safeParse(artifact).success).toBe(true);
      if (!('kind' in artifact.payload) || artifact.payload.kind !== 'owned-image-decode') throw new Error('Missing strict decode artifact');
      expect(artifact.payload.delivery).toEqual(operation.imageDelivery);
      expect(ArtifactSchema.safeParse({ ...artifact, payload: { ...artifact.payload, delivery: { ...artifact.payload.delivery, encodedDigest: 'f'.repeat(64) } } }).success).toBe(false);
      expect(ArtifactSchema.safeParse({ ...artifact, payload: { ...artifact.payload, delivery: { ...artifact.payload.delivery, private: 'do-not-publish' } } }).success).toBe(false);
      const legacy = { ...artifact.payload }; delete legacy.delivery;
      expect(ArtifactSchema.safeParse({ ...artifact, payload: legacy }).success).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps default full deployment state null despite successful partial public proofs', async () => {
    const { f, options } = collection(); delete options.inspect; options.plannedRequests = 20;
    const result = await collectDeploymentVerification(options);
    expect(result.requestsUsed).toBe(20); expect(f.calls).toHaveLength(20); expect(result.publicVariantProofs).toHaveLength(2);
    expect(result.beforeFingerprint).toBeNull(); expect(result.afterFingerprint).toBeNull(); expect(result.deploymentVerified).toBe(false);
    expect(result.blockers).toContain('current-observed-state');
    expect(result.checks.find(check => check.id === 'public-variant-before')?.passed).toBe(true);
  });
});
