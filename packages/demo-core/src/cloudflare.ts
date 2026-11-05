import { z } from 'zod';
import { Time } from '../../contracts/src/schemas.js';
import { GuardedClient } from './transport.js';
import { securityEventsBody, type SecurityEventQuery } from './graphql.js';
const CloudflareId = z.string().regex(/^[a-f0-9]{32}$/);
const Text = z.string().max(4096);
const ErrorItem = z.object({ code: z.number(), message: Text });
const Rule = z.object({ id: CloudflareId, ref: z.string().max(128).optional(), action: z.string().max(100), expression: Text, enabled: z.boolean().optional(), description: Text.optional() });
const Ruleset = z.object({ id: CloudflareId, name: Text, phase: Text, version: Text, rules: z.array(Rule).max(100).optional() });
const PageInfo = z.object({ page: z.number().int().positive(), total_pages: z.number().int().nonnegative() });
const Event = z.object({ datetime: Time, rayName: z.string().regex(/^[a-f0-9]{16}$/i), action: z.string().max(100), source: z.string().max(100), ruleId: z.string().max(128).nullable(), clientRequestHTTPHost: z.string().max(253), botScore: z.number().int().min(0).max(99).nullable().optional() });
const GraphqlResponse = z.object({
  data: z.object({ viewer: z.object({ zones: z.array(z.object({ firewallEventsAdaptive: z.array(Event).max(100) })).max(1) }) }).nullable().optional(),
  errors: z.array(z.object({ message: Text })).max(20).nullable().optional(),
});
export class CloudflareReadError extends Error {
  override name = 'CloudflareReadError';
  constructor(readonly state: 'permission-denied' | 'unknown' | 'misconfigured', message: string) { super(message); }
}
export class CloudflareReader {
  constructor(readonly client: GuardedClient, readonly token: string) { if (!token) throw new Error('Reader credential required'); }
  #headers() { return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }; }
  async #get<T extends z.ZodType>(path: string, schema: T, signal?: AbortSignal): Promise<z.infer<T>> {
    const envelope = z.object({ success: z.boolean(), result: schema.nullable(), errors: z.array(ErrorItem).max(30), result_info: PageInfo.optional() });
    const response = await this.client.requestJson({ url: `${this.client.config.apiOrigin}/client/v4${path}`, kind: 'cloudflare', headers: this.#headers() }, envelope, signal);
    if (response.status === 401 || response.status === 403) throw new CloudflareReadError('permission-denied', 'Cloudflare read permission unavailable');
    if (response.status === 404) throw new CloudflareReadError('unknown', 'Cloudflare resource or API unavailable');
    const result: unknown = Reflect.get(response.data, 'result');
    if (response.status !== 200 || !response.data.success || result === null || result === undefined) throw new CloudflareReadError('unknown', 'Cloudflare read failed');
    if (response.data.result_info && response.data.result_info.page < response.data.result_info.total_pages) throw new CloudflareReadError('unknown', 'Cloudflare pagination incomplete within this read plan');
    return schema.parse(result);
  }
  async rulesets(signal?: AbortSignal) {
    const zone = CloudflareId.parse(this.client.config.zoneId);
    const rulesets = await this.#get(`/zones/${zone}/rulesets?per_page=50&page=1`, z.array(Ruleset).max(50), signal);
    if (rulesets.length === 50) throw new CloudflareReadError('unknown', 'Ruleset pagination may be incomplete within this read plan');
    return rulesets;
  }
  async ruleset(id: string, signal?: AbortSignal) {
    const zone = CloudflareId.parse(this.client.config.zoneId); CloudflareId.parse(id);
    const result = await this.#get(`/zones/${zone}/rulesets/${id}`, Ruleset, signal);
    if (result.id !== id || !result.rules) throw new CloudflareReadError('misconfigured', 'Ruleset identity or rules missing');
    return { ...result, rules: result.rules.map((r, index) => ({ ...r, enabled: r.enabled ?? true, position: index })) };
  }
  async customWafEntrypoint(signal?: AbortSignal) {
    const zone = CloudflareId.parse(this.client.config.zoneId);
    return this.#get(`/zones/${zone}/rulesets/phases/http_request_firewall_custom/entrypoint`, Ruleset.extend({ kind: z.literal('zone'), phase: z.literal('http_request_firewall_custom'), rules: z.array(Rule).max(100) }), signal);
  }
  async waitingRooms(signal?: AbortSignal) {
    const zone = CloudflareId.parse(this.client.config.zoneId);
    return this.#get(`/zones/${zone}/waiting_rooms?per_page=100&page=1`, z.array(z.object({ id: CloudflareId, name: Text, host: Text, path: Text, total_active_users: z.number().int().nonnegative(), new_users_per_minute: z.number().int().nonnegative(), session_duration: z.number().nonnegative(), suspended: z.boolean() })).max(100), signal);
  }
  async accessApplications(signal?: AbortSignal) {
    const account = CloudflareId.parse(this.client.config.accountId);
    return this.#get(`/accounts/${account}/access/apps?per_page=100&page=1`, z.array(z.object({ id: z.string().max(128), name: Text, domain: Text.optional(), aud: Text.optional(), type: Text })).max(100), signal);
  }
  async turnstileWidgets(signal?: AbortSignal) {
    const account = CloudflareId.parse(this.client.config.accountId);
    return this.#get(`/accounts/${account}/challenges/widgets?per_page=100&page=1`, z.array(z.object({ sitekey: Text, name: Text, domains: z.array(Text).max(100), mode: Text })).max(100), signal);
  }
  async securityEvents(query: SecurityEventQuery, signal?: AbortSignal) {
    if (query.zoneId !== this.client.config.zoneId) throw new CloudflareReadError('misconfigured', 'Event query zone differs from configured lab');
    const allowed = this.client.config.environments.some(e => new URL(e.origin).hostname === query.hostname);
    if (!allowed) throw new CloudflareReadError('misconfigured', 'Event hostname is not a configured lab target');
    const response = await this.client.requestJson({ url: `${this.client.config.apiOrigin}/client/v4/graphql`, kind: 'cloudflare', method: 'POST', headers: this.#headers(), body: securityEventsBody(query) }, GraphqlResponse, signal);
    if (response.status === 401 || response.status === 403) throw new CloudflareReadError('permission-denied', 'Security event access unavailable');
    if (response.status !== 200 || response.data.errors?.length || !response.data.data || response.data.data.viewer.zones.length !== 1) throw new CloudflareReadError('unknown', 'Security events could not be read');
    const rows = response.data.data.viewer.zones[0]!.firewallEventsAdaptive;
    const matched = rows.filter(e => e.rayName.toLowerCase() === query.rayId.toLowerCase() && e.clientRequestHTTPHost === query.hostname && e.datetime >= query.start && e.datetime <= query.end);
    if (matched.length !== rows.length) throw new CloudflareReadError('unknown', 'Returned events do not match exact correlation window');
    return { source: 'firewallEventsAdaptive' as const, start: query.start, end: query.end, observedAt: new Date().toISOString(), sampling: 'adaptive-unknown' as const, complete: rows.length < query.limit, negativeEvidenceAllowed: false as const, events: matched, ambiguous: new Set(matched.map(e => `${e.rayName}:${e.source}:${e.ruleId}`)).size !== matched.length };
  }
}
