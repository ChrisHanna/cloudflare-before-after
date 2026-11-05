import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { runLabCli } from '../packages/demo-core/src/lab-cli.js';
import type { SetupExecutor } from '../packages/demo-core/src/deployment-apply.js';
import { deploymentIntent, FIXTURE_CREDENTIALS, minimalSourceTree } from './fixtures/deployment.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'deploy-cli-')); roots.push(root); minimalSourceTree(root);
  const now = Date.now(); const intent = deploymentIntent(root, now); const writes: string[] = [];
  const close = vi.fn(); const prepare = vi.fn(async () => []);
  const provider = vi.fn(() => ({ provider: { mode: 'fixture' as const, inspect: vi.fn(async () => ({ state: 'available' as const, source: 'fixture', reasons: [] })) }, close }));
  const createExecutor = vi.fn(async (): Promise<SetupExecutor> => ({ mode: 'fixture', execute: async (step, ctx) => { await ctx.perform('fixture-write', step.resources[0]!, async () => { writes.push(step.id); }); }, close: async () => {} }));
  const confirm = vi.fn(async (prompt: string) => ({ confirmation: `APPROVE ${/APPROVE ([a-f0-9]{64})/.exec(prompt)![1]}`, interactiveTTY: true }));
  const deps = { projectRoot: root, loadConfig: () => intent, provider, prepare, createExecutor, confirm, credentials: () => FIXTURE_CREDENTIALS, now: () => now };
  const command = (...args: string[]) => runLabCli([...args, '--json'], deps);
  return { root, intent, writes, deps, command, prepare, provider, createExecutor, confirm };
}
describe('deployment-cli', () => {
  it('implements the full plan -> exact approval -> one-use apply command flow in fixture mode', async () => {
    const f = fixture(); const planned = await f.command('plan'); expect(planned.exitCode).toBe(0);
    const body = JSON.parse(planned.output); expect(body.plan.mode).toBe('fixture'); expect(body.approvalState).toBe('not-approved'); expect(body.planPath.startsWith(f.root)).toBe(true);
    expect(f.writes).toEqual([]); expect(f.confirm).not.toHaveBeenCalled();
    const noApproval = await f.command('apply', '--plan', body.planPath); expect(noApproval.exitCode).toBe(2); expect(f.createExecutor).not.toHaveBeenCalled();
    const approved = await f.command('approve', '--plan', body.planPath); expect(approved.exitCode).toBe(0); expect(JSON.parse(approved.output).remoteWrites).toBe(0);
    const result = await f.command('apply', '--plan', body.planPath); expect(result.exitCode).toBe(0); expect(JSON.parse(result.output)).toMatchObject({ record: { status: 'succeeded' }, interviewVerified: false, workshopVerified: false });
    expect(f.writes).toHaveLength(body.plan.steps.length);
    const again = await f.command('apply', '--plan', body.planPath); expect(again.exitCode).toBe(2); expect(f.createExecutor).toHaveBeenCalledOnce();
  });
  it('never prepares or constructs writers for dry runs, budget failures or refused interactive approval', async () => {
    const f = fixture(); const dry = await f.command('plan', '--dry-run'); expect(JSON.parse(dry.output)).toMatchObject({ kind: 'planned', remoteWrites: 0 }); expect(f.provider).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled();
    f.intent.costs.lines[0]!.thisMonthCents = 10000;
    const overBudget = await f.command('plan'); expect(overBudget.exitCode).toBe(1); expect(JSON.parse(overBudget.output).plan.status).toBe('blocked'); expect(f.prepare).not.toHaveBeenCalled();
    const blockedApproval = await f.command('approve', '--plan', JSON.parse(overBudget.output).planPath); expect(blockedApproval.exitCode).toBe(2); expect(f.writes).toEqual([]);
    const g = fixture(); const planned = JSON.parse((await g.command('plan')).output);
    g.deps.confirm = vi.fn(async () => ({ confirmation: `APPROVE ${planned.digest}`, interactiveTTY: false }));
    const refused = await g.command('approve', '--plan', planned.planPath); expect(refused.exitCode).toBe(2); expect(g.writes).toEqual([]);
  });
  it('rejects invalid command flags and desired configuration drift after approval', async () => {
    const f = fixture(); const body = JSON.parse((await f.command('plan')).output); await f.command('approve', '--plan', body.planPath);
    f.intent.discovery.environments[1].origin = 'https://changed.example.test';
    const changed = await f.command('apply', '--plan', body.planPath); expect(changed.exitCode).toBe(2); expect(f.createExecutor).not.toHaveBeenCalled();
    for (const args of [['plan', '--plan', body.planPath], ['approve', '--dry-run'], ['plan', '--force'], ['apply', '--plan', '/outside/unowned.json']]) {
      expect((await f.command(...args)).exitCode).toBe(2);
    }
    expect((await f.command('plan', '--help')).output).toContain('Estimates are not provider-enforced');
  });
});
