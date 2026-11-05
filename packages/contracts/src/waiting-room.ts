import { z } from 'zod';
export const BrowserFrameScopeSchema = z.strictObject({ ownerId: z.uuid(), runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), sessionId: z.string().regex(/^session-[1-8]$/), releaseDigest: z.string().regex(/^[a-f0-9]{64}$/) });
export const BrowserFrameSchema = BrowserFrameScopeSchema.extend({
  mode: z.enum(['live', 'fixture']), observedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  kind: z.literal('frame'), text: z.literal(''), frame: z.string().max(262166).regex(/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/),
  width: z.number().int().min(1).max(800), height: z.number().int().min(1).max(600),
}).refine(value => {
  const age = Date.parse(value.expiresAt) - Date.parse(value.observedAt);
  try {
    const bytes = Uint8Array.from(atob(value.frame.slice(22, 66)), char => char.charCodeAt(0));
    const header = new DataView(bytes.buffer);
    return age > 0 && age <= 5000 && header.getUint32(16) === value.width && header.getUint32(20) === value.height;
  } catch { return false; }
}, 'Bounded PNG frame required');
export function validateBrowserFrame(value: unknown, scope: z.infer<typeof BrowserFrameScopeSchema>, mode: 'live' | 'fixture', now = Date.now()): z.infer<typeof BrowserFrameSchema> {
  const frame = BrowserFrameSchema.parse(value); const expected = BrowserFrameScopeSchema.parse(scope);
  if ((Object.keys(expected) as (keyof typeof expected)[]).some(key => frame[key] !== expected[key]) || frame.mode !== mode) throw new Error('Foreign preview scope');
  if (Date.parse(frame.observedAt) > now || Date.parse(frame.expiresAt) <= now) throw new Error('Stale or future preview');
  return frame;
}
export const AdmittedNavigationSchema = z.strictObject({ scope: BrowserFrameScopeSchema, path: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/).max(256) });
const State = z.enum(['created', 'navigating', 'queued', 'admitted', 'unknown', 'error', 'closed']);
const Text = z.string().max(4096);
/** Shared bounded persistence/UI contract. Cookie values and frames are absent. */
export const WaitingRoomRecordSchema = z.strictObject({
  mode: z.enum(['live', 'fixture']), outcome: z.enum(['verified', 'failed', 'inconclusive', 'unavailable']),
  fixtureAssertionsPassed: z.boolean(), liveReadiness: z.boolean(),
  sessions: z.array(z.strictObject({
    sessionId: z.string().regex(/^session-[1-8]$/), role: z.enum(['before', 'after']), state: State, lastObservedState: State,
    queuePosition: z.null(), estimatedWaitMs: z.null(), cookieContinuity: z.boolean(),
    transitions: z.array(z.strictObject({ from: State, to: State, observedAt: z.iso.datetime(), requestId: z.uuid().nullable() })).max(257),
  })).max(8).refine(rows => new Set(rows.map(s => s.sessionId)).size === rows.length, 'Duplicate session'),
  counts: z.strictObject({ queued: z.number().int().min(0).max(8), admitted: z.number().int().min(0).max(8), unknown: z.number().int().min(0).max(8) }),
  missingProof: z.array(Text).max(100), contradictions: z.array(Text).max(100), limitation: Text,
}).superRefine((value, ctx) => {
  if (value.mode === 'fixture' && (value.liveReadiness || value.outcome === 'verified')) ctx.addIssue({ code: 'custom', message: 'Fixture cannot claim live Waiting Room proof' });
});
