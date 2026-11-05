import { describe, expect, it } from 'vitest';
import { ManifestSchema, ScenarioId } from '../packages/contracts/src/schemas.js';
import { CATALOG, IMPLEMENTED_SCENARIOS, scenario } from '../scenarios/catalog.js';
import { limitsFor, validatePlan } from '../packages/demo-core/src/budget.js';
describe('scenario-manifests', () => {
  it('declares all eleven concrete commands and proof/cleanup/presenter contracts', () => {
    expect(new Set(CATALOG.map(m => m.id))).toEqual(new Set(ScenarioId.options));
    expect(CATALOG).toHaveLength(11);
    for (const entry of CATALOG) {
      expect(ManifestSchema.parse(entry)).toEqual(entry); expect(entry.command).toBe(`pnpm demo ${entry.id}`);
      expect(entry.configuration.length).toBeGreaterThan(0); expect(entry.proofPredicates.length).toBeGreaterThan(0);
      expect(entry.cleanup.length).toBeGreaterThan(0); expect(entry.setupState.length).toBeGreaterThan(0);
      for (const text of Object.values(entry.notes)) expect(text.length).toBeGreaterThan(10);
      expect(() => validatePlan(limitsFor('scenario', entry.budget), entry.minimumRequests, entry.budget.sessions)).not.toThrow();
      expect(JSON.stringify(entry)).not.toMatch(/TODO|placeholder|coming soon/i);
    }
  });
  it('retains explicit product differences, real queue proof and an evidence-only DDoS manifest', () => {
    expect(scenario('ddos-evidence').inputs).toEqual([]);
    expect(scenario('ddos-evidence').configuration.join(' ')).toContain('No attack');
    expect(scenario('turnstile').evidenceSources).toContain('verification');
    expect(scenario('api-shield').product).toContain('mTLS');
    expect(scenario('waiting-room').budget.sessions).toBe(8);
    expect(scenario('waiting-room').proofPredicates.join(' ')).toContain('Same-context');
    expect(new Set(IMPLEMENTED_SCENARIOS)).toEqual(new Set(ScenarioId.options));
    expect(scenario('turnstile').minimumRequests).toBe(15);
    expect(scenario('turnstile').budget.cleanupRequests).toBe(2);
  });
  it('provides isolated copies and prevents global manifest mutation', () => {
    const copy = scenario('waf-custom'); copy.budget.requests = 1;
    expect(scenario('waf-custom').budget.requests).toBe(30);
    expect(() => { CATALOG[0]!.budget.requests = 1; }).toThrow();
    expect(() => scenario('arbitrary-target')).toThrow();
  });
});
