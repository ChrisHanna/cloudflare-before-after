import { z } from 'zod';
import { Digest, Id, Role, ScenarioId } from '../../../packages/contracts/src/schemas.js';
import type { Database } from './d1.js';
import type { Producer } from './telemetry.js';
export const ProducerIdentity = z.strictObject({ producerId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), role: Role, scenarioId: ScenarioId, runId: Id, releaseDigest: Digest });
export type ProducerIdentity = z.infer<typeof ProducerIdentity>;
export async function deriveIngestSecret(identity: ProducerIdentity, root: string): Promise<string> {
  const valid = ProducerIdentity.parse(identity);
  if (root.length < 24) throw new Error('Ingestion root secret is required');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hash = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(valid)));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function matchesSecret(actual: string, expected: string): Promise<boolean> {
  if (expected.length < 24 || actual.length > 512 || actual.length === 0) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(expected), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const other = await crypto.subtle.importKey('raw', new TextEncoder().encode(actual), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const text = new TextEncoder().encode('lab-service-authorization');
  return crypto.subtle.verify('HMAC', other, await crypto.subtle.sign('HMAC', key, text), text);
}
export async function registerProducer(db: Database, input: ProducerIdentity): Promise<void> {
  const p = ProducerIdentity.parse(input);
  await db.prepare('INSERT INTO producer_registry(producer_id,environment,scenario_id,run_id,release_digest) VALUES(?,?,?,?,?) ON CONFLICT(producer_id) DO NOTHING').bind(p.producerId, p.role, p.scenarioId, p.runId, p.releaseDigest).run();
  const row = await db.prepare('SELECT environment,scenario_id,run_id,release_digest FROM producer_registry WHERE producer_id=?').bind(p.producerId).first<{ environment: string; scenario_id: string; run_id: string; release_digest: string }>();
  if (!row || row.environment !== p.role || row.scenario_id !== p.scenarioId || row.run_id !== p.runId || row.release_digest !== p.releaseDigest) throw new Error('Producer registration ownership conflict');
}
export async function registeredProducers(db: Database, role: z.infer<typeof Role>, runId: string, scenarioId: z.infer<typeof ScenarioId>, root: string): Promise<Producer[]> {
  Role.parse(role); Id.parse(runId); ScenarioId.parse(scenarioId);
  const rows = await db.prepare('SELECT producer_id,environment,scenario_id,run_id,release_digest FROM producer_registry WHERE environment=? AND run_id=? AND scenario_id=? ORDER BY producer_id LIMIT 101').bind(role, runId, scenarioId).all<{ producer_id: string; environment: string; scenario_id: string; run_id: string; release_digest: string }>();
  if (rows.results.length > 100) throw new Error('Producer registry exceeds scoped cap');
  return Promise.all(rows.results.map(async row => {
    const identity = ProducerIdentity.parse({ producerId: row.producer_id, role: row.environment, scenarioId: row.scenario_id, runId: row.run_id, releaseDigest: row.release_digest });
    return { ...identity, ingestSecret: await deriveIngestSecret(identity, root) };
  }));
}
