import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { GuardedClient } from '../packages/demo-core/src/transport.js';
import { observePolicyOwnership, policyOwnershipMinimum } from '../packages/demo-core/src/ownership.js';
import { demoLabFixture } from './fixtures/demo-lab.js';

const roots: string[] = [];
const ledgers: BudgetLedger[] = [];
afterEach(() => {
  ledgers.splice(0).forEach(ledger => ledger.stop());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
function fixture(fault?: 'hostname' | 'ref' | 'description' | 'action' | 'duplicate' | 'bounded' | 'denied') {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'policy-ownership-')); roots.push(root);
  const f = demoLabFixture(root); f.config.liveOptIn = true;
  const ledger = new BudgetLedger(); ledgers.push(ledger);
  const initial = new Set(f.config.inventory.filter(item => item.type !== 'policy').map(item => `${item.type}:${item.role}:${item.id}`));
  const client = new GuardedClient(f.config, ledger, { purpose: 'discovery', observedOwnedResources: initial, dispatch: async (url, init) => {
    const response = await f.dispatch(url, init);
    if (!url.includes('/http_request_firewall_custom/entrypoint') || !fault) return response;
    if (fault === 'denied') return Response.json({ success: false, result: null, errors: [{ code: 10000, message: 'Fixture denied' }] }, { status: 403 });
    const body = await response.json() as { result: { rules: Record<string, unknown>[] } };
    const rule = body.result.rules[0]!;
    if (fault === 'hostname') rule.expression = '(http.host eq "before.example.test")';
    if (fault === 'ref') rule.ref = 'foreign-owner';
    if (fault === 'description') rule.description = 'Another lab';
    if (fault === 'action') rule.action = 'log';
    if (fault === 'duplicate') body.result.rules.push({ ...rule });
    if (fault === 'bounded') body.result.rules = Array.from({ length: 100 }, (_, index) => ({ ...rule, id: index.toString(16).padStart(32, '0') }));
    return Response.json(body);
  } });
  return { ...f, ledger, initial, client };
}
describe('default metered policy ownership', () => {
  it('joins exact independently read WAF ownership without mutating caller inventory', async () => {
    const f = fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    const result = await observePolicyOwnership(f.config, f.credentials.reader, f.client, f.initial, f.ledger.signal);
    expect(result.has(`policy:after:${'c'.repeat(32)}`)).toBe(true);
    expect(f.initial.has(`policy:after:${'c'.repeat(32)}`)).toBe(false);
    for (const id of f.initial) expect(result.has(id)).toBe(true);
    expect(policyOwnershipMinimum(f.config)).toBe(1);
    expect(f.calls).toHaveLength(1); expect(f.ledger.snapshot.requestsUsed).toBe(1);
    expect(f.calls[0]!.method).toBe('GET'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['hostname', 'ref', 'description', 'action'] as const)('does not trust an inventory ID with wrong %s', async fault => {
    const f = fixture(fault);
    const result = await observePolicyOwnership(f.config, f.credentials.reader, f.client, f.initial, f.ledger.signal);
    expect(result.has(`policy:after:${'c'.repeat(32)}`)).toBe(false);
    expect(f.ledger.snapshot.requestsUsed).toBe(1);
  });
  it.each(['duplicate', 'bounded', 'denied'] as const)('rejects %s readback instead of blessing declared policy IDs', async fault => {
    const f = fixture(fault);
    await expect(observePolicyOwnership(f.config, f.credentials.reader, f.client, f.initial, f.ledger.signal)).rejects.toThrow();
    expect(f.initial.has(`policy:after:${'c'.repeat(32)}`)).toBe(false);
    expect(f.ledger.snapshot.requestsUsed).toBe(1);
  });
  it('budgets and independently reads both WAF and rate-limit policy scopes', async () => {
    const f = fixture(); f.config.rateLimitRuleId = 'f'.repeat(32);
    f.config.inventory.push({ type: 'policy', role: 'after', id: f.config.rateLimitRuleId, labId: f.config.labId });
    expect(policyOwnershipMinimum(f.config)).toBe(2);
    const result = await observePolicyOwnership(f.config, f.credentials.reader, f.client, f.initial, f.ledger.signal);
    expect(result.has(`policy:after:${'c'.repeat(32)}`)).toBe(true);
    expect(result.has(`policy:after:${'f'.repeat(32)}`)).toBe(true);
    expect(f.calls).toHaveLength(2); expect(f.ledger.snapshot.requestsUsed).toBe(2);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('does not create policy reads when no policy is declared', async () => {
    const f = fixture(); f.config.inventory = f.config.inventory.filter(item => item.type !== 'policy');
    expect(policyOwnershipMinimum(f.config)).toBe(0);
    const result = await observePolicyOwnership(f.config, f.credentials.reader, f.client, f.initial, f.ledger.signal);
    expect([...result]).toEqual([...f.initial]); expect(f.calls).toHaveLength(0);
  });
});
