import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { CloudflareReader } from '../packages/demo-core/src/cloudflare.js';
import { isApprovedReadGraphqlBody, securityEventsBody } from '../packages/demo-core/src/graphql.js';
import { labConfig } from './fixtures/lab.js';
import { TestClock } from './fixtures/clock.js';
const token = 'fixture-cloudflare-read-canary-secret';
const query = { zoneId: 'd'.repeat(32), start: '2026-11-04T00:00:00.000Z', end: '2026-11-04T00:01:00.000Z', rayId: 'abcdef0123456789', hostname: 'before.example.test', limit: 10 };
function fixture(dispatch: (url: string, init: RequestInit) => Promise<Response>) {
  const config = labConfig(); config.liveOptIn = true;
  const ledger = new BudgetLedger({ clock: new TestClock() });
  const client = new GuardedClient(config, ledger, { dispatch, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)) });
  return { ledger, client, reader: new CloudflareReader(client, token) };
}
const graph = (rows: unknown[]) => new Response(JSON.stringify({ data: { viewer: { zones: [{ firewallEventsAdaptive: rows }] } } }), { headers: { 'content-type': 'application/json' } });
const event = { datetime: query.start, rayName: query.rayId, action: 'block', source: 'waf', ruleId: 'f'.repeat(32), clientRequestHTTPHost: query.hostname };
describe('cloudflare-readers', () => {
  it('only authorizes the canonical bounded read-only GraphQL query', async () => {
    const body = securityEventsBody(query); expect(isApprovedReadGraphqlBody(body)).toBe(true);
    for (const bad of [body.replace('query SecurityEvents', 'mutation SecurityEvents'), body.replace('action source', 'action token'), JSON.stringify({ query: 'query { viewer { accounts { id } } }' }), body.replace('limit: 10', 'limit: 10000')]) expect(isApprovedReadGraphqlBody(bad)).toBe(false);
    const dispatch = vi.fn(async () => graph([event])); const f = fixture(dispatch);
    await expect(f.client.request({ url: 'https://api.cloudflare.com/client/v4/graphql', kind: 'cloudflare', method: 'POST', body: '{"query":"mutation { destroy }"}' })).rejects.toThrow('read-only');
    expect(dispatch).not.toHaveBeenCalled(); f.ledger.stop();
  });
  it('joins actual returned event fields and discloses adaptive sampling', async () => {
    const dispatch = vi.fn(async (url: string, init: RequestInit) => { expect(url).toBe('https://api.cloudflare.com/client/v4/graphql'); expect(init.method).toBe('POST'); expect(isApprovedReadGraphqlBody(init.body as string)).toBe(true); return graph([{ ...event, token }]); });
    const f = fixture(dispatch); const result = await f.reader.securityEvents(query);
    expect(result).toMatchObject({ sampling: 'adaptive-unknown', negativeEvidenceAllowed: false, complete: true, ambiguous: false });
    expect(result.events).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(token); expect(f.ledger.snapshot.requestsUsed).toBe(1); f.ledger.stop();
  });
  it('does not interpret missing, sampled, truncated or ambiguous data as negative proof', async () => {
    for (const rows of [[], [event, event]]) {
      const f = fixture(async () => graph(rows)); const result = await f.reader.securityEvents({ ...query, limit: 2 });
      expect(result.negativeEvidenceAllowed).toBe(false);
      if (rows.length === 2) { expect(result.complete).toBe(false); expect(result.ambiguous).toBe(true); }
      f.ledger.stop();
    }
    const f = fixture(async () => graph([{ ...event, rayName: '1'.repeat(16) }]));
    await expect(f.reader.securityEvents(query)).rejects.toThrow('correlation'); f.ledger.stop();
  });
  it('rejects GraphQL errors, wrong scope and denied event reads honestly', async () => {
    const denied = fixture(async () => new Response('{"errors":[{"message":"access denied"}]}', { status: 403 }));
    await expect(denied.reader.securityEvents(query)).rejects.toMatchObject({ state: 'permission-denied' }); denied.ledger.stop();
    const f = fixture(async () => new Response('{"data":null,"errors":[{"message":"unsupported query"}]}'));
    await expect(f.reader.securityEvents(query)).rejects.toMatchObject({ state: 'unknown' });
    await expect(f.reader.securityEvents({ ...query, hostname: 'evil.test' })).rejects.toThrow('lab target');
    await expect(f.reader.securityEvents({ ...query, zoneId: 'e'.repeat(32) })).rejects.toThrow('zone'); f.ledger.stop();
  });
  it('reads supported ruleset REST paths, position and explicit incomplete pages', async () => {
    const id = 'f'.repeat(32);
    const f = fixture(async (url, init) => {
      expect(init.method).toBe('GET'); expect(url).toContain(`/zones/${query.zoneId}/rulesets`);
      return new Response(JSON.stringify({ success: true, result: { id, name: 'Lab', phase: 'http_request_firewall_custom', version: '1', rules: [{ id, action: 'block', expression: '(http.host eq "after.example.test")', enabled: true }] }, errors: [] }));
    });
    expect((await f.reader.ruleset(id)).rules[0]).toMatchObject({ position: 0, enabled: true }); f.ledger.stop();
    const paged = fixture(async () => new Response(JSON.stringify({ success: true, result: [], errors: [], result_info: { page: 1, total_pages: 2 } })));
    await expect(paged.reader.rulesets()).rejects.toThrow('pagination'); paged.ledger.stop();
    const denied = fixture(async () => new Response('{"success":false,"result":null,"errors":[{"code":10000,"message":"denied"}]}', { status: 403 }));
    await expect(denied.reader.rulesets()).rejects.toMatchObject({ state: 'permission-denied' }); denied.ledger.stop();
  });
  it('accepts Cloudflare GraphQL errors:null only with valid scoped data', async () => {
    const f = fixture(async () => Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: [] }] } }, errors: null }));
    const result = await f.reader.securityEvents(query);
    expect(result.events).toEqual([]); expect(result.negativeEvidenceAllowed).toBe(false); f.ledger.stop();
    for (const data of [null, { viewer: { zones: [] } }]) {
      const denied = fixture(async () => Response.json({ data, errors: null }));
      await expect(denied.reader.securityEvents(query)).rejects.toThrow(); denied.ledger.stop();
    }
  });
  it('uses the live maximum ruleset page size and rejects a possibly truncated list', async () => {
    const row = { id: 'f'.repeat(32), name: 'Lab', phase: 'http_request_firewall_custom', version: '1' };
    for (const count of [4, 50]) {
      const f = fixture(async (url, init) => {
        expect(init.method).toBe('GET'); expect(new URL(url).searchParams.get('per_page')).toBe('50');
        return Response.json({ success: true, result: Array.from({ length: count }, () => row), errors: [] });
      });
      if (count === 50) await expect(f.reader.rulesets()).rejects.toThrow('pagination');
      else expect(await f.reader.rulesets()).toHaveLength(4);
      f.ledger.stop();
    }
  });
  it('schema-strips unapproved JSON fields before publishing excerpts', async () => {
    const f = fixture(async () => new Response(JSON.stringify({ allowed: 'safe', private_key: 'unregistered-private-material' })));
    const response = await f.client.requestJson({ url: 'https://api.cloudflare.com/client/v4/zones', kind: 'cloudflare' }, z.object({ allowed: z.string() }));
    expect(response.data).toEqual({ allowed: 'safe' }); expect(response.excerpt).not.toContain('private'); f.ledger.stop();
  });
});
