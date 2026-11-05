import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { desiredCustomWaf, inspectCustomWaf, provisionCustomWaf, type CustomWafRuleset, type CustomWafSetupApi } from '../packages/demo-core/src/custom-waf.js';
import { createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import type { SetupContext } from '../packages/demo-core/src/deployment-apply.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(profile: 'core' | 'core-waf' = 'core-waf') {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'waf-policy-')); roots.push(root); const intent = deploymentIntent(root); intent.profile = profile;
  const capability = await discoverCapabilities(intent.discovery, profile, { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) });
  const plan = createDeploymentPlan(intent, capability, 'a'.repeat(64), root);
  const context: SetupContext = { plan, signal: new AbortController().signal, perform: async <T>(_kind: string, _id: string, run: () => Promise<T>): Promise<T> => run(), observeResource: vi.fn() };
  const desired = desiredCustomWaf(intent.discovery.labId, intent.discovery.environments[1].origin);
  return { root, intent, plan, context, desired };
}
describe('custom-waf-policy', () => {
  it('creates only the narrow After/catalog/header block and preserves foreign rules', async () => {
    const f = await fixture();
    const foreign = { id: 'b'.repeat(32), ref: 'another-project', action: 'log', expression: '(http.host eq "other.example.test")', enabled: true };
    let ruleset: CustomWafRuleset = { id: 'a'.repeat(32), kind: 'zone', phase: 'http_request_firewall_custom', version: '1', rules: [foreign] };
    const api: CustomWafSetupApi = { entrypoint: async () => structuredClone(ruleset), create: vi.fn(async () => { throw new Error('Unexpected root replacement'); }), append: vi.fn(async (id, rule) => { expect(id).toBe(ruleset.id); ruleset.rules.push({ id: 'c'.repeat(32), ...rule }); ruleset.version = '2'; }), enable: vi.fn(async () => {}) };
    const original = await inspectCustomWaf(api, f.desired);
    expect(f.desired.expression).toContain('http.host eq "after.example.test"'); expect(f.desired.expression).toContain('http.request.uri.path eq "/catalog"'); expect(f.desired.expression).not.toContain('before.example.test');
    const final = await provisionCustomWaf(api, f.desired, original.state, f.context);
    expect(api.append).toHaveBeenCalledOnce(); expect(api.create).not.toHaveBeenCalled(); expect(ruleset.rules[0]).toEqual(foreign); expect(final.rule?.id).toBe('c'.repeat(32));
    await provisionCustomWaf(api, f.desired, final.state, f.context); expect(api.append).toHaveBeenCalledOnce();
    expect(f.context.observeResource).toHaveBeenCalledWith('custom-waf-rule', 'c'.repeat(32));
  });
  it('only enables an owned exact rule and refuses altered scope, duplicate refs or stale state', async () => {
    const f = await fixture(); let ruleset: CustomWafRuleset = { id: 'a'.repeat(32), kind: 'zone', phase: 'http_request_firewall_custom', version: '1', rules: [{ id: 'c'.repeat(32), ...f.desired, enabled: false }] };
    const api: CustomWafSetupApi = { entrypoint: async () => structuredClone(ruleset), create: vi.fn(async () => {}), append: vi.fn(async () => {}), enable: vi.fn(async () => { ruleset.rules[0]!.enabled = true; ruleset.version = '2'; }) };
    const initial = await inspectCustomWaf(api, f.desired); await provisionCustomWaf(api, f.desired, initial.state, f.context); expect(api.enable).toHaveBeenCalledOnce();
    await expect(provisionCustomWaf(api, f.desired, initial.state, f.context)).rejects.toThrow('drift');
    ruleset.rules[0]!.expression = '(http.host eq "before.example.test")';
    const mismatch = await inspectCustomWaf(api, f.desired); expect(mismatch.state.owned).toBe(false);
    await expect(provisionCustomWaf(api, f.desired, mismatch.state, f.context)).rejects.toThrow('ownership');
    ruleset.rules.push({ ...ruleset.rules[0]! }); await expect(inspectCustomWaf(api, f.desired)).rejects.toThrow('ambiguous');
    expect(api.enable).toHaveBeenCalledOnce(); expect(api.append).not.toHaveBeenCalled();
  });
  it('records safe unowned-state digests without hashing foreign expression secrets', async () => {
    const f = await fixture(); const rule = { id: 'c'.repeat(32), ...f.desired, expression: 'foreign-secret-value-one' };
    const api = { entrypoint: async () => ({ id: 'a'.repeat(32), kind: 'zone' as const, phase: 'http_request_firewall_custom' as const, version: '1', rules: [rule] }) };
    const first = await inspectCustomWaf(api, f.desired); rule.expression = 'foreign-secret-value-two'; const second = await inspectCustomWaf(api, f.desired);
    expect(first.state.digest).toBe(second.state.digest); expect(JSON.stringify(first.state)).not.toContain('foreign-secret'); expect(first.state.owned).toBe(false);
  });
  it('omits all custom policy writes from core-only plans', async () => {
    const f = await fixture('core'); expect(f.plan.steps.some(s => s.kind === 'product-policy')).toBe(false);
    const api = { entrypoint: vi.fn(async () => null), create: vi.fn(async () => {}), append: vi.fn(async () => {}), enable: vi.fn(async () => {}) };
    const initial = await inspectCustomWaf(api, f.desired);
    await expect(provisionCustomWaf(api, f.desired, initial.state, f.context)).rejects.toThrow('not selected'); expect(api.create).not.toHaveBeenCalled();
  });
  it('uses the supported single-rule append API, never a full foreign-ruleset replacement', async () => {
    const f = await fixture(); let row: CustomWafRuleset = { id: 'a'.repeat(32), kind: 'zone', phase: 'http_request_firewall_custom', version: '1', rules: [] };
    const writes: { url: string; method: string; body: any }[] = [];
    const dispatch = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method !== 'GET') {
        writes.push({ url, method: init.method!, body: JSON.parse(init.body as string) }); row = { ...row, version: '2', rules: [{ id: 'c'.repeat(32), ...f.desired }] };
      }
      return new Response(JSON.stringify({ success: true, result: row, errors: [] }));
    });
    const api = new DeploymentApi(f.root, f.intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, dispatch);
    const adapter = api.customWaf(f.context); const state = await inspectCustomWaf(adapter, f.desired);
    await provisionCustomWaf(adapter, f.desired, state.state, f.context);
    expect(writes).toHaveLength(1); expect(writes[0]!.url).toBe(`https://api.cloudflare.com/client/v4/zones/${f.intent.discovery.zoneId}/rulesets/${row.id}/rules`); expect(writes[0]!.method).toBe('POST'); expect(writes[0]!.body).not.toHaveProperty('rules'); expect(writes[0]!.body.expression).toBe(f.desired.expression);
    api.close();
  });
});
