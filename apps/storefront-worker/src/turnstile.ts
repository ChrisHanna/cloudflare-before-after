import { z } from 'zod';
import { requestSignal } from './runtime-transport.js';
import { Id, TurnstileConfigSchema, TurnstileReceiptSchema, type Receipt } from '../../../packages/contracts/src/schemas.js';
import type { Database } from './d1.js';
import { TEST_SECRET, TEST_SITEKEY, TEST_TOKEN } from '../../../packages/contracts/src/turnstile-test.js';
export { TEST_SECRET, TEST_SITEKEY, TEST_TOKEN };
const Siteverify = z.object({ success: z.boolean(), hostname: z.string().max(253).optional(), action: z.string().max(128).optional(), challenge_ts: z.iso.datetime().optional(), metadata: z.object({ result_with_testing_key: z.boolean().optional() }).optional() });
type Verification = z.infer<typeof TurnstileReceiptSchema>;
export interface TurnstileOptions { config: z.infer<typeof TurnstileConfigSchema>; secret?: string; dispatch?: typeof fetch; now?: () => number }
export class RegistrationVerifier {
  readonly config: z.infer<typeof TurnstileConfigSchema>; readonly now: () => number;
  constructor(readonly db: Database, readonly role: Receipt['targetRole'], readonly options: TurnstileOptions) {
    this.config = TurnstileConfigSchema.parse(options.config); this.now = options.now ?? Date.now;
    if ((role === 'before') !== (this.config.mode === 'disabled')) throw new Error('Verification bypass is Before-only');
    if (this.config.mode === 'test' && (this.config.sitekey !== TEST_SITEKEY || options.secret !== TEST_SECRET)) throw new Error('Test mode requires the documented test key pair');
    if (this.config.mode === 'live' && (!options.secret || options.secret.length < 24 || /^[123]x0+[A-Z]{2}$/.test(options.secret) || /^[123]x0+[A-Z]{2}$/.test(this.config.sitekey ?? ''))) throw new Error('Live verification cannot use test keys');
  }
  async verify(scope: { runId: string; requestId: string; recordId: string }, token: string | null, signal?: AbortSignal): Promise<Verification> {
    z.strictObject({ runId: Id, requestId: Id, recordId: Id }).parse(scope);
    const base = TurnstileReceiptSchema.parse({ schemaVersion: 1, id: crypto.randomUUID(), ...scope, targetRole: this.role, observedAt: new Date(this.now()).toISOString(), verificationMode: this.config.mode, accepted: false, reason: 'unavailable', siteverifyCalls: 0, persisted: false });
    if (await this.db.prepare('SELECT payload FROM turnstile_verifications WHERE request_id=?').bind(scope.requestId).first()) throw new Error('Request verification already recorded');
    const save = async (result: Partial<Verification>) => {
      const value = TurnstileReceiptSchema.parse({ ...base, ...result });
      await this.db.prepare('INSERT INTO turnstile_verifications(request_id,environment,scenario_id,run_id,record_id,payload) VALUES(?,?,?,?,?,?)').bind(scope.requestId, this.role, 'turnstile', scope.runId, scope.recordId, JSON.stringify(value)).run(); return value;
    };
    if (this.role === 'before') return save({ accepted: true, reason: 'baseline-only' });
    if (!token) return save({ reason: 'missing' });
    if (token.length > 2048) return save({ reason: 'invalid' });
    // Test tokens are intentionally reusable across independent test runs, never within one run.
    const replayScope = this.config.mode === 'test' ? `${scope.runId}:` : '';
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${replayScope}${token}`)); const digest = Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
    await this.db.prepare('DELETE FROM turnstile_claims WHERE expires_at<?').bind(this.now()).run();
    const claim = await this.db.prepare('INSERT INTO turnstile_claims(token_digest,expires_at) VALUES(?,?) ON CONFLICT(token_digest) DO NOTHING RETURNING token_digest').bind(digest, this.now() + 300000).first();
    if (!claim) return save({ reason: 'replay' });
    const remote = await this.#remote(token, scope.requestId, signal);
    return save({ accepted: remote.accepted, reason: remote.reason, siteverifyCalls: 1 });
  }
  // One Siteverify exchange; callers decide what, if anything, to persist.
  async #remote(token: string, idempotencyKey: string, signal?: AbortSignal): Promise<{ accepted: boolean; reason: 'accepted' | 'invalid' | 'unavailable' }> {
    try {
      const form = new URLSearchParams({ secret: this.options.secret!, response: token, idempotency_key: idempotencyKey });
      const response = await (this.options.dispatch ?? fetch)('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', redirect: 'manual', body: form, signal: requestSignal(signal) });
      if (response.status !== 200 || response.redirected) { await response.body?.cancel(); return { accepted: false, reason: 'unavailable' }; }
      const reader = response.body?.getReader(); let text = ''; let size = 0;
      if (reader) try { const decoder = new TextDecoder(); while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 8192) { await reader.cancel(); throw new Error('Verification response exceeds cap'); } text += decoder.decode(part.value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); }
      const data = Siteverify.parse(JSON.parse(text));
      const age = data.challenge_ts ? this.now() - Date.parse(data.challenge_ts) : Infinity;
      const bound = this.config.mode === 'test' ? data.metadata?.result_with_testing_key === true : data.hostname === this.config.hostname && data.action === this.config.action && age >= -5000 && age <= 300000;
      return { accepted: data.success && bound, reason: data.success && bound ? 'accepted' : 'invalid' };
    } catch { return { accepted: false, reason: 'unavailable' }; }
  }
  // Public form check: no D1 write and no replay claim, so anonymous traffic cannot grow storage.
  async check(token: string | null, signal?: AbortSignal): Promise<{ accepted: boolean; reason: 'baseline-only' | 'missing' | 'invalid' | 'accepted' | 'unavailable'; siteverifyCalls: 0 | 1 }> {
    if (this.role === 'before') return { accepted: true, reason: 'baseline-only', siteverifyCalls: 0 };
    if (!token) return { accepted: false, reason: 'missing', siteverifyCalls: 0 };
    if (token.length > 2048) return { accepted: false, reason: 'invalid', siteverifyCalls: 0 };
    return { ...(await this.#remote(token, crypto.randomUUID(), signal)), siteverifyCalls: 1 };
  }
  async markPersisted(receipt: Verification): Promise<void> {
    if (!receipt.accepted || receipt.targetRole !== this.role) throw new Error('Rejected verification cannot record a registration');
    await this.db.prepare('UPDATE turnstile_verifications SET payload=? WHERE request_id=? AND environment=? AND run_id=?').bind(JSON.stringify({ ...receipt, persisted: true }), receipt.requestId, this.role, receipt.runId).run();
  }
  async evidence(runId: string): Promise<{ receipts: Verification[]; truncated: boolean }> {
    const rows = await this.db.prepare('SELECT payload FROM turnstile_verifications WHERE environment=? AND scenario_id=? AND run_id=? ORDER BY request_id LIMIT 101').bind(this.role, 'turnstile', runId).all<{ payload: string }>();
    return { receipts: rows.results.slice(0, 100).map(row => TurnstileReceiptSchema.parse(JSON.parse(row.payload))), truncated: rows.results.length > 100 };
  }
}
