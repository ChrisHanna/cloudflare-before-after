import { EvidenceViewSchema, type EvidenceView, type ScenarioResult } from '../../contracts/src/schemas.js';
import type { Artifact } from './reports.js';
import type { z } from 'zod';
import type { ObservationSchema } from '../../contracts/src/schemas.js';
type Observation = z.infer<typeof ObservationSchema>;
export interface EvidenceScope { runId: string; scenarioId: ScenarioResult['scenarioId']; mode: EvidenceView['mode']; startedAt: string; endedAt: string; releaseDigest: string; hosts: Record<'before' | 'after', string>; running: boolean; truncated: boolean }
/** A read-only view, never a proof verdict or a source of network work. */
export function evidenceView(scope: EvidenceScope, observations: readonly Observation[], artifacts: readonly Artifact[], now = Date.now()): EvidenceView {
  const inside = (time: string) => time >= scope.startedAt && time <= scope.endedAt;
  const matches = (v: { runId: string; scenarioId: string; mode: string }) => v.runId === scope.runId && v.scenarioId === scope.scenarioId && v.mode === scope.mode;
  const scoped = artifacts.filter(a => matches(a) && inside(a.observedAt));
  const all = [...observations, ...scoped.flatMap(a => a.source === 'http' && 'status' in a.payload ? [a.payload] : [])].filter(o => matches(o) && inside(o.observedAt));
  const roles = (['before', 'after'] as const).map(role => {
    const requests = new Map<string, Observation>(); const conflicts = new Set<string>();
    for (const o of all.filter(o => o.targetRole === role)) {
      const previous = requests.get(o.requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(o)) conflicts.add(o.requestId);
      requests.set(o.requestId, o);
    }
    for (const key of conflicts) requests.delete(key);
    const roleArtifacts = scoped.filter(a => a.targetRole === role);
    const entries = roleArtifacts.filter(a => a.source === 'origin' && 'stage' in a.payload && a.payload.stage === 'entry' && a.payload.releaseDigest === scope.releaseDigest && inside(a.payload.observedAt) && requests.has(a.payload.requestId));
    const received = new Set(entries.map(a => a.requestId!));
    const coverages = roleArtifacts.filter(a => a.source === 'origin' && 'windowStart' in a.payload);
    const covered = (o: Observation) => coverages.some(a => {
      const p = a.payload;
      return 'windowStart' in p && p.healthy && p.complete && !p.gaps.length && p.producerSequence !== null && p.watermark !== null && p.windowStart === scope.startedAt && p.watermark >= o.observedAt && p.watermark <= scope.endedAt && p.windowStart <= o.observedAt && a.observedAt >= o.observedAt;
    });
    const absent = [...requests.values()].filter(o => !received.has(o.requestId) && covered(o)).length;
    const unknown = requests.size - received.size - absent;
    const edges = new Map<string, Artifact>();
    for (const a of roleArtifacts) {
      const p = a.payload; const request = a.requestId ? requests.get(a.requestId) : undefined;
      if (a.source !== 'cloudflare' || !('kind' in p) || p.kind !== 'edge' || !request?.rayId || p.hostname !== scope.hosts[role] || !inside(p.eventTime) || p.rayId.split('-')[0]!.toLowerCase() !== request.rayId.split('-')[0]!.toLowerCase()) continue;
      const key = `${p.rayId.split('-')[0]!.toLowerCase()}:${p.product}:${p.action}:${p.ruleId}`;
      const previous = edges.get(key); const rank = { complete: 0, unknown: 1, sampled: 2 };
      if (!previous || !('kind' in previous.payload) || previous.payload.kind !== 'edge' || rank[p.sampling] >= rank[previous.payload.sampling]) edges.set(key, a);
    }
    const actions = new Map<string, EvidenceView['roles'][number]['actions'][number]>(); const ruleIds = new Set<string>();
    for (const a of edges.values()) {
      const p = a.payload; if (!('kind' in p) || p.kind !== 'edge') continue;
      const key = `${p.product}:${p.action}:${p.ruleId}`; const previous = actions.get(key);
      actions.set(key, { product: p.product, action: p.action, ruleId: p.ruleId, count: (previous?.count ?? 0) + 1 }); if (p.ruleId) ruleIds.add(p.ruleId);
    }
    const origin = [...entries, ...coverages]; const httpTimes = [...requests.values()].map(o => o.observedAt);
    const incomplete = scope.truncated || conflicts.size > 0;
    const source = (name: 'http' | 'origin' | 'cloudflare', times: string[], sampling: 'unknown' | 'sampled' | 'complete' | null, partial = false): EvidenceView['roles'][number]['sources'][number] => {
      const observedAt = times.sort().at(-1) ?? null; const age = observedAt ? now - Date.parse(observedAt) : null;
      const state = age === null ? scope.running ? 'pending' : 'unavailable' : age < 0 || age > 60000 ? 'stale' : sampling === 'sampled' ? 'sampled' : incomplete || partial ? scope.running ? 'pending' : 'unavailable' : 'last-checked';
      return { source: name, state, observedAt, sampling };
    };
    const edgeSampling = [...edges.values()].map(a => 'kind' in a.payload && a.payload.kind === 'edge' ? a.payload.sampling : 'unknown');
    const sampling = edgeSampling.includes('sampled') ? 'sampled' : edgeSampling.includes('unknown') ? 'unknown' : edgeSampling.length ? 'complete' : null;
    return { role, requests: requests.size || null, originReceived: received.size || (unknown === 0 && requests.size > 0 && !incomplete ? 0 : null), originAbsent: absent || (unknown === 0 && requests.size > 0 && !incomplete ? 0 : null), originUnknown: requests.size ? unknown : null, edgeEvents: edges.size || null, rules: ruleIds.size || null,
      sources: [source('http', httpTimes, null), source('origin', origin.map(a => a.observedAt), null, unknown > 0), source('cloudflare', [...edges.values()].map(a => a.observedAt), sampling)], actions: [...actions.values()].slice(0, 200), evidenceIds: [...new Set(roleArtifacts.map(a => a.id))].slice(0, 200) };
  });
  return EvidenceViewSchema.parse({ runId: scope.runId, scenarioId: scope.scenarioId, mode: scope.mode, startedAt: scope.startedAt, endedAt: scope.endedAt, roles });
}
