import { describe, it, expect } from 'vitest';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { BOT_USER_AGENT, readBotConfiguration } from '../packages/demo-core/src/bot-policy.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { desiredCustomWaf } from '../packages/demo-core/src/custom-waf.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { isApprovedReadGraphqlBody, securityEventsBody } from '../packages/demo-core/src/graphql.js';
import { controlFixture } from './fixtures/control.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
async function execute(f: ReturnType<typeof controlFixture>, mode: 'missing' | 'entitled' | 'unchanged' | 'score-hidden') {
  const lab = demoLabFixture(f.root, undefined, Date.now, mode); const agents: string[] = [];
  const output = await runDemoCli(['bot', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: async (url, init) => { if (url.endsWith('/catalog')) agents.push(new Headers(init.headers).get('user-agent') ?? ''); return lab.dispatch(url, init); } });
  return { ...output, ...lab, agents, data: JSON.parse(output.output) };
}
describe('bot-policy', () => {
  it('keeps unavailable Enterprise scoring out of core plans and blocks the explicitly selected bot profile', async () => {
    const f = controlFixture(); try {
      const provider = { mode: 'fixture' as const, inspect: async (key: string) => ({ state: key === 'bot-management' ? 'not-entitled' as const : 'available' as const, source: 'fixture', reasons: key === 'bot-management' ? ['Current scored subscription unavailable'] : [] }) };
      expect((await discoverCapabilities(f.config, 'core', provider)).deployable).toBe(true);
      expect((await discoverCapabilities(f.config, 'core-waf', provider)).includedModules).toEqual(['core', 'waf-custom']);
      const selected = await discoverCapabilities(f.config, 'bot', provider); expect(selected.deployable).toBe(false); expect(selected.blockers).toContain('bot-management'); expect(selected.includedModules).not.toContain('bot'); expect(f.calls).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it('returns unavailable without target traffic when only Bot Fight Mode configuration is exposed', async () => {
    const f = controlFixture(); try {
      const result = await execute(f, 'missing'); expect(result.exitCode).toBe(1); expect(result.data.report.result.outcome).toBe('unavailable'); expect(result.targets()).toBe(0);
      expect(result.data.report.botSummary).toMatchObject({ score: null, action: null, classification: 'unknown', subscriptionReadback: 'unavailable' });
    } finally { await f.cleanup(); }
  });
  it('joins an actual scored-policy event, owned rule and healthy origin proof with one declared automated client', async () => {
    const f = controlFixture(); try {
      const result = await execute(f, 'entitled'); expect(result.exitCode).toBe(0); expect(result.data.report.result).toMatchObject({ outcome: 'verified', requestsUsed: 24, scenarioId: 'bot' });
      expect(result.data.report.botSummary).toEqual({ userAgent: BOT_USER_AGENT, score: 5, action: 'block', classification: 'automated', subscriptionReadback: 'available' });
      expect(result.agents).toEqual(Array(4).fill(BOT_USER_AGENT));
      const rule = desiredCustomWaf(f.config.labId, f.config.environments[1].origin, 'bot'); expect(rule.expression).toContain('cf.bot_management.score gt 0 and cf.bot_management.score lt 30'); expect(rule.expression).not.toContain('before.example.test');
      expect(result.calls.filter(c => c.method !== 'GET').every(c => c.url.endsWith('/graphql'))).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('does not call unchanged automated-client behavior verified or invent a score/action', async () => {
    const f = controlFixture(); try {
      const result = await execute(f, 'unchanged'); expect(result.exitCode).toBe(1); expect(result.data.report.result.outcome).toBe('failed'); expect(result.data.report.botSummary).toMatchObject({ score: null, action: null, classification: 'unknown' });
    } finally { await f.cleanup(); }
  });
  it('leaves unavailable numeric scores unknown even if the correct rule blocked the request', async () => {
    const f = controlFixture(); try {
      const result = await execute(f, 'score-hidden'); expect(result.exitCode).toBe(1); expect(result.data.report.result.outcome).toBe('inconclusive'); expect(result.data.report.botSummary).toMatchObject({ score: null, action: 'block', classification: 'unknown' }); expect(result.data.report.result.requestsUsed).toBeLessThanOrEqual(30);
    } finally { await f.cleanup(); }
  });
  it('never promotes stale nested settings or partial premium fields to current subscription access', async () => {
    const f = controlFixture(); const ledger = new BudgetLedger(); try {
      const client = new GuardedClient(f.config, ledger, { purpose: 'discovery', observedOwnedResources: new Set(), dispatch: async () => new Response(JSON.stringify({ success: true, result: { using_latest_model: true, stale_zone_configuration: { auto_update_model: true, bm_cookie_enabled: true, enable_js: true, suppress_session_score: false } } })) });
      await expect(readBotConfiguration(client, f.credentials.reader)).rejects.toMatchObject({ state: 'unknown' });
    } finally { ledger.stop(); await f.cleanup(); }
  });
  it('allows only the fixed optional-score GraphQL read and rejects appended query text', () => {
    const input = { zoneId: 'a'.repeat(32), rayId: 'b'.repeat(16), hostname: 'after.example.test', start: '2026-11-04T00:00:00.000Z', end: '2026-11-04T00:00:01.000Z', limit: 10, botScore: true };
    const body = securityEventsBody(input); expect(isApprovedReadGraphqlBody(body)).toBe(true); expect(JSON.parse(body).query).toContain('clientRequestHTTPHost botScore');
    expect(isApprovedReadGraphqlBody(JSON.stringify({ query: JSON.parse(body).query + ' mutation Reset {}' }))).toBe(false);
  });
});
