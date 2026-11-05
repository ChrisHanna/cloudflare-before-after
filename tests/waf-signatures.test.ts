import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { desiredCustomWaf, inspectCustomWaf, type CustomWafRuleset, type CustomWafSetupApi } from '../packages/demo-core/src/custom-waf.js';
import { WafModule } from '../packages/demo-core/src/product-state.js';
import { provisionWafModules } from '../packages/demo-core/src/waf-modules.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import type { SetupContext } from '../packages/demo-core/src/deployment-apply.js';
import type { Dispatch } from '../packages/demo-core/src/transport.js';
import { controlFixture } from './fixtures/control.js';
async function execute(f: ReturnType<typeof controlFixture>, module: 'waf-sqli' | 'waf-xss', dispatch = f.dispatch, flags: string[] = []) {
  const result = await runDemoCli([module, '--json', ...flags], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch });
  return { ...result, data: JSON.parse(result.output) };
}
describe('waf-signatures', () => {
  it.each(['waf-sqli', 'waf-xss'] as const)('runs %s through the shared CLI, exact custom rule, paired controls, receipts and immutable report', async module => {
    const f = controlFixture(); try {
      const output = await execute(f, module); expect(output.exitCode).toBe(0);
      expect(output.data.report).toMatchObject({ mode: 'fixture', result: { scenarioId: module, outcome: 'verified', requestsUsed: 22 } });
      const runId = output.data.report.result.runId; const store = new ReportStore(f.root, f.config.evidenceDirectory); const artifacts = store.loadArtifacts(runId);
      expect(artifacts.filter(a => a.source === 'http')).toHaveLength(4);
      const rule = artifacts.find(a => a.source === 'configuration')!.payload as any;
      expect(rule.product).toBe('Custom WAF rules'); expect(rule.ref).toBe(`cf-demo-${f.config.labId}-${module}`);
      const edges = artifacts.filter(a => a.source === 'cloudflare'); expect(edges).toHaveLength(1);
      expect((edges[0]!.payload as any).ruleId).toBe((module === 'waf-sqli' ? 'd' : 'e').repeat(32)); expect((edges[0]!.payload as any).product).toBe('firewallrules');
      expect(artifacts.filter(a => a.source === 'origin' && 'stage' in a.payload && a.payload.stage === 'entry')).toHaveLength(3);
      expect(artifacts.every(a => a.scenarioId === module && a.runId === runId)).toBe(true);
      const html = store.loadHtml(runId); expect(html).toContain('Custom WAF rules'); expect(html).not.toContain('<script>synthetic_inert_signature</script>');
      if (module === 'waf-xss') expect(html).toContain('&lt;script&gt;synthetic_inert_signature&lt;/script&gt;');
      for (const secret of Object.values(f.credentials)) expect(html).not.toContain(secret);
    } finally { await f.cleanup(); }
  });
  it('keeps all three rule inventories owned and separates repeat runs and both signature markers', async () => {
    const f = controlFixture(); try {
      f.config.inventory.push(...['d', 'e'].map(id => ({ type: 'policy' as const, id: id.repeat(32), role: 'after' as const, labId: f.config.labId })));
      const a = await execute(f, 'waf-sqli'); const b = await execute(f, 'waf-xss'); expect([a.exitCode, b.exitCode]).toEqual([0, 0]); expect(a.data.report.result.runId).not.toBe(b.data.report.result.runId);
      const desired = WafModule.options.filter(module => module !== 'bot').map(module => desiredCustomWaf(f.config.labId, f.config.environments[1].origin, module));
      expect(new Set(desired.map(d => d.marker)).size).toBe(3); expect(desired.every(d => d.expression.includes('after.example.test') && !d.expression.includes('before.example.test') && d.expression.includes('/catalog'))).toBe(true);
    } finally { await f.cleanup(); }
  });
  it.each(['wrong-rule', 'managed-label', 'origin-arrival', 'no-trigger'] as const)('refuses %s as signature mitigation proof', async fault => {
    const f = controlFixture(); try {
      let protectedRequest: { runId: string; requestId: string; observedAt: string } | null = null;
      const dispatch: Dispatch = async (url, init) => {
        const u = new URL(url); const headers = new Headers(init.headers);
        if (u.origin === f.config.environments[1].origin && u.pathname === '/catalog' && headers.has('x-demo-test')) {
          protectedRequest = { runId: headers.get('x-demo-run-id')!, requestId: headers.get('x-demo-request-id')!, observedAt: new Date().toISOString() };
          if (fault === 'no-trigger') { headers.delete('x-demo-test'); init = { ...init, headers }; }
        }
        const response = await f.dispatch(url, init);
        if (u.pathname.endsWith('/graphql') && (fault === 'wrong-rule' || fault === 'managed-label')) { const data = await response.json() as any; const event = data.data.viewer.zones[0].firewallEventsAdaptive[0]; if (event) { if (fault === 'wrong-rule') event.ruleId = 'f'.repeat(32); else event.source = 'firewallManaged'; } return new Response(JSON.stringify(data)); }
        if (fault === 'origin-arrival' && u.origin === f.config.telemetryOrigin && u.searchParams.get('role') === 'after' && protectedRequest) {
          const data = await response.json() as any; data.receipts.push({ schemaVersion: 1, id: randomUUID(), ...protectedRequest, scenarioId: 'waf-xss', targetRole: 'after', producerId: 'after-fixture', sequence: 2, rayId: null, releaseDigest: f.config.environments[1].releaseDigest, stage: 'entry' }); return new Response(JSON.stringify(data));
        }
        return response;
      };
      const output = await execute(f, 'waf-xss', dispatch); expect(output.exitCode).toBe(1); expect(output.data.report.result.outcome).not.toBe('verified');
      if (fault === 'origin-arrival' || fault === 'no-trigger') expect(output.data.report.result.outcome).toBe('failed');
    } finally { await f.cleanup(); }
  });
  it('rejects undersized budgets and keeps signature dry-runs offline', async () => {
    const f = controlFixture(); try {
      const dry = await execute(f, 'waf-sqli', f.dispatch, ['--dry-run']); expect(dry.exitCode).toBe(0); expect(dry.data.plan).toBeUndefined(); expect(dry.data.networkCalls).toBe(0);
      expect((await execute(f, 'waf-xss', f.dispatch, ['--requests', '5'])).exitCode).toBe(2); expect(f.calls).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it('plans only the three WAF modules for the explicit signature profile', async () => {
    const f = controlFixture(); try {
      const snapshot = await discoverCapabilities(f.config, 'waf-signatures', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) });
      expect(snapshot.includedModules).toEqual(['core', 'waf-custom', 'waf-sqli', 'waf-xss']); expect(snapshot.deployable).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('rejects sibling-rule drift before any setup mutation', async () => {
    const f = controlFixture(); try {
      const rule = desiredCustomWaf(f.config.labId, f.config.environments[1].origin, 'waf-sqli'); let writes = 0;
      const state: CustomWafRuleset = { id: 'a'.repeat(32), kind: 'zone', phase: 'http_request_firewall_custom', version: '1', rules: [] };
      const api: CustomWafSetupApi = { entrypoint: async () => structuredClone(state), create: async () => { writes++; }, append: async () => { writes++; }, enable: async () => { writes++; } };
      const expected = (await inspectCustomWaf(api, rule)).state; state.version = '2';
      const context = { signal: new AbortController().signal, plan: { includedModules: ['core', 'waf-sqli'] }, perform: async (_kind: string, _id: string, action: () => Promise<unknown>) => action(), observeResource: () => {} } as unknown as SetupContext;
      await expect(provisionWafModules(() => api, f.config.labId, f.config.environments[1].origin, ['waf-sqli'], [expected], context)).rejects.toThrow('drift'); expect(writes).toBe(0);
    } finally { await f.cleanup(); }
  });
});
