import { z } from 'zod';
import { Digest, Id, Mode, ObservationSchema, ScenarioId, Time } from '../../contracts/src/schemas.js';
import { ArtifactSchema } from './reports.js';

const Window = z.strictObject({ start: Time, end: Time }).refine(v => Date.parse(v.start) < Date.parse(v.end), 'Analytics window must increase');
export const AnalyticsScopeSchema = z.strictObject({
  runId: Id, scenarioId: ScenarioId, mode: Mode, releaseDigest: Digest, window: Window,
  hosts: z.strictObject({ before: z.hostname(), after: z.hostname() }),
}).refine(v => v.hosts.before !== v.hosts.after, 'Paired hostnames must differ');
export type AnalyticsScope = z.infer<typeof AnalyticsScopeSchema>;
const SourceSchema = z.strictObject({
  runId: Id, scenarioId: ScenarioId, mode: Mode,
  role: z.enum(['before', 'after']), source: z.enum(['http', 'origin', 'cloudflare']),
  api: z.string().regex(/^[A-Za-z0-9_./-]{1,128}$/), state: z.enum(['available', 'pending', 'stale', 'unavailable', 'permission-denied']),
  observedAt: Time.nullable(), window: Window, sampling: z.enum(['complete', 'sampled', 'unknown']),
  complete: z.boolean(), ingestionDelayMs: z.number().nonnegative().nullable(),
});
export type AnalyticsSource = z.infer<typeof SourceSchema>;
export const AnalyticsInputSchema = z.strictObject({
  scope: AnalyticsScopeSchema, observations: z.array(ObservationSchema).max(500),
  artifacts: z.array(z.lazy(() => ArtifactSchema)).max(500), sources: z.array(SourceSchema).max(6),
});
export type AnalyticsInput = z.infer<typeof AnalyticsInputSchema>;
export interface AnalyticsRole {
  role: 'before' | 'after'; observedRequests: number | null; originReceipts: number | null;
  edgeEvents: number | null; actions: { product: string; action: string; ruleId: string | null; count: number }[];
  joins: { requestId: string; originReceived: boolean | null; edgeEvidenceIds: string[] }[];
  sources: AnalyticsSource[]; evidenceIds: string[];
}
export interface AnalyticsSummary {
  scope: AnalyticsScope; label: 'LIVE OBSERVATIONS' | 'SAVED EVIDENCE' | 'FIXTURE';
  outcome: 'verified' | 'inconclusive' | 'unavailable'; roles: AnalyticsRole[];
  missingProof: string[]; inferredExplanations: string[]; limitations: string[];
}
export const AnalyticsSummarySchema = z.strictObject({
  scope: AnalyticsScopeSchema, label: z.enum(['LIVE OBSERVATIONS', 'SAVED EVIDENCE', 'FIXTURE']),
  outcome: z.enum(['verified', 'inconclusive', 'unavailable']),
  roles: z.array(z.strictObject({ role: z.enum(['before', 'after']), observedRequests: z.number().int().nonnegative().nullable(), originReceipts: z.number().int().nonnegative().nullable(), edgeEvents: z.number().int().nonnegative().nullable(),
    actions: z.array(z.strictObject({ product: z.string().max(100), action: z.string().max(100), ruleId: z.string().max(128).nullable(), count: z.number().int().nonnegative() })).max(500),
    joins: z.array(z.strictObject({ requestId: Id, originReceived: z.boolean().nullable(), edgeEvidenceIds: z.array(Id).max(500) })).max(500),
    sources: z.array(SourceSchema).max(3), evidenceIds: z.array(Id).max(500),
  })).length(2), missingProof: z.array(z.string().max(4096)).max(100), inferredExplanations: z.array(z.string().max(4096)).max(100), limitations: z.array(z.string().max(4096)).max(100),
});
/** Pure same-run joins. Display refreshes perform no network operations. */
export function joinAnalytics(raw: AnalyticsInput): AnalyticsSummary {
  const { scope, observations, artifacts, sources } = AnalyticsInputSchema.parse(raw);
  const inside = (t: string) => Date.parse(t) >= Date.parse(scope.window.start) && Date.parse(t) <= Date.parse(scope.window.end);
  const scoped = (v: { runId: string; scenarioId: string; mode: string }) => v.runId === scope.runId && v.scenarioId === scope.scenarioId && v.mode === scope.mode;
  const missingProof: string[] = [];
  const roles = (['before', 'after'] as const).map(role => {
    const selected = sources.filter(s => s.role === role);
    if (new Set(selected.map(s => s.source)).size !== selected.length) throw new Error('Duplicate analytics source metadata');
    const metadata = (name: AnalyticsSource['source']) => selected.find(s => s.source === name);
    const available = (name: AnalyticsSource['source']) => {
      const s = metadata(name);
      return !!s && scoped(s) && s.state === 'available' && s.observedAt !== null && Date.parse(s.observedAt) >= Date.parse(scope.window.end)
        && Date.parse(s.window.start) === Date.parse(scope.window.start) && Date.parse(s.window.end) === Date.parse(scope.window.end);
    };
    for (const name of ['http', 'origin', 'cloudflare'] as const) if (!available(name)) missingProof.push(`${role} ${name} source is missing, stale, pending or unreadable.`);
    const requests = new Map<string, z.infer<typeof ObservationSchema>>(); const conflicts = new Set<string>();
    for (const o of observations.filter(o => scoped(o) && o.targetRole === role && inside(o.observedAt))) {
      const prior = requests.get(o.requestId);
      if (prior && JSON.stringify({ ...prior, id: '' }) !== JSON.stringify({ ...o, id: '' })) conflicts.add(o.requestId);
      requests.set(o.requestId, o);
    }
    for (const id of conflicts) requests.delete(id);
    if (conflicts.size) missingProof.push(`${role} has conflicting request IDs.`);
    const records = artifacts.filter(a => scoped(a) && a.targetRole === role);
    const received = new Set<string>(); const evidenceIds = new Set<string>();
    const releaseMismatch = records.some(a => 'stage' in a.payload && a.payload.stage === 'entry' && requests.has(a.payload.requestId) && a.payload.releaseDigest !== scope.releaseDigest);
    if (releaseMismatch) missingProof.push(`${role} origin release differs from the selected run.`);
    const covers = (time: string) => !releaseMismatch && available('origin') && metadata('origin')!.complete && metadata('origin')!.sampling === 'complete' && records.some(a => {
      const p = a.payload;
      return a.source === 'origin' && 'windowStart' in p && p.healthy && p.complete && p.gaps.length === 0
        && p.watermark !== null && p.producerSequence !== null && Date.parse(p.windowStart) <= Date.parse(scope.window.start)
        && Date.parse(p.watermark) >= Date.parse(scope.window.end) && Date.parse(a.observedAt) >= Date.parse(time);
    });
    for (const a of records) {
      const p = a.payload;
      if (available('origin') && a.source === 'origin' && 'stage' in p && p.stage === 'entry' && p.releaseDigest === scope.releaseDigest
        && requests.has(p.requestId) && inside(p.observedAt)) { received.add(p.requestId); evidenceIds.add(a.id); }
    }
    const ray = (value: string) => value.split('-')[0]!.toLowerCase();
    const edges = new Map<string, { id: string; requestId: string; product: string; action: string; ruleId: string | null; sampling: string }>();
    for (const a of records) {
      const p = a.payload;
      if (!available('cloudflare') || a.source !== 'cloudflare' || !('kind' in p) || p.kind !== 'edge' || p.hostname !== scope.hosts[role] || !inside(p.eventTime)) continue;
      const matches = [...requests.values()].filter(o => o.rayId && ray(o.rayId) === ray(p.rayId));
      if (matches.length !== 1 || matches[0]!.requestId !== a.requestId) { missingProof.push(`${role} has an ambiguous or unmatched edge event.`); continue; }
      const key = `${ray(p.rayId)}:${p.product}:${p.action}:${p.ruleId}:${Date.parse(p.eventTime)}`;
      const prior = edges.get(key);
      if (!prior || p.sampling !== 'complete') edges.set(key, { id: a.id, requestId: a.requestId!, product: p.product, action: p.action, ruleId: p.ruleId, sampling: p.sampling });
    }
    const actions = new Map<string, AnalyticsRole['actions'][number]>();
    for (const e of edges.values()) {
      const key = `${e.product}:${e.action}:${e.ruleId}`; const prior = actions.get(key);
      actions.set(key, { product: e.product, action: e.action, ruleId: e.ruleId, count: (prior?.count ?? 0) + 1 }); evidenceIds.add(e.id);
    }
    const httpComplete = available('http') && metadata('http')!.complete && metadata('http')!.sampling === 'complete' && conflicts.size === 0;
    const originComplete = httpComplete && available('origin') && metadata('origin')!.complete && metadata('origin')!.sampling === 'complete' && covers(scope.window.end);
    const edgeComplete = available('cloudflare') && metadata('cloudflare')!.complete && metadata('cloudflare')!.sampling === 'complete';
    if (!httpComplete) missingProof.push(`${role} request collection is incomplete.`);
    if (!originComplete) missingProof.push(`${role} origin coverage is incomplete; absence is unknown.`);
    if (!edgeComplete || [...edges.values()].some(e => e.sampling !== 'complete')) missingProof.push(`${role} edge events are sampled, unknown or incomplete; counts are observed rows only.`);
    return { role, observedRequests: requests.size || (httpComplete ? 0 : null), originReceipts: received.size || (originComplete ? 0 : null),
      edgeEvents: edges.size || (edgeComplete && httpComplete ? 0 : null), actions: [...actions.values()],
      joins: [...requests.values()].map(o => ({ requestId: o.requestId, originReceived: received.has(o.requestId) ? true : covers(o.observedAt) ? false : null,
        edgeEvidenceIds: [...edges.values()].filter(e => e.requestId === o.requestId).map(e => e.id) })),
      sources: selected, evidenceIds: [...evidenceIds] };
  });
  return { scope, label: scope.mode === 'fixture' ? 'FIXTURE' : scope.mode === 'saved' ? 'SAVED EVIDENCE' : 'LIVE OBSERVATIONS',
    outcome: roles.every(r => r.observedRequests === null) ? 'unavailable' : missingProof.length ? 'inconclusive' : 'verified', roles,
    missingProof: [...new Set(missingProof)], inferredExplanations: [], limitations: [
      'Counts separate observed requests, unique Container receipts and correlated Cloudflare events.',
      'Sampled counts are not estimated totals; sources need not agree.',
      'Analytics verification is not mitigation proof or deployment readiness.',
      'Synthetic requests do not measure revenue gains, prevented outages or attack impact.',
      ...(scope.mode === 'fixture' ? ['Fixture data is not a Cloudflare observation or live readiness proof.'] : []),
    ] };
}
