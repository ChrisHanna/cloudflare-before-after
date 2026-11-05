import { z } from 'zod';
import type { WaitingRoomResult } from '../../../packages/demo-core/src/waiting-room.js';
import { WaitingRoomRecordSchema, BrowserFrameScopeSchema, BrowserFrameSchema, validateBrowserFrame, AdmittedNavigationSchema } from '../../../packages/contracts/src/waiting-room.js';
export { BrowserFrameScopeSchema, BrowserFrameSchema, validateBrowserFrame, AdmittedNavigationSchema };
import type { BrowserPreview } from '../../../packages/demo-core/src/browser-transport.js';

const SessionId = z.string().regex(/^session-[1-8]$/);
const Text = z.string().max(4096);
export const WaitingRoomViewSchema: z.ZodType<WaitingRoomResult> = WaitingRoomRecordSchema;
export const BrowserPreviewSchema: z.ZodType<BrowserPreview> = z.union([z.strictObject({
  sessionId: SessionId, mode: z.enum(['live', 'fixture']), observedAt: z.iso.datetime(),
  kind: z.literal('text'), text: Text, frame: z.null(),
}).refine(value => new TextEncoder().encode(value.text).length <= 4096, 'Preview byte cap'), BrowserFrameSchema]);

// Browser-safe defense in depth; the server must redact resolved secret values.
export function safePreviewText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:authorization|cookie|set-cookie|__cfwaitingroom|client[_-]?secret|password|token|assertion)\s*[:=]\s*[^\r\n<]+/gi, '[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED]');
}
export function observedCounts(result: WaitingRoomResult) {
  // Derive from the runner records; never trust an unrelated aggregate counter.
  return {
    queued: result.sessions.filter(s => s.lastObservedState === 'queued').length,
    admitted: result.sessions.filter(s => s.lastObservedState === 'admitted').length,
    unknown: result.sessions.filter(s => ['created', 'navigating', 'unknown', 'error'].includes(s.lastObservedState)).length,
  };
}
export const InterviewViewSchema = z.strictObject({
  mode: z.enum(['live', 'fixture', 'saved']), observedAt: z.iso.datetime(),
  stageIndex: z.number().int().min(0).max(4), elapsedMs: z.number().nonnegative().max(900000),
  requestsUsed: z.number().int().min(0).max(100), state: z.enum(['running', 'finished', 'stopped']),
  stageOutcome: z.enum(['pending', 'verified', 'failed', 'inconclusive', 'unavailable', 'skipped']),
  purpose: Text, action: Text, talkingPoints: z.array(Text).max(10), question: Text,
  missingProof: z.array(Text).max(100), fallback: z.strictObject({ capturedAt: z.iso.datetime(), eligible: z.boolean() }).nullable(),
});
export type InterviewView = z.infer<typeof InterviewViewSchema>;
export const INTERVIEW_STAGES = [
  { name: 'Paired storefronts', start: 0, end: 45000 },
  { name: 'WAF SQL signature', start: 45000, end: 105000 },
  { name: 'API abuse and rate limiting', start: 105000, end: 165000 },
  { name: 'Waiting Room', start: 165000, end: 240000 },
  { name: 'Analytics and customer outcomes', start: 240000, end: 300000 },
] as const;
export const ScopedReadinessSchema = z.strictObject({
  mode: z.enum(['live', 'fixture', 'saved']), observedAt: z.iso.datetime(), historical: z.boolean(),
  includedModules: z.array(z.string().regex(/^[a-z0-9-]{1,64}$/)).max(32),
  excludedModules: z.array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), reason: Text })).max(32),
  claims: z.strictObject({
    coreDeployed: z.boolean(), deploymentVerified: z.boolean(), interviewVerified: z.boolean(), workshopVerified: z.boolean(), fallbackAvailable: z.boolean(),
  }),
  blockers: z.array(z.strictObject({ claim: z.enum(['coreDeployed', 'deploymentVerified', 'interviewVerified', 'workshopVerified', 'fallbackAvailable']), reason: Text })).max(100),
});
export type ScopedReadiness = z.infer<typeof ScopedReadinessSchema>;
