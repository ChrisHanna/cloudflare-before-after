import { describe, expect, it, vi } from 'vitest';
import { executionDependencies, GuardedClient } from '../packages/demo-core/src/transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { TestClock } from './fixtures/clock.js';
import { labConfig } from './fixtures/lab.js';
describe('dry-run-isolation', () => {
  it('constructs no network, browser or deployment dependency in dry-run', () => {
    const fail = vi.fn(() => { throw new Error('Forbidden factory'); });
    const graph = executionDependencies('dry-run', { http: fail, browser: fail, deployment: fail });
    expect(graph).toEqual({ kind: 'planned' }); expect(fail).not.toHaveBeenCalled();
  });
  it('never includes a deployment executor in live demo execution', () => {
    const fail = vi.fn(() => { throw new Error('Forbidden deployment'); });
    const graph = executionDependencies('live', { http: () => 'http', browser: () => 'browser', deployment: fail });
    expect(graph).not.toHaveProperty('deployment'); expect(fail).not.toHaveBeenCalled();
  });
  it('refuses construction of a live client without opt-in and ownership', () => {
    const l = new BudgetLedger({ clock: new TestClock() });
    expect(() => new GuardedClient(labConfig(), l, { observedOwnedResources: new Set() })).toThrow('opt-in'); l.stop();
  });
});
