import { z } from 'zod';
import { captureWorkerReadback, compareWorkerReadbacks } from './worker-readback.js';
import type { WorkerReadback } from '../../contracts/src/worker-readback.js';
import { createTrustedCollectors, isObservedPublicVariantProof } from './trusted-collectors.js';
import { ImageDeliveryReadbackSchema, PublicVariantFunctionalSchema, PublicVariantProofSchema, type PublicVariantProof } from '../../contracts/src/public-variant-proof.js';
import { selectedImageVariantId } from './image-variant-selection.js';
import { collectTrustedImage } from './trusted-collectors-image.js';
import { makeArtifact, type Artifact } from './reports.js';
import { createHash, randomUUID } from 'node:crypto';
import { Digest, Id, Time, Role, ReceiptSchema, CoverageSchema, EvidenceRefSchema, ScenarioId } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { BudgetLedger, validatePlan, type Clock, type Limits } from './budget.js';
import { validateLabConfig, assertLiveReady, type LabConfig } from './config.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { validateCapture, type ScenarioCapture } from './workshop-aggregation.js';

const Resource = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Bindings = z.strictObject({ d1: Resource.nullable(), r2: Resource.nullable(), images: z.array(Resource).max(50), container: Resource.nullable() });
const Policy = z.strictObject({ scenarioId: ScenarioId, id: Resource, hostname: z.hostname(), path: z.string().regex(/^\/[A-Za-z0-9/_-]*$/), action: Resource, enabled: z.boolean(), priority: z.number().int().nonnegative(), baselineExcluded: z.boolean(), functionalDigest: Digest });
export const DeploymentStateSchema = z.strictObject({
  releaseDigest: Digest, containerDigest: Digest, inventoryDigest: Digest,
  manifestDigest: Digest, bindings: z.strictObject({ before: Bindings, after: Bindings }),
  policies: z.array(Policy).max(11), evidencePermissions: z.array(ScenarioId).max(11),
  publicImages: PublicVariantFunctionalSchema.optional(),
});
export type DeploymentState = z.infer<typeof DeploymentStateSchema>;
export const DeploymentReadbackSchema = z.strictObject({ state: DeploymentStateSchema, observedAt: Time });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export function deploymentFingerprint(value: DeploymentState): string {
  const state = DeploymentStateSchema.parse(value);
  state.policies.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  state.evidencePermissions.sort(); state.bindings.before.images.sort(); state.bindings.after.images.sort();
  if (new Set(state.policies.map(p => p.scenarioId)).size !== state.policies.length || new Set(state.evidencePermissions).size !== state.evidencePermissions.length) throw new Error('Duplicate deployment state entry');
  return createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
}
export const DeploymentOperationSchema = z.strictObject({
  role: Role, service: z.enum(['d1', 'r2', 'images', 'container']), operation: z.enum(['read', 'write-read', 'decode', 'execute', 'isolation']),
  resourceId: Resource, runId: Id, requestId: Id, releaseDigest: Digest, contentDigest: Digest,
  observedAt: Time, source: z.enum(['service-operation', 'observed-browser']), success: z.boolean(), evidence: EvidenceRefSchema,
  imageVariant: Resource.optional(), imageDelivery: ImageDeliveryReadbackSchema.optional(),
});
export type DeploymentOperation = z.infer<typeof DeploymentOperationSchema>;
export const DeploymentProbeSchema = z.strictObject({
  role: Role, hostname: z.hostname(), tlsValid: z.boolean(), status: z.number().int().min(100).max(599),
  releaseDigest: Digest.nullable(), runId: Id, requestId: Id, startedAt: Time, finishedAt: Time,
  coverage: CoverageSchema, receipts: z.array(ReceiptSchema).max(100),
  operations: z.array(DeploymentOperationSchema).max(100),
});
export type DeploymentProbe = z.infer<typeof DeploymentProbeSchema>;
export interface DeploymentVerification {
  schemaVersion: 1; mode: 'live' | 'fixture'; observedAt: string;
  hostnames: string[]; beforeFingerprint: string | null; afterFingerprint: string | null;
  beforeObservedAt: string | null; afterObservedAt: string | null;
  deploymentVerified: boolean; historical: boolean; blockers: string[];
  checks: { id: string; passed: boolean }[]; probes: DeploymentProbe[];
  requestsUsed: number; durationMs: number;
  /** Actual in-memory source records for generated operation references. */
  artifacts?: Artifact[];
  publicVariantProofs?: PublicVariantProof[];
}
export function evaluateDeployment(input: {
  mode: 'live' | 'fixture'; expected: DeploymentState; before: DeploymentState | null; after: DeploymentState | null;
  config: LabConfig; probes: readonly DeploymentProbe[]; observedAt: string; startedAt: string;
  policyCaptures?: readonly ScenarioCapture[];
  verificationRunId?: string; publicVariantProofs?: readonly PublicVariantProof[];
  beforeObservedAt: string | null; afterObservedAt: string | null;
}): DeploymentVerification {
  const expected = DeploymentStateSchema.parse(input.expected); const config = validateLabConfigShape(input.config);
  Time.parse(input.observedAt); Time.parse(input.startedAt); z.enum(['live', 'fixture']).parse(input.mode);
  const probes = input.probes.map(p => DeploymentProbeSchema.parse(p));
  const checks: DeploymentVerification['checks'] = [];
  const check = (id: string, passed: boolean) => { checks.push({ id, passed }); };
  const publicMode = config.imageVariant !== undefined;
  const rawProofs = input.publicVariantProofs ?? [];
  const parsedProofs = z.array(PublicVariantProofSchema).length(2).safeParse(rawProofs);
  const allReadIds = parsedProofs.success ? rawProofs.flatMap(proof => [proof.readId, ...proof.assetReads.map(read => read.readId)]) : [];
  const currentProof = (phase: 'before' | 'after'): PublicVariantProof | null => {
    if (!parsedProofs.success || new Set(allReadIds).size !== 6 || !Id.safeParse(input.verificationRunId).success) return null;
    const candidates = rawProofs.filter(proof => proof.phase === phase); const proof = candidates[0];
    if (candidates.length !== 1 || !proof || !isObservedPublicVariantProof(proof) || proof.runId !== input.verificationRunId
      || proof.accountId !== config.accountId || proof.labId !== config.labId || proof.mode !== input.mode || proof.startedAt !== input.startedAt) return null;
    const start = Date.parse(input.startedAt); const end = Date.parse(input.observedAt); const at = Date.parse(proof.observedAt);
    const stateAt = phase === 'before' ? input.beforeObservedAt : input.afterObservedAt;
    if (!stateAt || end - start > 120000 || at < start || at > end || at > Date.parse(stateAt)) return null;
    const edge = phase === 'before' ? Math.min(...probes.map(probe => Date.parse(probe.startedAt)), end) : Math.max(...probes.map(probe => Date.parse(probe.finishedAt)), start);
    if (phase === 'before' ? at > edge : [proof.variantObservedAt, ...proof.assetReads.map(read => read.observedAt)].some(time => Date.parse(time) < edge)) return null;
    return proof;
  };
  const publicBefore = publicMode ? currentProof('before') : null; const publicAfter = publicMode ? currentProof('after') : null;
  const observedState = (state: DeploymentState | null, proof: PublicVariantProof | null) => state === null || publicMode && !proof ? null
    : publicMode ? { ...DeploymentStateSchema.parse(state), publicImages: proof!.functional } : state;
  const fingerprint = (state: DeploymentState | null) => state === null ? null : deploymentFingerprint(state);
  const beforeFingerprint = fingerprint(observedState(input.before, publicBefore)); const afterFingerprint = fingerprint(observedState(input.after, publicAfter));
  if (publicMode) {
    const expectedVariant = JSON.stringify(canonical(config.imageVariant));
    for (const [phase, proof] of [['before', publicBefore], ['after', publicAfter]] as const) {
      check(`public-variant-${phase}`, !!proof && JSON.stringify(canonical(proof.functional.variant)) === expectedVariant);
      for (const env of config.environments) {
        const asset = proof?.functional.assets.find(asset => asset.role === env.role);
        check(`${env.role}-public-asset-${phase}`, !!asset && asset.workerName === env.workerName && asset.origin === env.origin
          && asset.releaseDigest === env.releaseDigest && env.imageIds.length === 1 && asset.imageId === env.imageIds[0] && asset.variant === selectedImageVariantId(config.labId, config.imageVariant));
      }
    }
    check('public-variant-stable', !!publicBefore && !!publicAfter && JSON.stringify(canonical(publicBefore.functional)) === JSON.stringify(canonical(publicAfter.functional)));
  }
  check('current-observed-state', beforeFingerprint !== null && afterFingerprint !== null);
  check('matching-functional-state', beforeFingerprint === deploymentFingerprint(expected) && afterFingerprint === beforeFingerprint);
  check('observation-window', Date.parse(input.observedAt) >= Date.parse(input.startedAt));
  const fresh = input.beforeObservedAt !== null && input.afterObservedAt !== null && Time.safeParse(input.beforeObservedAt).success && Time.safeParse(input.afterObservedAt).success && input.beforeObservedAt >= input.startedAt && input.afterObservedAt >= input.beforeObservedAt && input.afterObservedAt <= input.observedAt;
  check('fresh-readback-times', fresh);
  const bracketed = fresh && input.before !== null && input.after !== null && probes.length > 0
    && Date.parse(input.beforeObservedAt!) <= Math.min(...probes.map(probe => Date.parse(probe.startedAt)))
    && Date.parse(input.afterObservedAt!) >= Math.max(...probes.map(probe => Date.parse(probe.finishedAt)));
  check('readback-brackets-probes', bracketed);
  const publicDecodeMatches = (operation: DeploymentOperation, role: 'before' | 'after') => {
    if (!publicMode) return true;
    const delivery = operation.imageDelivery;
    if (!delivery || operation.resourceId !== delivery.resourceId || operation.imageVariant !== delivery.variant || operation.contentDigest !== delivery.encodedDigest) return false;
    return [publicBefore, publicAfter].every(proof => {
      const asset = proof?.functional.assets.find(asset => asset.role === role);
      return !!asset && delivery.deliveryOrigin === asset.deliveryOrigin && delivery.accountHash === asset.accountHash
        && delivery.resourceId === asset.imageId && delivery.variant === asset.variant && delivery.encodedDigest === asset.expectedDigest;
    });
  };
  for (const policy of expected.policies) {
    check(`${policy.scenarioId}-scope`, policy.hostname === new URL(config.environments[1].origin).hostname && policy.baselineExcluded && policy.enabled && expected.evidencePermissions.includes(policy.scenarioId));
    const captures = (input.policyCaptures ?? []).filter(c => c.report.result.scenarioId === policy.scenarioId);
    let behavioral = false;
    try {
      const capture = captures.length === 1 ? validateCapture(captures[0]!, policy.scenarioId, input.mode) : null;
      behavioral = !!capture && capture.report.result.outcome === 'verified' && capture.report.result.cleanup !== 'incomplete' && capture.report.result.releaseDigest === expected.releaseDigest && capture.report.result.observedConfigDigest === policy.functionalDigest && capture.report.result.startedAt >= input.startedAt && capture.report.result.finishedAt <= input.observedAt;
    } catch { /* Invalid evidence blocks readiness. */ }
    check(`${policy.scenarioId}-behavior`, behavioral);
  }
  for (const env of config.environments) {
    const candidates = probes.filter(p => p.role === env.role); const p = candidates[0]; const b = expected.bindings[env.role];
    check(`${env.role}-bindings`, b.d1 === env.d1Id && b.r2 === env.r2Bucket && b.container === env.containerBinding && env.imageIds.every(id => b.images.includes(id)) && b.images.length === env.imageIds.length);
    check(`${env.role}-https-release`, candidates.length === 1 && !!p && p.hostname === new URL(env.origin).hostname && p.tlsValid && p.status === 200 && p.releaseDigest === env.releaseDigest && expected.releaseDigest === env.releaseDigest);
    const window = !!p && p.startedAt >= input.startedAt && p.finishedAt <= input.observedAt && p.startedAt <= p.finishedAt;
    check(`${env.role}-probe-window`, window);
    const receipt = p?.receipts.some(r => r.targetRole === env.role && r.runId === p.runId && r.requestId === p.requestId && r.scenarioId === 'waf-custom' && r.stage === 'entry' && r.releaseDigest === env.releaseDigest && r.observedAt >= p.startedAt && r.observedAt <= p.finishedAt);
    check(`${env.role}-container-receipt`, !!receipt);
    check(`${env.role}-telemetry`, !!p && p.coverage.healthy && p.coverage.complete && p.coverage.gaps.length === 0 && p.coverage.producerSequence !== null && p.coverage.watermark !== null && p.coverage.windowStart <= p.startedAt && p.coverage.watermark >= p.finishedAt);
    for (const [service, operations] of [['d1', ['read', 'write-read', 'isolation']], ['r2', ['read', 'write-read', 'isolation']], ['images', ['decode']], ['container', ['execute', 'isolation']]] as const) {
      for (const operation of operations) {
        const valid = p?.operations.filter(o => o.service === service && o.operation === operation && o.success && o.role === env.role && o.runId === p.runId && o.releaseDigest === env.releaseDigest && o.observedAt >= p.startedAt && o.observedAt <= p.finishedAt && o.evidence.runId === p.runId && o.evidence.requestId === o.requestId && o.evidence.targetRole === env.role && o.evidence.mode === input.mode && o.evidence.observedAt === o.observedAt && o.evidence.scenarioId === 'waf-custom' && o.evidence.source === (service === 'images' ? 'browser' : 'verification') && o.source === (service === 'images' ? 'observed-browser' : 'service-operation') && (service === 'images' ? env.imageIds.includes(o.resourceId) && (!publicMode || o.imageVariant === selectedImageVariantId(config.labId, config.imageVariant) && publicDecodeMatches(o, env.role)) : o.resourceId === b[service]));
        check(`${env.role}-${service}-${operation}`, !!valid?.length);
      }
    }
  }
  const before = probes.find(p => p.role === 'before'); const after = probes.find(p => p.role === 'after');
  for (const service of ['d1', 'r2', 'images'] as const) {
    const a = before?.operations.find(o => o.service === service && o.operation === (service === 'images' ? 'decode' : 'read') && o.success);
    const b = after?.operations.find(o => o.service === service && o.operation === (service === 'images' ? 'decode' : 'read') && o.success);
    check(`${service}-content-parity`, !!a && !!b && a.contentDigest === b.contentDigest);
  }
  const blockers = checks.filter(c => !c.passed).map(c => c.id);
  return { schemaVersion: 1, mode: input.mode, observedAt: input.observedAt, hostnames: config.environments.map(e => new URL(e.origin).hostname),
    beforeFingerprint, afterFingerprint, beforeObservedAt: input.beforeObservedAt, afterObservedAt: input.afterObservedAt, deploymentVerified: input.mode === 'live' && blockers.length === 0,
    historical: publicMode && checks.some(check => !check.passed && /public/.test(check.id)) || !fresh || !bracketed || beforeFingerprint === null || afterFingerprint === null || beforeFingerprint !== afterFingerprint || beforeFingerprint !== deploymentFingerprint(expected),
    blockers, checks, probes, requestsUsed: 0, durationMs: 0 };
}
// Parsing does not inspect the filesystem; collection validates the configured root.
import { LabConfigSchema } from './config.js';
function validateLabConfigShape(config: LabConfig): LabConfig { return LabConfigSchema.parse(config); }
const OriginRead = z.strictObject({ schemaVersion: z.literal(1), targetRole: Role, runId: Id, scenarioId: z.literal('waf-custom'), originCount: z.number().int().nonnegative().nullable(), receipts: z.array(ReceiptSchema).max(100), coverage: CoverageSchema });
export interface DeploymentProbeOptions {
  projectRoot: string; config: LabConfig; observedOwnedResources: ReadonlySet<string>;
  expected: DeploymentState; mode: 'live' | 'fixture'; credentials: { runner: string; collector: string; reader?: string };
  /** Authorized full functional readback. Public dependency reads are independently
   * collected from the reader credential, never synthesized by this adapter. */
  inspect?(client: GuardedClient, signal: AbortSignal, context: { runId: string; phase: 'before' | 'after'; startedAt: string }): Promise<unknown>;
  /** Return trusted run-scoped service-operation and browser records. No setup writer. */
  operations?(context: { client: GuardedClient; ledger: BudgetLedger; role: 'before' | 'after'; runId: string; requestId: string; signal: AbortSignal }): Promise<readonly DeploymentOperation[]>;
  plannedRequests: number; policyCaptures?: readonly ScenarioCapture[]; limits?: Partial<Limits>; parent?: BudgetLedger; clock?: Clock;
  dispatch?: Dispatch; signal?: AbortSignal; now?: () => number;
}
export async function collectDeploymentVerification(options: DeploymentProbeOptions): Promise<DeploymentVerification> {
  validateLabConfig(options.config, options.projectRoot); assertLiveReady(options.config, options.observedOwnedResources);
  z.enum(['live', 'fixture']).parse(options.mode);
  if (options.mode === 'fixture' && !options.dispatch) throw new Error('Fixture deployment probes require injected dispatch');
  const credentials = z.strictObject({ runner: z.string().min(24), collector: z.string().min(24), reader: z.string().min(24).optional() }).parse(options.credentials);
  if (credentials.runner === credentials.collector) throw new Error('Separate runner and collector credentials required');
  const ledger = new BudgetLedger({ ...(options.limits ? { limits: options.limits } : {}), ...(options.parent ? { parent: options.parent } : {}), ...(options.clock ? { clock: options.clock } : {}) });
  const start = ledger.clock.now(); const now = options.now ?? Date.now; const iso = () => new Date(now()).toISOString(); const startedAt = iso();
  const signal = options.signal ? AbortSignal.any([ledger.signal, options.signal]) : ledger.signal;
  try {
    validatePlan(ledger.limits, options.plannedRequests, 0); if (options.plannedRequests < 8) throw new Error('Plan omits required pair or fingerprint reads');
    const publicMode = options.config.imageVariant !== undefined;
    if (publicMode) {
      const base = Math.max(8, options.inspect ? 0 : options.credentials.reader ? 14 : 10, !options.operations && options.credentials.reader ? options.inspect ? 16 : 22 : 0);
      if (options.plannedRequests < base + 6) throw new Error('Plan omits six required public dependency and asset reads');
      if (!credentials.reader) throw new Error('Public verification requires an actual reader credential for fresh dependency observations');
    }
    signal.throwIfAborted();
    const client = new GuardedClient(options.config, ledger, { observedOwnedResources: options.observedOwnedResources, ...(options.dispatch ? { dispatch: options.dispatch } : {}), redactor: new Redactor(Object.values(credentials).filter((value): value is string => typeof value === 'string')) });
    const collectors = options.credentials.reader ? createTrustedCollectors({ config: options.config, ledger, observedOwnedResources: options.observedOwnedResources, mode: options.mode, credentials: { ...credentials, reader: options.credentials.reader }, dispatch: options.dispatch ?? ((url, init) => fetch(url, init)), maxReads: 100, now }) : null;
    const artifacts: Artifact[] = []; const fingerprintRunId = randomUUID();
    const publicProofs: PublicVariantProof[] = [];
    const partials: { before: WorkerReadback[]; after: WorkerReadback[] } = { before: [], after: [] };
    if (!options.inspect && options.plannedRequests < (collectors ? 14 : 10)) throw new Error('Default collector plan omits functional readbacks');
    if (!options.operations && collectors && options.plannedRequests < (options.inspect ? 16 : 22)) throw new Error('Default collector plan omits image binding and decode reads');
    const inspect = async (phase: 'before' | 'after') => {
      const context = { runId: fingerprintRunId, phase, startedAt };
      if (publicMode && collectors) {
        const read = await collectors.publicVariantProof(context, signal);
        if (read.value) {
          publicProofs.push(read.value);
          artifacts.push(makeArtifact({ id: randomUUID(), mode: options.mode, runId: fingerprintRunId, scenarioId: 'waf-custom', targetRole: 'before',
            requestId: null, observedAt: read.value.observedAt, source: 'cloudflare', payload: read.value }).artifact);
        }
      }
      try {
        if (options.inspect) {
          const observed = DeploymentReadbackSchema.parse(await options.inspect(client, signal, context));
          const proof = publicProofs.find(proof => proof.phase === phase);
          return { ...observed, state: proof ? { ...observed.state, publicImages: proof.functional } : observed.state };
        }
        if (collectors) for (const role of ['before', 'after'] as const) {
          const bindings = await collectors.workerBindings(role, signal);
          const code = await collectors.workerCode(role, signal);
          const env = options.config.environments.find(env => env.role === role)!;
          const snapshot = captureWorkerReadback({ runId: fingerprintRunId, mode: options.mode, phase, targetRole: role,
            accountId: options.config.accountId, workerName: env.workerName, startedAt, observedAt: iso() }, bindings, code);
          partials[phase].push(snapshot);
          artifacts.push(makeArtifact({ id: randomUUID(), mode: options.mode, runId: fingerprintRunId, scenarioId: 'waf-custom', targetRole: role,
            requestId: null, observedAt: snapshot.observedAt, source: 'cloudflare', payload: snapshot }).artifact);
          if (code.state === 'observed' && code.value) artifacts.push(makeArtifact({ id: randomUUID(), mode: options.mode,
            runId: fingerprintRunId, scenarioId: 'waf-custom', targetRole: role, requestId: null,
            observedAt: code.value.observedAt, source: 'cloudflare', payload: code.value }).artifact);
        }
        // Worker settings cannot attest the running Container digest, release or
        // evidence permissions. Never fill these from desired configuration.
        return null;
      } catch { return null; }
    };
    const before = await inspect('before'); const probes: DeploymentProbe[] = [];
    for (const env of options.config.environments) {
      if (signal.aborted) break;
      try {
        const runId = randomUUID(); const requestId = randomUUID(); const probeStart = iso();
        if (!options.operations && collectors) {
          const read = await collectors.serviceRead({ role: env.role, hostname: new URL(env.origin).hostname, runId, requestId, scenarioId: 'waf-custom', releaseDigest: env.releaseDigest, start: probeStart, end: iso() }, signal);
          if (read.state !== 'observed' || !read.value?.container?.requestCompleted) continue;
          const value = read.value; const operations: DeploymentOperation[] = [];
          for (const op of value.operations) {
            if (!op.resourceId) continue;
            const captured = makeArtifact({ id: randomUUID(), mode: options.mode, runId, scenarioId: 'waf-custom', targetRole: env.role, requestId, observedAt: value.receipt.observedAt, source: 'verification', payload: { kind: 'service-read', receipt: value.receipt } });
            artifacts.push(captured.artifact);
            operations.push(DeploymentOperationSchema.parse({ role: env.role, service: op.service, operation: op.operation, resourceId: op.resourceId, runId, requestId, releaseDigest: env.releaseDigest, contentDigest: op.contentDigest, observedAt: value.receipt.observedAt, source: 'service-operation', success: true, evidence: captured.ref }));
          }
          const asset = await collectors.imageAsset(env.role, signal);
          if (asset.state === 'observed' && asset.value) {
            const image = asset.value;
            const decoded = await collectTrustedImage({ config: options.config, ledger, observedOwnedResources: options.observedOwnedResources, mode: options.mode, credentials: { ...credentials, reader: options.credentials.reader! }, dispatch: options.dispatch ?? ((url, init) => fetch(url, init)), now },
              { role: env.role, runId, requestId, scenarioId: 'waf-custom', releaseDigest: env.releaseDigest, resourceId: image.id, deliveryAccount: image.accountHash, variant: image.variant }, signal);
            if (decoded.state === 'observed' && decoded.value && decoded.value.encodedDigest === image.expectedDigest) {
              const captured = makeArtifact({ id: randomUUID(), mode: options.mode, runId, scenarioId: 'waf-custom', targetRole: env.role, requestId, observedAt: decoded.observedAt, source: 'browser', payload: { kind: 'owned-image-decode', ...decoded.value } });
              artifacts.push(captured.artifact);
              operations.push(DeploymentOperationSchema.parse({ role: env.role, service: 'images', operation: 'decode', resourceId: decoded.value.resourceId, runId, requestId, releaseDigest: env.releaseDigest, contentDigest: decoded.value.encodedDigest, imageVariant: decoded.value.variant, imageDelivery: decoded.value.delivery, observedAt: decoded.observedAt, source: 'observed-browser', success: true, evidence: captured.ref }));
            }
          }
          // Image delivery extends the probe window. Re-read the trusted producer
          // watermark rather than stretching an earlier coverage assertion.
          const finishedAt = iso();
          const finalOrigin = await collectors.origin({ ...value.scope, end: finishedAt }, signal);
          probes.push(DeploymentProbeSchema.parse({ role: env.role, hostname: new URL(env.origin).hostname, tlsValid: true, status: value.status, releaseDigest: env.releaseDigest, runId, requestId, startedAt: probeStart, finishedAt, coverage: finalOrigin.state === 'observed' && finalOrigin.value ? finalOrigin.value.coverage : { ...value.container!.coverage, healthy: false, complete: false }, receipts: finalOrigin.value?.receipts ?? value.container!.receipts, operations }));
          continue;
        }
        const headers = { 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': credentials.runner };
        const response = await client.request({ url: `${env.origin}/catalog`, kind: env.role, headers }, signal);
        const operations = options.operations ? await options.operations({ client, ledger, role: env.role, runId, requestId, signal }) : [];
        const finishedAt = iso();
        const checkpoint = await client.request({ url: `${env.origin}/internal/checkpoint?${new URLSearchParams({ runId, scenarioId: 'waf-custom' })}`, kind: env.role, headers: { 'x-demo-run-token': credentials.runner } }, signal);
        if (checkpoint.status !== 200) throw new Error('Producer checkpoint unavailable');
        const receipt = await client.requestJson({ url: `${options.config.telemetryOrigin}/receipts?${new URLSearchParams({ role: env.role, runId, scenarioId: 'waf-custom', start: probeStart, end: finishedAt })}`, kind: 'telemetry', headers: { authorization: `Bearer ${credentials.collector}` } }, OriginRead, signal);
        if (receipt.status !== 200 || receipt.data.targetRole !== env.role || receipt.data.runId !== runId) throw new Error('Receipt scope mismatch');
        probes.push(DeploymentProbeSchema.parse({ role: env.role, hostname: new URL(env.origin).hostname, tlsValid: response.metadata.role === env.role, status: response.status, releaseDigest: response.metadata.releaseDigest, runId, requestId, startedAt: probeStart, finishedAt, coverage: receipt.data.coverage, receipts: receipt.data.receipts, operations }));
      } catch { /* Missing or aborted probes stay missing; never zero or passed. */ }
    }
    const after = await inspect('after');
    const result = evaluateDeployment({ mode: options.mode, expected: options.expected, before: before?.state ?? null, after: after?.state ?? null, beforeObservedAt: before?.observedAt ?? publicProofs.find(proof => proof.phase === 'before')?.observedAt ?? null, afterObservedAt: after?.observedAt ?? publicProofs.find(proof => proof.phase === 'after')?.observedAt ?? null, verificationRunId: fingerprintRunId, publicVariantProofs: publicProofs, config: options.config, probes, observedAt: iso(), startedAt, ...(options.policyCaptures ? { policyCaptures: options.policyCaptures } : {}) });
    if (!options.inspect && collectors) for (const role of ['before', 'after'] as const) {
      const a = partials.before.find(row => row.targetRole === role); const b = partials.after.find(row => row.targetRole === role);
      const checks = a && b ? compareWorkerReadbacks(a, b) : ['readback-available', 'code-unchanged', 'bindings-unchanged'].map(suffix => ({ id: `${role}-worker-${suffix}`, passed: false }));
      result.checks.push(...checks);
      if (checks.some(check => !check.passed)) { result.deploymentVerified = false; result.historical = true; result.blockers.push(...checks.filter(check => !check.passed).map(check => check.id)); }
    }
    if (signal.aborted) { result.blockers.push('Deployment verification cancelled'); result.deploymentVerified = false; }
    result.requestsUsed = ledger.snapshot.requestsUsed; result.durationMs = ledger.clock.now() - start; result.artifacts = artifacts;
    if (publicMode) result.publicVariantProofs = publicProofs;
    return result;
  } finally { ledger.stop('Deployment verification finished'); }
}
