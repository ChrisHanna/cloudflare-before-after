import { z } from 'zod';
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Id, type EvidenceView, type ScenarioResult } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { validateEvidenceDirectory, type LabConfig } from './config.js';
import { ArtifactSchema, JournalEvent, ReportSchema, ReportStore, type Artifact, type Report } from './reports.js';
import { evidenceView } from './evidence-view.js';
type Event = z.infer<typeof JournalEvent>;
type JournalRun = { waitingRoom?: Report['waitingRoom'] | null; id: string; actualRunId: string; command: ScenarioResult['scenarioId']; ownership: 'cli'; readOnly: true; status: 'running' | 'finished'; phase: string; createdAt: string; finishedAt: string | null; exitCode: null; error: null; eventSequence: number; truncated: boolean; reportId: string | null; capturedOutcome: ScenarioResult['outcome'] | null; historical: boolean; observations?: Extract<Event['event'], { type: 'observation' }>['observation'][]; artifacts?: Artifact[]; result?: { kind: 'result'; report: Report; journalComplete: boolean } | null; evidence?: EvidenceView };
const redactor = new Redactor();
/** Each request has a hard disk/memory budget. Never claim a journal or create directories. */
export function readJournalRuns(projectRoot: string, config: LabConfig, exclude: ReadonlySet<string>, selected?: string, now = Date.now()) {
  if (selected) Id.parse(selected);
  let bytes = 2 * 1024 * 1024; let files = 512; let truncated = false;
  const read = (file: string, cap = 65536) => {
    validateEvidenceDirectory(dirname(file), projectRoot);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > cap || stat.size > bytes || --files < 0) throw new Error('Journal read cap'); bytes -= stat.size; return readFileSync(fd, 'utf8'); }
    finally { closeSync(fd); }
  };
  const boundedNames = (path: string, limit: number, pattern: RegExp, directories: boolean) => {
    validateEvidenceDirectory(path, projectRoot); const dir = opendirSync(path); const names: string[] = []; let seen = 0;
    try { let entry; while ((entry = dir.readSync())) { if (++seen > limit) { truncated = true; break; } if (!entry.isSymbolicLink() && (directories ? entry.isDirectory() : entry.isFile()) && pattern.test(entry.name)) names.push(entry.name); } }
    finally { dir.closeSync(); } return names.sort();
  };
  const root = join(config.evidenceDirectory, 'journal'); validateEvidenceDirectory(root, projectRoot);
  const runs: JournalRun[] = [];
  if (!existsSync(root)) return { runs, truncated };
  const names = selected ? [selected] : boundedNames(root, 128, /^[a-f0-9-]{36}$/, true);
  for (const id of names) {
    if (!Id.safeParse(id).success || exclude.has(id)) continue;
    if (runs.length >= 32 || bytes <= 0 || files <= 0) { truncated = true; break; }
    try {
      const directory = join(root, id); validateEvidenceDirectory(directory, projectRoot);
      const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      const eventNames = boundedNames(directory, 2100, /^\d{4}\.json$/, false); if (eventNames.length > 1000) throw new Error('Journal event cap');
      const events: Event[] = [];
      for (const [index, name] of eventNames.entries()) {
        const event = JournalEvent.parse(JSON.parse(redactor.serialize(JournalEvent, JSON.parse(read(join(directory, name))))));
        if (event.runId !== id || event.sequence !== index + 1 || name !== `${String(event.sequence).padStart(4, '0')}.json`) throw new Error('Journal sequence mismatch');
        if (events.length && event.observedAt < events.at(-1)!.observedAt) throw new Error('Journal clock reversed');
        events.push(event);
      }
      if (!events.length) continue;
      const artifacts = events.flatMap(e => e.event.type === 'evidence' ? [e.event.artifact] : []);
      const observations = events.flatMap(e => e.event.type === 'observation' ? [e.event.observation] : []);
      const result = events.flatMap(e => e.event.type === 'outcome' ? [e.event.result] : []).at(-1);
      const context = events.flatMap(e => e.event.type === 'started' ? [e.event] : []);
      if (context.length > 1 || context.some(c => c.labId !== config.labId || c.accountId !== config.accountId || c.zoneId !== config.zoneId)) throw new Error('Foreign journal lab');
      const identity = context[0] ?? artifacts[0] ?? observations[0]; if (!identity) continue;
      if (artifacts.some(a => a.scenarioId !== identity.scenarioId || a.mode !== identity.mode) || observations.some(o => o.scenarioId !== identity.scenarioId || o.mode !== identity.mode) || (result && result.scenarioId !== identity.scenarioId)) throw new Error('Journal scope mismatch');
      let report: Report | null = null; let displayedArtifacts: Artifact[] = artifacts;
      // Verify a final report only for the selected run, with a precharged size/file budget.
      if (selected && result) try {
        const folder = join(config.evidenceDirectory, 'runs', id);
        const reportNames = boundedNames(folder, 504, /^(?:index|report|[a-f0-9-]{36})\.(?:json|html)$/, false);
        for (const name of reportNames) read(join(folder, name), name.endsWith('.html') ? 512000 : 128000);
        const store = new ReportStore(projectRoot, config.evidenceDirectory); const loaded = store.load(id); const loadedArtifacts = store.loadArtifacts(id);
        if (loaded.mode !== identity.mode || JSON.stringify(loaded.result) !== JSON.stringify(result)) throw new Error('Final report differs from journal');
        // Re-sanitize stored content at the API boundary, even if an old writer omitted it.
        report = ReportSchema.parse(JSON.parse(redactor.serialize(ReportSchema, loaded)));
        displayedArtifacts = loadedArtifacts.map(a => ArtifactSchema.parse(JSON.parse(redactor.serialize(ArtifactSchema, a))));
      } catch { /* Journal capture remains read-only; never claim an unchecked report. */ }
      const phase = events.flatMap(e => e.event.type === 'phase' ? [e.event.phase] : []).at(-1) ?? 'planned';
      const startedAt = result?.startedAt ?? events[0]!.observedAt; const endedAt = result?.finishedAt ?? new Date(now).toISOString();
      const boundedArtifacts = [...new Map(displayedArtifacts.map(a => [a.id, a])).values()].slice(-200);
      const boundedObservations = observations.slice(-100); const cut = observations.length > 100 || displayedArtifacts.length > 200;
      runs.push({ id, actualRunId: id, command: identity.scenarioId, ownership: 'cli' as const, readOnly: true as const,
        status: result ? 'finished' as const : 'running' as const, phase: result ? 'finished' : phase,
        createdAt: startedAt, finishedAt: result?.finishedAt ?? null, exitCode: null, error: null,
        eventSequence: events.at(-1)!.sequence, truncated: cut, reportId: report ? id : null,
        capturedOutcome: result?.outcome ?? null, historical: !!result,
        ...(selected ? { waitingRoom: report?.waitingRoom ?? null, observations: boundedObservations, artifacts: boundedArtifacts, result: report ? { kind: 'result' as const, report, journalComplete: true } : null,
          evidence: evidenceView({ runId: id, scenarioId: identity.scenarioId, mode: identity.mode, startedAt, endedAt, releaseDigest: report?.result.releaseDigest ?? context[0]?.releaseDigest ?? config.environments[0].releaseDigest, hosts: { before: new URL(config.environments[0].origin).hostname, after: new URL(config.environments[1].origin).hostname }, running: !result, truncated: cut }, boundedObservations, boundedArtifacts, now) } : {}),
      });
    } catch { truncated = true; /* Corrupt/partial/foreign records are not rendered. */ }
  }
  return { runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), truncated };
}
