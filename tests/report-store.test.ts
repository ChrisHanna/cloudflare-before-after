import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AccessAdmissionSchema, AccessSnapshotSchema, AccessApplicationRejectionSchema } from '../packages/contracts/src/access-service-identity.js';
import { ReportStore, fallbackEligibility, makeArtifact } from '../packages/demo-core/src/reports.js';
import { Redactor } from '../packages/contracts/src/redaction.js';
import { reportFixture } from './fixtures/report.js';
vi.mock('node:fs', async importOriginal => { const real = await importOriginal<typeof import('node:fs')>(); return { ...real, renameSync: vi.fn(real.renameSync) }; });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(redactor = new Redactor()) {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH, 'reports-')); roots.push(root);
  return { root, store: new ReportStore(root, join(root, '.evidence'), redactor) };
}
describe('report-store', () => {
  it('saves immutable schema-validated reports and verifies every artifact digest', () => {
    const { store } = fixture(); const { report, artifact } = reportFixture(); const path = store.save(report, [artifact]);
    expect(store.load(report.result.runId)).toEqual(report);
    expect(readFileSync(join(path, 'report.html'), 'utf8')).toContain('FIXTURE');
    expect(() => store.save(report, [artifact])).toThrow('already exists');
    writeFileSync(join(path, `${artifact.id}.json`), '{}'); expect(() => store.load(report.result.runId)).toThrow('integrity');
  });
  it('publishes no partial report when final rename fails', () => {
    const { store } = fixture(); const { report, artifact } = reportFixture();
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('Injected disk rename failure'); });
    expect(() => store.save(report, [artifact])).toThrow('rename failure');
    expect(readdirSync(join(store.root, 'runs'))).toEqual([]);
    expect(readdirSync(join(store.root, 'reservations'))).toEqual([]);
    expect(() => store.load(report.result.runId)).toThrow();
  });
  it('removes registered secret canaries and escapes notes in HTML', () => {
    const secret = 'fixture-secret-canary'; const redactor = new Redactor([secret]); const { store } = fixture(redactor);
    const { report, artifact } = reportFixture('fixture', redactor); report.notes.problem = `<script>${secret}</script>`;
    const path = store.save(report, [artifact]);
    for (const file of readdirSync(path)) {
      const text = readFileSync(join(path, file), 'utf8'); expect(text).not.toContain(secret);
      if (file.endsWith('.html')) { expect(text).not.toContain('<script>'); expect(text).toContain('&lt;script&gt;'); }
    }
  });
  it('rejects mismatched references and provenance before writing', () => {
    const { store } = fixture(); const { report, artifact } = reportFixture();
    report.result.evidence[0]!.artifactDigest = 'b'.repeat(64);
    expect(() => store.save(report, [artifact])).toThrow('does not match');
    expect(() => makeArtifact({ ...artifact, mode: 'live' })).toThrow('mode mismatch');
  });
  it('stores strict Access admission and snapshots without adopting them as current proof', () => {
    const runId = randomUUID(); const requestId = randomUUID(); const observedAt = '2026-11-05T00:00:00.000Z'; const beforeReadId = randomUUID(); const afterReadId = randomUUID();
    const facts = { schemaVersion: 1, kind: 'access-service-identity', source: 'verified-rs256-service-jwt', channel: 'authenticated-same-request-https', mode: 'fixture',
      targetRole: 'after', scenarioId: 'access', runId, requestId, nonce: randomUUID(), releaseDigest: 'a'.repeat(64), hostname: 'after.example.test', path: '/admin', method: 'GET', observedAt,
      audience: '3'.repeat(64), issuer: 'https://synthetic-team.cloudflareaccess.com', issuerMatched: true, clientIdMatched: true, identity: 'lab-service-token', signatureVerified: true, policyId: null, perRequestEvaluation: 'unknown' };
    const payload = AccessAdmissionSchema.parse({ schemaVersion: 1, kind: 'access-service-admission', channel: 'authenticated-same-request-https', facts,
      beforeReadId, afterReadId, configurationDigest: 'b'.repeat(64), configuredPolicyId: '2'.repeat(32), approvingPolicyId: null, receiptId: randomUUID(), completedAt: observedAt, fullRuntimeState: null });
    const a = { id: randomUUID(), mode: 'fixture' as const, runId, requestId, scenarioId: 'access' as const, targetRole: 'after' as const, observedAt, source: 'verification' as const, payload };
    expect(makeArtifact(a).artifact.payload).toEqual(payload);
    for (const patch of [{ source: 'cloudflare' as const }, { mode: 'live' as const }, { runId: randomUUID() }, { requestId: randomUUID() },
      { targetRole: 'before' as const }, { scenarioId: 'api-shield' as const }, { observedAt: '2026-11-05T00:00:01.000Z' }]) expect(() => makeArtifact({ ...a, ...patch })).toThrow();
    const snapshot = AccessSnapshotSchema.parse({ schemaVersion: 1, kind: 'access-config-snapshot', source: 'guarded-access-app-policy-token-reads', runId, scenarioId: 'access', targetRole: 'after',
      phase: 'before', mode: 'fixture', readId: beforeReadId, observedAt, startedAt: observedAt, generation: 1, accountId: 'a'.repeat(32), applicationId: '1'.repeat(32), configuredPolicyId: '2'.repeat(32),
      audience: '3'.repeat(64), hostname: 'after.example.test', path: '/admin', functionalDigest: 'b'.repeat(64), tokenMapped: true });
    const config = { ...a, id: beforeReadId, source: 'configuration' as const, requestId: null, payload: snapshot };
    expect(makeArtifact(config).artifact.payload).toEqual(snapshot);
    expect(() => makeArtifact({ ...config, id: randomUUID() })).toThrow();
    expect(() => makeArtifact({ ...config, requestId })).toThrow();
    expect(AccessAdmissionSchema.safeParse({ ...payload, facts: { ...facts, clientId: 'PRIVATE-CLIENT.access' } }).success).toBe(false);
  });
  it('keeps negative Access audit policy/audience/identity null or unknown and checks all joins', () => {
    const t = '2026-11-05T00:00:00.000Z';
    const payload = { schemaVersion: 1, kind: 'access-application-rejection', channel: 'authenticated-same-request-https', mode: 'fixture', runId: randomUUID(), requestId: randomUUID(), scenarioId: 'access', targetRole: 'after',
      releaseDigest: 'a'.repeat(64), hostname: 'after.example.test', path: '/admin', method: 'GET', observedAt: t,
      event: { kind: 'access-authentication', sourceApi: 'access-authentication-audit', join: 'ray-application-time', rayId: '1234567890abcdef', applicationId: '1'.repeat(32), hostname: 'after.example.test', path: '/admin',
        eventTime: t, authenticationAction: 'login', allowed: false, complete: true, policyId: null, audience: null, identity: 'unknown' },
      beforeReadId: randomUUID(), afterReadId: randomUUID(), configurationDigest: 'b'.repeat(64), configuredApplicationId: '1'.repeat(32), configuredPolicyId: '2'.repeat(32), configuredAudience: '3'.repeat(64),
      independentOriginAbsence: true, originWatermark: t, fullRuntimeState: null, credentialCaseCoverage: 'unqualified' };
    expect(AccessApplicationRejectionSchema.safeParse(payload).success).toBe(true);
    for (const patch of [{ allowed: true }, { complete: false }, { policyId: '2'.repeat(32) }, { audience: '3'.repeat(64) }, { identity: 'none' },
      { applicationId: '4'.repeat(32) }, { hostname: 'before.example.test' }]) expect(AccessApplicationRejectionSchema.safeParse({ ...payload, event: { ...payload.event, ...patch } }).success).toBe(false);
    expect(AccessApplicationRejectionSchema.safeParse({ ...payload, beforeReadId: payload.afterReadId }).success).toBe(false);
    expect(AccessApplicationRejectionSchema.safeParse({ ...payload, originWatermark: '2026-11-04T00:00:00.000Z' }).success).toBe(false);
  });
  it('only admits verified compatible live captures as dated saved fallback', () => {
    const { report } = reportFixture('live');
    const current = { scenarioId: report.result.scenarioId, manifestVersion: 1, releaseDigest: report.result.releaseDigest, observedConfigDigest: report.result.observedConfigDigest };
    expect(fallbackEligibility(report, current, Date.parse(report.createdAt) + 60000)).toEqual({ eligible: true, label: 'SAVED EVIDENCE', historicalOnly: false, ageMs: 60000 });
    for (const patch of [{ observedConfigDigest: null }, { releaseDigest: 'b'.repeat(64) }, { manifestVersion: 2 }]) expect(fallbackEligibility(report, { ...current, ...patch }).eligible).toBe(false);
    expect(fallbackEligibility(reportFixture('fixture').report, current).eligible).toBe(false);
    expect(fallbackEligibility({ ...report, result: { ...report.result, outcome: 'failed' } }, current).eligible).toBe(false);
  });
});
