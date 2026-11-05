import { z } from 'zod';
import { DeploymentToolError, ToolFailureSchema, terraformFailure } from './deployment-diagnostics.js';
import { assertCredentialSeparation } from './credential-policy.js';
import { createExecutionAudit, type ExecutionAudit } from './execution-audit.js';
import { PlanSchema, IntentSchema, assessCost, deploymentSteps, digestValue, PLAN_LIFETIME_MS, type DeploymentIntent, type DeploymentPlan, type DeploymentStep } from './deployment-plan.js';
import { SnapshotSchema, capabilityDigest, type CapabilitySnapshot } from './capabilities.js';
import { DeploymentStore, type ApplyRecord } from './deployment-store.js';
import { LabLease } from './lifecycle.js';
import { realClock, type Clock } from './budget.js';
export interface SetupContext {
  readonly signal: AbortSignal;
  readonly plan: DeploymentPlan;
  perform<T>(kind: string, ownedId: string, action: () => Promise<T>): Promise<T>;
  observeResource(kind: string, ownedId: string): void;
}
export interface SetupExecutor {
  readonly mode: 'live' | 'fixture';
  execute(step: DeploymentStep, context: SetupContext): Promise<void>;
  close(): Promise<void>;
}
export interface ApplyEnvironment {
  intent: DeploymentIntent; capability: CapabilitySnapshot; sourceDigest: string;
  credentials: { reader: string; collector: string; deployer: string };
  createExecutor(plan: DeploymentPlan, audit: ExecutionAudit): Promise<SetupExecutor>;
  audit?: ExecutionAudit;
  now?: () => number; clock?: Clock; signal?: AbortSignal;
}
const OwnedIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/);
const Kind = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
export async function applyReviewedPlan(store: DeploymentStore, path: string, environment: ApplyEnvironment): Promise<ApplyRecord> {
  const now = environment.now ?? Date.now; const clock = environment.clock ?? realClock;
  const { plan: loaded, digest } = store.load(path); const plan = PlanSchema.parse(loaded);
  const intent = IntentSchema.parse(environment.intent); const snapshot = SnapshotSchema.parse(environment.capability);
  const currentTime = now();
  if (currentTime < Date.parse(plan.createdAt) || currentTime >= Date.parse(plan.expiresAt) || currentTime - Date.parse(plan.createdAt) > PLAN_LIFETIME_MS) throw new Error('Saved plan expired or clock invalid; create a new plan');
  if (plan.status !== 'review-required' || plan.blockers.length || !snapshot.deployable || snapshot.blockers.length) throw new Error('Deployment prerequisites are unresolved');
  if (snapshot.mode !== plan.mode || snapshot.accountId !== intent.discovery.accountId || snapshot.zoneId !== intent.discovery.zoneId || snapshot.profile !== intent.profile) throw new Error('Capability scope changed');
  if (now() - Date.parse(snapshot.observedAt) > PLAN_LIFETIME_MS || Date.parse(snapshot.observedAt) > now()) throw new Error('Rechecked capabilities are stale');
  if (capabilityDigest(snapshot) !== plan.capabilityDigest || digestValue(intent) !== plan.intentDigest || environment.sourceDigest !== plan.sourceDigest) throw new Error('Capability, desired configuration or source drift requires a new plan');
  if (assessCost(intent.costs, now()).blockers.length || digestValue(assessCost(intent.costs, now())) !== digestValue(plan.cost)) throw new Error('Monthly cost allowance is unresolved or changed');
  if (digestValue(plan.steps) !== digestValue(deploymentSteps(intent, snapshot))) throw new Error('Saved operation list differs from the declared owned-resource plan');
  if (digestValue(plan.includedModules) !== digestValue(snapshot.includedModules) || digestValue(plan.excludedModules) !== digestValue(snapshot.excludedModules)) throw new Error('Selected module scope changed');
  if (plan.mode === 'live' && plan.includedModules.includes('waf-custom') && !plan.productStates.some(s => s.module === 'waf-custom' && s.owned)) throw new Error('Required owned product readback is missing');
  if (!intent.discovery.liveOptIn && plan.mode === 'live') throw new Error('Explicit live setup opt-in required');
  const secrets = Object.values(environment.credentials);
  if (secrets.some(value => value.length < 24)) throw new Error('Resolved API credentials and separate collector secret required');
  assertCredentialSeparation(environment.credentials, intent.discovery.credentials.apiTokenMode === 'shared');
  if (environment.signal?.aborted) throw new DeploymentToolError(terraformFailure('', null, true));
  store.approval(plan, digest, now());
  const claim = LabLease.claim({ projectRoot: store.projectRoot, evidenceDirectory: store.evidenceDirectory, labId: intent.discovery.labId, idempotencyKey: plan.id });
  if (claim.kind !== 'claimed') throw new Error('Deployment attempt already owns the lab; explicit recovery required');
  let record: ApplyRecord;
  try { record = store.begin(plan, digest, now()); }
  catch (error) { claim.lease.release(); throw error; }
  const controller = new AbortController(); const signal = AbortSignal.any([controller.signal, ...(environment.signal ? [environment.signal] : [])]);
  const deadline = clock.now() + intent.setup.maxRuntimeMs;
  const cancelTimer = clock.schedule(intent.setup.maxRuntimeMs, () => controller.abort(new Error('Setup deadline reached')));
  let operationCount = 0; let currentStep = ''; let executor: SetupExecutor | undefined;
  const pending = new Set<Promise<unknown>>();
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const stopError = () => new DeploymentToolError(terraformFailure('', null, true));
    pending.add(operation); void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    if (signal.aborted) throw stopError(); let remove = () => {};
    const stopped = new Promise<never>((_resolve, reject) => { const abort = () => reject(stopError()); signal.addEventListener('abort', abort, { once: true }); remove = () => signal.removeEventListener('abort', abort); if (signal.aborted) abort(); });
    try { return await Promise.race([operation, stopped]); } finally { remove(); }
  };
  const audit = environment.audit ?? createExecutionAudit({ runId: plan.id, releaseDigest: intent.releaseDigest, configurationDigest: plan.intentDigest, sourceDigest: plan.sourceDigest, mode: plan.mode, accountId: intent.discovery.accountId, zoneId: intent.discovery.zoneId }, { before: intent.discovery.environments[0].origin, after: intent.discovery.environments[1].origin, telemetry: intent.discovery.telemetryOrigin });
  const context: SetupContext = {
    signal, plan,
    observeResource(kind, ownedId) {
      Kind.parse(kind); OwnedIdentifier.parse(ownedId);
      if (!record.resources.some(r => r.kind === kind && r.id === ownedId && r.operationId === currentStep)) record.resources.push({ kind, id: ownedId, operationId: currentStep, certainty: 'confirmed' });
      store.update(record);
    },
    async perform<T>(kind: string, ownedId: string, action: () => Promise<T>): Promise<T> {
      signal.throwIfAborted(); Kind.parse(kind); OwnedIdentifier.parse(ownedId);
      if (clock.now() >= deadline || ++operationCount > intent.setup.maxOperations) throw new Error('Setup operation or time allowance exhausted');
      const resource = { kind, id: ownedId, operationId: currentStep, certainty: 'possible' as 'confirmed' | 'possible' };
      record.resources.push(resource); store.update(record);
      const result = await bounded(Promise.resolve().then(() => { signal.throwIfAborted(); return action(); }));
      resource.certainty = 'confirmed'; store.update(record); return result;
    },
  };
  try {
    executor = audit.hookSetupExecutor(await bounded(environment.createExecutor(plan, audit)));
    const auditedContext = audit.hookSetupContext(context);
    if (executor.mode !== plan.mode) throw new Error('Fixture plan cannot execute through a live provisioner');
    for (const step of plan.steps) {
      signal.throwIfAborted(); currentStep = step.id;
      await bounded(executor.execute(step, auditedContext));
      record.completedSteps.push(step.id); store.update(record);
    }
    await bounded(executor.close());
    record.status = 'succeeded'; record.finishedAt = new Date(now()).toISOString(); store.update(record);
    claim.lease.release();
  } catch (error) {
    // Capture an existing stop before aborting other work for an ordinary failure.
    const wasStopped = signal.aborted;
    controller.abort();
    if (wasStopped) record.toolFailure = terraformFailure('', null, true);
    else if (error instanceof DeploymentToolError) record.toolFailure = ToolFailureSchema.parse(error.failure);
    record.status = 'failed'; record.finishedAt = new Date(now()).toISOString(); record.failure = 'Setup stopped; inspect confirmed and possible owned-resource changes. A new reviewed plan and explicit lease recovery are required.';
    store.update(record);
    // No implicit rollback, retry, lease recovery or deletion of excluded modules.
    if (executor) void executor.close().catch(() => {});
  } finally { cancelTimer(); }
  return record;
}
