import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunJournal } from '../packages/demo-core/src/reports.js';
import { Redactor } from '../packages/contracts/src/redaction.js';
import { reportFixture } from './fixtures/report.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH, 'journal-')); roots.push(root);
  const { report, observation } = reportFixture(); const ownerId = randomUUID();
  const journal = new RunJournal(root, join(root, '.evidence'), report.result.runId, new Redactor(['fixture-secret'])); journal.claim(ownerId);
  return { root, report, observation, ownerId, journal };
}
describe('run-journal', () => {
  it('provides bounded monotonic replay for a separate read-only UI without changing owner', () => {
    const f = fixture(); expect(f.journal.append(f.ownerId, { type: 'phase', phase: 'preflight' })).toBe(1);
    f.observation.excerpt = 'fixture-secret'; f.journal.append(f.ownerId, { type: 'observation', observation: f.observation });
    const ui = new RunJournal(f.root, join(f.root, '.evidence'), f.report.result.runId);
    expect(ui.read(1)).toHaveLength(1); expect(JSON.stringify(ui.read(0))).not.toContain('fixture-secret');
    expect(() => ui.append(randomUUID(), { type: 'phase', phase: 'baseline' })).toThrow('owner');
    expect(() => ui.claim(randomUUID())).toThrow();
    expect(f.journal.append(f.ownerId, { type: 'outcome', result: f.report.result })).toBe(3);
  });
  it('rejects foreign run, bad positions, corrupt records and sequence gaps', () => {
    const f = fixture();
    expect(() => f.journal.append(f.ownerId, { type: 'observation', observation: { ...f.observation, runId: randomUUID() } })).toThrow('Foreign');
    expect(() => f.journal.read(-1)).toThrow(); expect(() => f.journal.read(1001)).toThrow();
    f.journal.append(f.ownerId, { type: 'phase', phase: 'preflight' });
    writeFileSync(join(f.journal.directory, '0001.json'), '{broken'); expect(() => f.journal.read(0)).toThrow();
  });
  it('rejects unknown event fields rather than journal raw secrets', () => {
    const f = fixture();
    expect(() => f.journal.append(f.ownerId, { type: 'phase', phase: 'preflight', token: 'fixture-secret' } as any)).toThrow();
    expect(f.journal.read(0)).toHaveLength(0);
  });
});
