import { z } from 'zod';
import { CoverageSchema, EvidenceRefSchema, Id, Mode, ObservationSchema, Outcome, ReceiptSchema, ScenarioId } from '../../contracts/src/schemas.js';
const Fact = z.strictObject({ name: z.string().min(1).max(256), state: z.enum(['supported', 'contradicted', 'missing']), evidence: z.array(EvidenceRefSchema).max(100) });
const Packet = z.strictObject({
  runId: Id, scenarioId: ScenarioId, mode: Mode,
  kind: z.enum(['edge-block', 'turnstile', 'identity', 'mtls', 'waiting-room', 'ddos-evidence', 'analytics']),
  facts: z.array(Fact).max(50), requiredFacts: z.array(z.string().min(1).max(256)).min(1).max(50),
  unavailable: z.array(z.string().max(256)).max(30), skipped: z.boolean(),
});
export type ProofPacket = z.infer<typeof Packet>;
export interface Decision { outcome: z.infer<typeof Outcome>; mode: z.infer<typeof Mode>; missingProof: string[]; contradictions: string[] }
export function evaluateProof(input: ProofPacket): Decision {
  const p = Packet.parse(input); const missingProof: string[] = []; const contradictions: string[] = [];
  if (new Set(p.facts.map(f => f.name)).size !== p.facts.length) throw new Error('Duplicate proof fact');
  if (p.mode === 'saved') missingProof.push('Saved evidence cannot verify a current run');
  const expectedSources = p.kind === 'edge-block' ? ['cloudflare', 'origin', 'configuration', 'http']
    : p.kind === 'turnstile' ? ['verification', 'origin', 'configuration', 'http']
    : p.kind === 'waiting-room' ? ['browser', 'origin', 'configuration']
    : p.kind === 'identity' || p.kind === 'mtls' ? ['verification', 'configuration', 'http']
    : p.kind === 'ddos-evidence' ? ['cloudflare'] : ['origin', 'cloudflare', 'http'];
  const sources = new Set<string>();
  for (const name of p.requiredFacts) {
    const fact = p.facts.find(f => f.name === name);
    if (!fact || fact.state === 'missing') { missingProof.push(name); continue; }
    if (fact.state === 'contradicted') { contradictions.push(name); continue; }
    const valid = fact.evidence.filter(e => e.mode === p.mode && e.mode !== 'saved' && e.runId === p.runId && e.scenarioId === p.scenarioId);
    if (valid.length !== fact.evidence.length || valid.length === 0) { missingProof.push(`${name}: linked proof missing or wrong scope`); continue; }
    for (const ref of valid) sources.add(ref.source);
  }
  // Preserve known contradictions even if prerequisites are also missing.
  for (const fact of p.facts) if (fact.state === 'contradicted' && !contradictions.includes(fact.name)) contradictions.push(fact.name);
  for (const source of expectedSources) if (!sources.has(source)) missingProof.push(`Required source missing: ${source}`);
  const outcome = contradictions.length ? 'failed' : p.unavailable.length ? 'unavailable' : p.skipped ? 'skipped' : missingProof.length ? 'inconclusive' : 'verified';
  return { outcome, mode: p.mode, missingProof: [...missingProof, ...p.unavailable], contradictions };
}
const EdgePacket = z.strictObject({
  runId: Id, scenarioId: ScenarioId, mode: Mode,
  baseline: ObservationSchema, protected: ObservationSchema,
  controls: z.array(ObservationSchema).min(2).max(20),
  receipts: z.array(ReceiptSchema).max(100),
  coverage: CoverageSchema,
  expectedRuleId: z.string().min(1).max(128), expectedAction: z.string().min(1).max(100), expectedSource: z.string().min(1).max(100),
  config: z.strictObject({ enabled: z.boolean(), scopeMatches: z.boolean(), ruleId: z.string(), action: z.string(), evidence: EvidenceRefSchema }).nullable(),
  events: z.array(z.strictObject({ rayId: z.string(), action: z.string(), ruleId: z.string().nullable(), source: z.string(), observedAt: z.iso.datetime(), evidence: EvidenceRefSchema })).max(100),
  httpEvidence: z.array(EvidenceRefSchema).max(30), originEvidence: z.array(EvidenceRefSchema).max(100),
  unavailable: z.array(z.string().max(256)).max(30), skipped: z.boolean(),
});
export type EdgeProof = z.infer<typeof EdgePacket>;
export function evaluateEdgeProof(input: EdgeProof): Decision {
  const p = EdgePacket.parse(input); const facts: z.infer<typeof Fact>[] = [];
  const scoped = (o: z.infer<typeof ObservationSchema>) => o.runId === p.runId && o.scenarioId === p.scenarioId && o.mode === p.mode;
  const receipts = p.receipts.filter(r => r.runId === p.runId && r.scenarioId === p.scenarioId && r.stage === 'entry');
  const hasReceipt = (o: z.infer<typeof ObservationSchema>) => receipts.some(r => r.requestId === o.requestId && r.targetRole === o.targetRole);
  const references = (source: 'http' | 'origin', o: z.infer<typeof ObservationSchema>) => (source === 'http' ? p.httpEvidence : p.originEvidence).filter(e => e.source === source && e.requestId === o.requestId && e.targetRole === o.targetRole);
  const add = (name: string, state: 'supported' | 'contradicted' | 'missing', evidence: z.infer<typeof EvidenceRefSchema>[]) => facts.push({ name, state, evidence });
  const success = (o: z.infer<typeof ObservationSchema>) => scoped(o) && o.status !== null && o.status >= 200 && o.status < 300 && hasReceipt(o) && references('http', o).length > 0 && references('origin', o).length > 0;
  add('baseline reaches origin', success(p.baseline) && p.baseline.targetRole === 'before' ? 'supported' : 'missing', [...references('http', p.baseline), ...references('origin', p.baseline)]);
  for (const role of ['before', 'after'] as const) {
    const control = p.controls.find(c => c.targetRole === role && success(c));
    add(`${role} allowed control`, control ? 'supported' : 'missing', control ? [...references('http', control), ...references('origin', control)] : []);
  }
  const configGood = p.config && p.config.enabled && p.config.scopeMatches && p.config.ruleId === p.expectedRuleId && p.config.action === p.expectedAction && p.config.evidence.source === 'configuration';
  add('deployed configuration', configGood ? 'supported' : p.config ? 'contradicted' : 'missing', p.config ? [p.config.evidence] : []);
  const matching = p.events.filter(e => scoped(p.protected) && p.protected.targetRole === 'after' && p.protected.rayId !== null && e.rayId.toLowerCase() === p.protected.rayId.toLowerCase().split('-')[0] && e.ruleId === p.expectedRuleId && e.action === p.expectedAction && e.source === p.expectedSource && e.evidence.source === 'cloudflare' && e.evidence.targetRole === 'after' && e.evidence.requestId === p.protected.requestId && e.observedAt >= p.coverage.windowStart && p.coverage.watermark !== null && e.observedAt <= p.coverage.watermark);
  add('edge attribution', matching.length === 1 ? 'supported' : 'missing', matching.map(e => e.evidence));
  add('protected HTTP observation', scoped(p.protected) && p.protected.targetRole === 'after' && p.protected.status !== null ? 'supported' : 'missing', references('http', p.protected));
  const reached = hasReceipt(p.protected);
  const negativeCoverage = p.coverage.healthy && p.coverage.complete && p.coverage.gaps.length === 0 && p.coverage.watermark !== null && p.coverage.watermark >= p.protected.observedAt && p.coverage.windowStart <= p.protected.observedAt && p.coverage.producerSequence !== null;
  const coverageRefs = p.originEvidence.filter(e => e.targetRole === 'after' && e.source === 'origin' && (e.requestId === p.protected.requestId || e.requestId === null));
  add('protected stopped before origin', reached ? 'contradicted' : negativeCoverage ? 'supported' : 'missing', coverageRefs);
  return evaluateProof({ runId: p.runId, scenarioId: p.scenarioId, mode: p.mode, kind: 'edge-block', facts, requiredFacts: facts.map(f => f.name), unavailable: p.unavailable, skipped: p.skipped });
}
