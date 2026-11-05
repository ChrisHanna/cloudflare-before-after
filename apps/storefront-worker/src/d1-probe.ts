import { z } from 'zod';
import { D1ProbeRowSchema, D1_PROBE_MARKER, type D1WriteReadReceipt } from '../../../packages/contracts/src/d1-probe.js';
import type { Database } from './d1.js';
import { contentDigest } from './assets.js';
const Result = z.object({ success: z.literal(true), meta: z.object({ changes: z.number().int().min(0).max(1) }) });
const where = 'environment=? AND scenario_id=? AND run_id=? AND request_id=? AND probe_id=?';
type Outcome = Pick<D1WriteReadReceipt, 'probeId' | 'write' | 'read' | 'cleanup' | 'contentDigest'>;

/** Fixed synthetic data only; never accepts SQL, table names or user content. */
export async function runD1WriteRead(db: Database, input: { role: 'before' | 'after'; runId: string; requestId: string }, probeId = crypto.randomUUID()): Promise<Outcome> {
  const row = D1ProbeRowSchema.parse({ environment: input.role, scenario_id: 'waf-custom', run_id: input.runId,
    request_id: input.requestId, probe_id: probeId, marker: D1_PROBE_MARKER });
  const key = [row.environment, row.scenario_id, row.run_id, row.request_id, row.probe_id];
  const outcome: Outcome = { probeId: row.probe_id, write: 'unknown', read: 'unknown', cleanup: 'unknown', contentDigest: null };
  let inserted = false;
  try {
    const result = Result.parse(await db.prepare('INSERT INTO verification_probes(environment,scenario_id,run_id,request_id,probe_id,marker) VALUES(?,?,?,?,?,?) ON CONFLICT(environment,scenario_id,run_id,request_id,probe_id) DO NOTHING').bind(...key, row.marker).run());
    if (result.meta.changes !== 1) return outcome;
    inserted = true; outcome.write = 'observed';
    const actual = D1ProbeRowSchema.parse(await db.prepare(`SELECT environment,scenario_id,run_id,request_id,probe_id,marker FROM verification_probes WHERE ${where}`).bind(...key).first());
    if (JSON.stringify(actual) !== JSON.stringify(row)) throw new Error('D1 probe read differs');
    outcome.contentDigest = await contentDigest(JSON.stringify(actual)); outcome.read = 'observed';
  } catch { /* Missing or malformed database results cannot prove a write/read. */ }
  finally {
    // A collision or uncertain insertion cannot establish ownership of a new
    // row. Never guess cleanup success or retry that possibly-effectful write.
    if (inserted) try {
      const deleted = Result.parse(await db.prepare(`DELETE FROM verification_probes WHERE ${where} AND marker=?`).bind(...key, row.marker).run());
      if (deleted.meta.changes !== 1) throw new Error('D1 probe cleanup not acknowledged');
      const remaining = await db.prepare(`SELECT probe_id FROM verification_probes WHERE ${where}`).bind(...key).first();
      if (remaining === null) outcome.cleanup = 'observed';
    } catch { /* Cleanup remains unknown, never silently successful. */ }
  }
  return outcome;
}
