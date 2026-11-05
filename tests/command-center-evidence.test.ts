import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evidenceView, type EvidenceScope } from '../packages/demo-core/src/evidence-view.js';
import { readJournalRuns } from '../packages/demo-core/src/journal-reader.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { ArtifactSchema } from '../packages/demo-core/src/reports.js';
import { EvidenceViewSchema, ObservationSchema } from '../packages/contracts/src/schemas.js';
import { controlFixture } from './fixtures/control.js';
import { reportFixture } from './fixtures/report.js';
const request = () => ({ command: 'waf-custom', idempotencyKey: randomUUID(), liveOptIn: true, limits: { requests: 30, concurrency: 2, maxRuntimeSeconds: 30 } });
async function completed(f: ReturnType<typeof controlFixture>) { await f.login(); const created = await (await f.request('/api/runs', 'POST', request())).json() as any; return f.wait(created.run.id); }
function scopeOf(job: any): EvidenceScope { const r = job.result.report; return { runId: r.result.runId, scenarioId: r.result.scenarioId, mode: r.mode, startedAt: r.result.startedAt, endedAt: r.result.finishedAt, releaseDigest: r.result.releaseDigest, hosts: { before: 'before.example.test', after: 'after.example.test' }, running: false, truncated: false }; }
describe('command-center-evidence', () => {
  it('matches actual runner/report counts, not status guesses, with linked scoped artifacts', async () => {
    const f = controlFixture(); try {
      const job = await completed(f); const view = EvidenceViewSchema.parse(job.evidence);
      expect(job.result.report.result.requestsUsed).toBe(22); expect(view.roles.map(r => r.requests)).toEqual([2, 2]);
      expect(view.roles.map(r => [r.originReceived, r.originAbsent, r.originUnknown])).toEqual([[2, 0, 0], [1, 1, 0]]);
      expect(view.roles[0]!.edgeEvents).toBeNull(); expect(view.roles[1]!.edgeEvents).toBe(1); expect(view.roles[1]!.rules).toBe(1);
      expect(view.roles[1]!.actions).toEqual([{ product: 'firewallrules', action: 'block', ruleId: 'c'.repeat(32), count: 1 }]);
      expect(view.roles[1]!.sources.find(s => s.source === 'cloudflare')?.sampling).toBe('unknown');
      const artifact = await f.request(`/api/runs/${job.id}/evidence/${view.roles[1]!.evidenceIds[0]}`); expect(artifact.status).toBe(200);
      expect((await artifact.json() as any).artifact.runId).toBe(view.runId);
    } finally { await f.cleanup(); }
  });
  it('deduplicates replayed HTTP, entry/completion receipts and edge events without hiding sampling', async () => {
    const f = controlFixture(); try {
      const job = await completed(f); const original = job.artifacts.map((a: unknown) => ArtifactSchema.parse(a));
      const entry = original.find((a: any) => a.source === 'origin' && a.payload.stage === 'entry')!;
      const edge = original.find((a: any) => a.source === 'cloudflare')!;
      const repeated = [entry, { ...entry, id: randomUUID() }, { ...entry, id: randomUUID(), payload: { ...entry.payload, id: randomUUID(), stage: 'completion' } }, { ...edge, id: randomUUID(), payload: { ...edge.payload, sampling: 'sampled' } }].map(a => ArtifactSchema.parse(a));
      const view = evidenceView(scopeOf(job), job.observations, [...original, ...repeated, edge], Date.parse(job.finishedAt));
      expect(view.roles.map(r => r.requests)).toEqual([2, 2]); expect(view.roles.map(r => r.originReceived)).toEqual([2, 1]);
      expect(view.roles[1]!.edgeEvents).toBe(1); expect(view.roles[1]!.sources[2]!.state).toBe('sampled');
    } finally { await f.cleanup(); }
  });
  it('renders missing sources as unknown; a 403 does not prove zero origin or an edge action', async () => {
    const fixture = reportFixture(); const scope: EvidenceScope = { runId: fixture.report.result.runId, scenarioId: 'waf-custom', mode: 'fixture', startedAt: fixture.report.result.startedAt, endedAt: fixture.report.result.finishedAt, releaseDigest: fixture.report.result.releaseDigest, hosts: { before: 'before.example.test', after: 'after.example.test' }, running: false, truncated: false };
    const observation = ObservationSchema.parse({ ...fixture.observation, targetRole: 'after', status: 403, originCount: 0, action: 'block', ruleId: 'untrusted-header' });
    const view = evidenceView(scope, [observation], [], Date.parse(scope.endedAt));
    expect(view.roles[1]).toMatchObject({ requests: 1, originReceived: null, originAbsent: null, originUnknown: 1, edgeEvents: null, rules: null });
    expect(view.roles[1]!.sources[1]!.state).toBe('unavailable');
    const pending = evidenceView({ ...scope, running: true }, [], [], Date.parse(scope.endedAt)); expect(pending.roles[0]!.sources.every(s => s.state === 'pending')).toBe(true);
  });
  it('rejects foreign run/mode/window/host/release evidence and needs healthy complete origin coverage', async () => {
    const f = controlFixture(); try {
      const job = await completed(f); const scope = scopeOf(job); const artifacts = job.artifacts.map((a: unknown) => ArtifactSchema.parse(a));
      const missing = artifacts.filter((a: any) => !(a.source === 'origin' && 'windowStart' in a.payload));
      const partial = evidenceView(scope, job.observations, missing); expect(partial.roles[1]!.originAbsent).toBeNull(); expect(partial.roles[1]!.originUnknown).toBe(1);
      const foreign = artifacts.map((a: any) => ({ ...a, runId: randomUUID() })); expect(evidenceView(scope, job.observations, foreign).roles[1]!.edgeEvents).toBeNull();
      const wrongMode = artifacts.map((a: any) => ({ ...a, mode: 'live' })); expect(evidenceView(scope, job.observations, wrongMode).roles[1]!.originReceived).toBeNull();
      const invalid = artifacts.map((a: any) => ({ ...a, payload: a.source === 'cloudflare' ? { ...a.payload, hostname: 'other.example.test' } : a.source === 'origin' && 'stage' in a.payload ? { ...a.payload, releaseDigest: 'f'.repeat(64) } : a.source === 'origin' ? { ...a.payload, healthy: false } : a.payload }));
      expect(evidenceView(scope, job.observations, invalid).roles[1]).toMatchObject({ originReceived: null, originAbsent: null, edgeEvents: null });
      const stale = evidenceView(scope, job.observations, artifacts, Date.parse(scope.endedAt) + 61000); expect(stale.roles[1]!.sources.every(s => s.state === 'stale')).toBe(true);
      expect(evidenceView({ ...scope, startedAt: scope.endedAt }, [], artifacts).roles[0]!.requests).toBeNull();
    } finally { await f.cleanup(); }
  });
  it('discovers a real standalone CLI journal read-only, verifies its final report, and never dispatches on reads', async () => {
    const f = controlFixture(); try {
      await f.login(); const executed = await runDemoCli(['waf-custom', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch: f.dispatch }); expect(executed.exitCode).toBe(0);
      const id = JSON.parse(executed.output).report.result.runId; const before = f.calls.length; const folder = join(f.config.evidenceDirectory, 'journal', id); const owner = readdirSync(folder);
      const listed = await (await f.request('/api/journal-runs')).json() as any; expect(listed.runs).toHaveLength(1); expect(listed.runs[0]).toMatchObject({ id, actualRunId: id, readOnly: true, ownership: 'cli', capturedOutcome: 'verified' });
      const run = (await (await f.request(`/api/journal-runs/${id}`)).json() as any).run;
      expect(run.reportId).toBe(id); expect(run.result.report.result.outcome).toBe('verified'); expect(run.historical).toBe(true);
      expect(run.evidence.roles.map((r: any) => r.originReceived)).toEqual([2, 1]);
      const ref = run.evidence.roles[0].evidenceIds[0]; expect((await f.request(`/api/journal-runs/${id}/evidence/${ref}`)).status).toBe(200);
      for (const suffix of ['stop', 'advance']) expect((await f.request(`/api/runs/${id}/${suffix}`, 'POST', {})).status).toBe(404);
      for (let i = 0; i < 3; i++) { await f.request('/api/catalog'); await f.request('/api/readiness'); await f.request('/api/journal-runs'); await f.request(`/api/journal-runs/${id}`); }
      expect(f.calls.length).toBe(before); expect(readdirSync(folder)).toEqual(owner); expect((await (await f.request('/api/runs')).json() as any).runs).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it('does not duplicate own CLI journals and refresh/replay cannot restart traffic', async () => {
    const f = controlFixture(); try {
      const job = await completed(f); const before = f.calls.length;
      for (let i = 0; i < 2; i++) { expect((await (await f.request('/api/journal-runs')).json() as any).runs).toEqual([]); await f.request(`/api/runs/${job.id}`); const stream = await f.request(`/api/runs/${job.id}/events?after=0`); await stream.text(); }
      expect(f.calls.length).toBe(before);
    } finally { await f.cleanup(); }
  });
  it('finds CLI preflight before any traffic, binds it to the lab, and caps discovery', async () => {
    const f = controlFixture(); try {
      const id = randomUUID(); const dir = join(f.config.evidenceDirectory, 'journal', id); mkdirSync(dir, { recursive: true });
      const event = { schemaVersion: 1, runId: id, sequence: 1, observedAt: new Date().toISOString(), event: { type: 'started', mode: 'fixture', scenarioId: 'waf-custom', labId: f.config.labId, accountId: f.config.accountId, zoneId: f.config.zoneId, releaseDigest: f.config.environments[0].releaseDigest } };
      writeFileSync(join(dir, '0001.json'), JSON.stringify(event));
      const run = readJournalRuns(f.root, f.config, new Set(), id).runs[0]!;
      expect(run).toMatchObject({ actualRunId: id, readOnly: true, phase: 'planned', status: 'running' });
      expect(run.evidence?.roles[0]?.requests).toBeNull(); expect(f.calls).toHaveLength(0);
      event.event.accountId = 'f'.repeat(32); writeFileSync(join(dir, '0001.json'), JSON.stringify(event));
      expect(readJournalRuns(f.root, f.config, new Set(), id).runs).toEqual([]);
      for (let i = 0; i < 130; i++) mkdirSync(join(f.config.evidenceDirectory, 'journal', randomUUID()));
      expect(readJournalRuns(f.root, f.config, new Set()).truncated).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('bounds and sanitizes disk reads without creating owners, following symlinks or exposing partial records', async () => {
    const f = controlFixture(); try {
      const fixture = reportFixture(); const id = fixture.report.result.runId; const dir = join(f.config.evidenceDirectory, 'journal', id); mkdirSync(dir, { recursive: true });
      const observation = { ...fixture.observation, excerpt: 'token=private-canary' };
      writeFileSync(join(dir, '0001.json'), JSON.stringify({ schemaVersion: 1, runId: id, sequence: 1, observedAt: fixture.observation.observedAt, event: { type: 'observation', observation } }));
      writeFileSync(join(dir, '.event-partial'), '{');
      const capture = readJournalRuns(f.root, f.config, new Set(), id, Date.parse(fixture.observation.observedAt)); expect(capture.runs).toHaveLength(1); expect(JSON.stringify(capture)).not.toContain('private-canary'); expect(existsSync(join(dir, 'owner.json'))).toBe(false);
      writeFileSync(join(dir, '0002.json'), 'x'.repeat(65537)); expect(readJournalRuns(f.root, f.config, new Set(), id).runs).toEqual([]);
      const other = randomUUID(); symlinkSync(dir, join(f.config.evidenceDirectory, 'journal', other), 'dir'); expect(readJournalRuns(f.root, f.config, new Set(), other).runs).toEqual([]);
      expect(readJournalRuns(f.root, f.config, new Set(), id).truncated).toBe(true); expect(f.calls).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
});
