import { randomUUID } from 'node:crypto';
import { CATALOG } from '../scenarios/catalog.js';
import type { Manifest } from '../packages/contracts/src/schemas.js';
import { makeArtifact } from '../packages/demo-core/src/reports.js';
import type { SequenceDriver, ScenarioCapture } from '../packages/demo-core/src/workshop-aggregation.js';
import type { DeploymentState, DeploymentProbe, DeploymentOperation } from '../packages/demo-core/src/deployment-verification-core.js';
import { labConfig } from './fixtures/lab.js';
export const time = '2026-11-04T00:00:00.000Z';
export const end = '2026-11-04T00:01:00.000Z';
export const digest = 'a'.repeat(64);
export function captureFor(id: Manifest['id'], mode: 'live' | 'fixture' = 'fixture', outcome: ScenarioCapture['report']['result']['outcome'] = 'verified', requestsUsed = 1): ScenarioCapture {
  const runId = randomUUID(); const requestId = randomUUID(); const artifactId = randomUUID();
  const observation = { schemaVersion: 1 as const, id: artifactId, runId, requestId, scenarioId: id, mode, targetRole: 'before' as const, observedAt: time, method: 'GET' as const, path: '/catalog', status: 200, latencyMs: 1, rayId: null, action: null, ruleId: null, originCount: null, excerpt: 'Synthetic fixture' };
  const artifact = makeArtifact({ id: artifactId, runId, requestId, scenarioId: id, mode, targetRole: 'before', observedAt: time, source: 'http', payload: observation });
  return { artifacts: [artifact.artifact], report: { schemaVersion: 1, mode, manifestVersion: 1, createdAt: time,
    result: { schemaVersion: 1, runId, scenarioId: id, outcome, missingProof: outcome === 'verified' ? [] : ['Synthetic missing proof'], contradictions: outcome === 'failed' ? ['Synthetic contradiction'] : [], evidence: [artifact.ref], releaseDigest: digest, observedConfigDigest: digest,
      startedAt: time, finishedAt: end, requestsUsed, peakConcurrency: 1, sessionsUsed: 0, cleanup: 'complete' },
    notes: CATALOG.find(m => m.id === id)!.notes } };
}
export function meteredDriver(id: Manifest['id'], outcome: ScenarioCapture['report']['result']['outcome'] = 'verified', used = 1): SequenceDriver {
  return { minimumRequests: 0, run: async ({ parent, signal }) => {
    for (let i = 0; i < used; i++) (await parent.acquire(signal))();
    return captureFor(id, 'fixture', outcome, used);
  } };
}
export function deploymentFixture() {
  const config = labConfig();
  const state: DeploymentState = { releaseDigest: config.environments[0].releaseDigest, containerDigest: digest, inventoryDigest: digest, manifestDigest: digest,
    bindings: Object.fromEntries(config.environments.map(e => [e.role, { d1: e.d1Id, r2: e.r2Bucket, images: e.imageIds, container: e.containerBinding }])) as DeploymentState['bindings'], policies: [], evidencePermissions: [] };
  const probes: DeploymentProbe[] = config.environments.map(env => {
    const runId = randomUUID(); const requestId = randomUUID();
    const operations: DeploymentOperation[] = [];
    for (const [service, actions] of [['d1', ['read', 'write-read', 'isolation']], ['r2', ['read', 'write-read', 'isolation']], ['images', ['decode']], ['container', ['execute', 'isolation']]] as const) for (const operation of actions) {
      operations.push({ role: env.role, service, operation, resourceId: service === 'images' ? env.imageIds[0]! : state.bindings[env.role][service]!, runId, requestId, releaseDigest: env.releaseDigest, contentDigest: digest,
        observedAt: time, source: service === 'images' ? 'observed-browser' : 'service-operation', success: true,
        evidence: { id: randomUUID(), source: service === 'images' ? 'browser' : 'verification', mode: 'fixture', observedAt: time, runId, scenarioId: 'waf-custom', targetRole: env.role, requestId, rayId: null, artifactDigest: digest } });
    }
    return { role: env.role, hostname: new URL(env.origin).hostname, tlsValid: true, status: 200, releaseDigest: env.releaseDigest, runId, requestId, startedAt: time, finishedAt: end,
      coverage: { healthy: true, complete: true, windowStart: time, watermark: end, producerSequence: 1, gaps: [] },
      receipts: [{ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waf-custom', targetRole: env.role, producerId: `${env.role}-container`, sequence: 1, observedAt: time, rayId: null, releaseDigest: env.releaseDigest, stage: 'entry' }], operations };
  });
  return { config, state, probes };
}
