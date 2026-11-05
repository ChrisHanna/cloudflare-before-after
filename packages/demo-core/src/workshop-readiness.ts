import { CATALOG } from '../../../scenarios/catalog.js';
import type { LabConfig } from './config.js';
import { digestValue } from './deployment-plan.js';
import { evaluateDeployment, type DeploymentState } from './deployment-verification-core.js';
import { buildReadinessReport, ReadinessRecordStore, type ReadinessReport } from './readiness-report-core.js';
import type { AggregateRun } from './workshop-aggregation.js';

/** Desired bindings are NOT readback. Missing deployed collectors remain failed
 * checks rather than disappearing from the command-center readiness screen. */
export function saveAggregateReadiness(projectRoot: string, config: LabConfig, run: AggregateRun): { report: ReadinessReport; path: string } {
  const observedAt = new Date().toISOString();
  const bindings = (role: 'before' | 'after') => { const env = config.environments.find(e => e.role === role)!; return { d1: env.d1Id, r2: env.r2Bucket, images: env.imageIds, container: env.containerBinding }; };
  const state: DeploymentState = { releaseDigest: config.environments[0].releaseDigest, containerDigest: config.environments[0].releaseDigest, inventoryDigest: digestValue(config.inventory), manifestDigest: digestValue(CATALOG), bindings: { before: bindings('before'), after: bindings('after') }, policies: [], evidencePermissions: [] };
  const deployment = run.deployment ?? evaluateDeployment({ mode: run.mode, expected: state, before: null, after: null, config, probes: [], startedAt: observedAt, observedAt, beforeObservedAt: null, afterObservedAt: null });
  const captures = run.items.flatMap(item => item.capture ? [item.capture] : []);
  const includedModules = run.items.filter(item => item.capture?.report.result.observedConfigDigest).map(item => item.scenarioId);
  const report = buildReadinessReport({ mode: run.mode, scope: 'workshop', observedAt, releaseDigest: state.releaseDigest, configurationDigest: deployment.afterFingerprint ?? digestValue(state), hostnames: config.environments.map(e => new URL(e.origin).hostname) as [string, string], includedModules, excludedModules: run.items.filter(item => !includedModules.includes(item.scenarioId)).map(item => ({ scenarioId: item.scenarioId, reason: item.reason ?? 'Current policy readback is missing' })),
    core: { appliedInventoryDigest: null, observedInventoryDigest: null, reachableRoles: [] }, deployment, captures,
    currentScenarioDigests: Object.fromEntries(captures.filter(c => c.report.result.observedConfigDigest).map(c => [c.report.result.scenarioId, c.report.result.observedConfigDigest!])),
    ...(run.interview ? { interview: run.interview } : {}), setupMutations: 0, measured: { requestsUsed: run.requestsUsed, durationMs: run.durationMs },
  });
  return { report, path: new ReadinessRecordStore(projectRoot, config.evidenceDirectory).save(report, []) };
}
