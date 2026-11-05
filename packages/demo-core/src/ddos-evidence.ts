import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Mode, Time } from '../../contracts/src/schemas.js';

const Host = z.string().regex(/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const Identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const DdosSelectionSchema = z.strictObject({
  source: z.literal('firewallEventsAdaptive'), zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  hostname: Host, start: Time, end: Time, mode: Mode, limit: z.number().int().min(1).max(100),
}).refine(v => Date.parse(v.start) < Date.parse(v.end), 'Evidence window must increase');
export type DdosSelection = z.infer<typeof DdosSelectionSchema>;
const EventSchema = z.strictObject({
  datetime: Time, rayName: z.string().regex(/^[a-f0-9]{16}$/i), source: Identifier,
  action: Identifier, ruleId: Identifier.nullable(), clientRequestHTTPHost: Host,
});
export const DdosCaptureSchema = z.strictObject({
  source: z.literal('firewallEventsAdaptive'), zoneId: z.string().regex(/^[a-f0-9]{32}$/),
  hostname: Host, start: Time, end: Time, mode: Mode, observedAt: Time,
  sampling: z.enum(['complete', 'sampled', 'unknown']), complete: z.boolean(),
  ingestionDelayMs: z.number().nonnegative().nullable(), events: z.array(EventSchema).max(100),
});
export type DdosCapture = z.infer<typeof DdosCaptureSchema>;
export interface DdosReview {
  outcome: 'verified' | 'inconclusive' | 'unavailable';
  label: 'FIXTURE' | 'SAVED EVIDENCE' | 'HISTORICAL EVENT EVIDENCE';
  selection: DdosSelection; observedAt: string | null; artifactDigest: string | null;
  sampling: DdosCapture['sampling']; complete: boolean; ingestionDelayMs: number | null;
  events: { eventTime: string; rayId: string; ruleId: string; action: string; kind: 'detection' | 'mitigation' }[];
  missingProof: string[]; limitations: string[]; currentApplicationResilienceProven: false;
}
const limitations = [
  'Evidence review only; no attack traffic is generated.',
  'Historical events do not prove current application resilience or measured attack impact.',
  'Sampling and API delay may omit events; event absence is not proof of no attack.',
];
function empty(selection: DdosSelection): DdosReview {
  return { outcome: 'unavailable', label: selection.mode === 'fixture' ? 'FIXTURE' : selection.mode === 'saved' ? 'SAVED EVIDENCE' : 'HISTORICAL EVENT EVIDENCE', selection,
    observedAt: null, artifactDigest: null, sampling: 'unknown', complete: false, ingestionDelayMs: null,
    events: [], missingProof: [], limitations: [...limitations], currentApplicationResilienceProven: false };
}
/** Reviews normalized provider records, never HTTP statuses or dashboard availability. */
export function reviewDdosEvidence(input: DdosSelection, raw: unknown): DdosReview {
  const selection = DdosSelectionSchema.parse(input); const capture = DdosCaptureSchema.parse(raw);
  for (const key of ['source', 'zoneId', 'hostname', 'start', 'end', 'mode'] as const) {
    if (selection[key] !== capture[key]) throw new Error('DDoS evidence provenance mismatch');
  }
  if (Date.parse(capture.observedAt) < Date.parse(selection.end) || capture.events.length > selection.limit) throw new Error('DDoS capture time or limit mismatch');
  if (capture.events.some(e => e.clientRequestHTTPHost !== selection.hostname || Date.parse(e.datetime) < Date.parse(selection.start) || Date.parse(e.datetime) > Date.parse(selection.end))) throw new Error('DDoS event outside selected host/window');
  const result = empty(selection); result.observedAt = capture.observedAt;
  result.sampling = capture.sampling; result.complete = capture.complete; result.ingestionDelayMs = capture.ingestionDelayMs;
  result.artifactDigest = createHash('sha256').update(JSON.stringify(capture)).digest('hex');
  const events = new Map<string, DdosReview['events'][number]>();
  for (const e of capture.events) {
    // Cloudflare HTTP DDoS Security Events source. Generic WAF blocks are not DDoS.
    if (e.source !== 'l7ddos' || !e.ruleId) continue;
    const kind = e.action === 'log' ? 'detection' : ['block', 'managed_challenge', 'js_challenge', 'challenge'].includes(e.action) ? 'mitigation' : null;
    if (!kind) continue;
    const event: DdosReview['events'][number] = { eventTime: e.datetime, rayId: e.rayName.toLowerCase(), ruleId: e.ruleId, action: e.action, kind };
    events.set(`${event.rayId}:${event.ruleId}:${event.action}:${Date.parse(event.eventTime)}`, event);
  }
  result.events = [...events.values()];
  if (!result.events.length) result.missingProof.push('No genuine DDoS detection or mitigation evidence is available.');
  if (selection.mode === 'fixture') result.missingProof.push('Fixture data is not a Cloudflare observation.');
  if (!capture.complete || capture.events.length === selection.limit) result.missingProof.push('Selected event pages are incomplete or reach the read limit.');
  result.outcome = !result.events.length ? 'unavailable' : result.missingProof.length ? 'inconclusive' : 'verified';
  return result;
}
export class DdosEvidenceReadError extends Error {
  constructor(readonly state: 'permission-denied' | 'not-entitled' | 'unavailable' | 'unknown') { super('DDoS evidence source could not be read'); }
}
/** Inject only an authorized, permit-metered, read-only provider. No traffic client exists here. */
export interface DdosEvidenceReader { read(selection: Readonly<DdosSelection>, signal?: AbortSignal): Promise<unknown> }
export async function collectDdosEvidence(input: DdosSelection, reader: DdosEvidenceReader, signal?: AbortSignal): Promise<DdosReview> {
  const selection = DdosSelectionSchema.parse(input); signal?.throwIfAborted();
  let raw: unknown;
  try { raw = await reader.read(Object.freeze({ ...selection }), signal); }
  catch (error) {
    signal?.throwIfAborted();
    const result = empty(selection);
    result.missingProof = [error instanceof DdosEvidenceReadError ? `Evidence source state: ${error.state}.` : 'Evidence read failed; source remains unknown.'];
    return result;
  }
  signal?.throwIfAborted();
  return reviewDdosEvidence(selection, raw);
}
