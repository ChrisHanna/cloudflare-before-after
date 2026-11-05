import { z } from 'zod';
import { Time } from '../../contracts/src/schemas.js';
const Args = z.strictObject({
  zoneId: z.string().regex(/^[a-f0-9]{32}$/), start: Time, end: Time,
  rayId: z.string().regex(/^[a-f0-9]{16}$/i),
  hostname: z.string().regex(/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)+$/),
  limit: z.number().int().min(1).max(100), botScore: z.boolean().optional(),
}).refine(v => v.start <= v.end && Date.parse(v.end) - Date.parse(v.start) <= 900000, 'Invalid event window');
export type SecurityEventQuery = z.infer<typeof Args>;
// No caller-supplied query language: only this fixed read operation is permitted.
export function securityEventsBody(input: SecurityEventQuery): string {
  const a = Args.parse(input);
  return JSON.stringify({ query: `query SecurityEvents { viewer { zones(filter: { zoneTag: "${a.zoneId}" }) { firewallEventsAdaptive(limit: ${a.limit}, filter: { datetime_geq: "${a.start}", datetime_leq: "${a.end}", rayName: "${a.rayId}", clientRequestHTTPHost: "${a.hostname}" }, orderBy: [datetime_ASC]) { datetime rayName action source ruleId clientRequestHTTPHost${a.botScore ? ' botScore' : ''} } } } }` });
}
const DdosArgs = z.strictObject({ zoneId: Args.shape.zoneId, start: Args.shape.start, end: Args.shape.end, hostname: Args.shape.hostname, limit: Args.shape.limit });
export function ddosEventsBody(input: z.infer<typeof DdosArgs>): string {
  const a = DdosArgs.parse(input);
  if (a.start >= a.end || Date.parse(a.end) - Date.parse(a.start) > 900000) throw new Error('DDoS window exceeds the bounded read plan');
  return JSON.stringify({ query: `query DdosEvents { viewer { zones(filter: { zoneTag: "${a.zoneId}" }) { firewallEventsAdaptive(limit: ${a.limit}, filter: { datetime_geq: "${a.start}", datetime_leq: "${a.end}", source: "l7ddos", clientRequestHTTPHost: "${a.hostname}" }, orderBy: [datetime_ASC]) { datetime rayName action source ruleId clientRequestHTTPHost } } } }` });
}
export function isApprovedReadGraphqlBody(body: string | undefined): boolean {
  try {
    const parsed = z.strictObject({ query: z.string().max(4096) }).parse(JSON.parse(body ?? 'null'));
    const strings = [...parsed.query.matchAll(/"([^"\\]*)"/g)].map(m => m[1]);
    const limit = /firewallEventsAdaptive\(limit: (\d+),/.exec(parsed.query)?.[1];
    if (strings.length !== 5 || !limit) return false;
    if (strings[3] === 'l7ddos') {
      const args = DdosArgs.parse({ zoneId: strings[0], start: strings[1], end: strings[2], hostname: strings[4], limit: Number(limit) });
      return JSON.parse(ddosEventsBody(args)).query === parsed.query;
    }
    const args = Args.parse({ zoneId: strings[0], start: strings[1], end: strings[2], rayId: strings[3], hostname: strings[4], limit: Number(limit) });
    return JSON.parse(securityEventsBody(args)).query === parsed.query || JSON.parse(securityEventsBody({ ...args, botScore: true })).query === parsed.query;
  } catch { return false; }
}
