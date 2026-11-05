import { randomUUID } from 'node:crypto';
import { makeArtifact, type Artifact, type Report } from '../../packages/demo-core/src/reports.js';
import { Redactor } from '../../packages/contracts/src/redaction.js';
export function reportFixture(mode: 'live' | 'fixture' = 'fixture', redactor = new Redactor()) {
  const runId = randomUUID(); const requestId = randomUUID(); const id = randomUUID(); const time = '2026-11-04T00:00:00.000Z'; const digest = 'a'.repeat(64);
  const observation = { schemaVersion: 1 as const, id, runId, requestId, scenarioId: 'waf-custom' as const, targetRole: 'before' as const, mode, observedAt: time, method: 'GET' as const, path: '/catalog', status: 200, latencyMs: 1, rayId: null, action: null, ruleId: null, originCount: 1, excerpt: '' };
  const artifact: Artifact = { id, mode, runId, scenarioId: 'waf-custom', targetRole: 'before', requestId, observedAt: time, source: 'http', payload: observation };
  const built = makeArtifact(artifact, redactor);
  const report: Report = { schemaVersion: 1, mode, manifestVersion: 1, createdAt: time, result: { schemaVersion: 1, runId, scenarioId: 'waf-custom', outcome: 'verified', evidence: [built.ref], missingProof: [], contradictions: [], releaseDigest: digest, observedConfigDigest: digest, startedAt: time, finishedAt: time, requestsUsed: 1, peakConcurrency: 1, sessionsUsed: 0, cleanup: 'complete' }, notes: { problem: 'Synthetic requests', solution: 'Cloudflare', limitations: 'Fixture unless live', question: 'Where does the rule apply?' } };
  return { report, artifact: built.artifact, observation };
}
