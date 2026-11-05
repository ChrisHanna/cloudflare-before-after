import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDemoArgs, runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { RunJournal } from '../packages/demo-core/src/reports.js';
import { doctorMinimumRequests } from '../packages/demo-core/src/doctor.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(fault?: Parameters<typeof demoLabFixture>[1]) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'demo-cli-')); roots.push(root); const lab = demoLabFixture(root, fault);
  const credentials = vi.fn(() => lab.credentials); const loadConfig = vi.fn(() => lab.config);
  const deps = { projectRoot: root, mode: 'fixture' as const, dispatch: lab.dispatch, credentials, loadConfig };
  const run = (...args: string[]) => runDemoCli([...args, '--json'], deps);
  return { root, ...lab, credentialsFn: credentials, loadConfig, deps, run };
}
describe('demo-cli', () => {
  it('lists all catalog entries and help without touching configuration or credential factories', async () => {
    const f = fixture(); const catalog = await f.run('list'); expect(catalog.exitCode).toBe(0);
    expect(JSON.parse(catalog.output).entries).toHaveLength(11);
    expect(JSON.parse(catalog.output).entries.filter((e: any) => e.implemented)).toHaveLength(11);
    expect(f.loadConfig).not.toHaveBeenCalled(); expect(f.credentialsFn).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
    const help = await f.run('--help'); expect(JSON.parse(help.output).text).toContain('Exit130');
  });
  it('uses the same bounded adapter and journals/reports actual fixture observations', async () => {
    const f = fixture(); const result = await f.run('waf-custom');
    expect(result.exitCode).toBe(0); const json = JSON.parse(result.output);
    expect(json).toMatchObject({ kind: 'result', journalComplete: true, report: { mode: 'fixture', result: { outcome: 'verified', requestsUsed: 22 } } });
    expect(f.calls).toHaveLength(22); expect(f.targets()).toBe(4);
    const runId = json.report.result.runId; const journal = new RunJournal(f.root, f.config.evidenceDirectory, runId);
    const events = journal.read(0); expect(events.some(e => e.event.type === 'evidence')).toBe(true); expect(events.at(-1)?.event.type).toBe('outcome');
    expect(readFileSync(join(json.reportDirectory, 'report.html'), 'utf8')).toContain('Request evidence');
    for (const secret of Object.values(f.credentials)) expect(result.output).not.toContain(secret);
    expect(result.output).not.toContain(f.canary);
  });
  it('keeps scoped/default doctor exits separate and never claims live mitigation', async () => {
    const f = fixture(); const scoped = await f.run('doctor', '--scope', 'core-waf');
    expect(scoped.exitCode).toBe(0); const json = JSON.parse(scoped.output);
    expect(json.report).toMatchObject({ mode: 'fixture', scope: 'core-waf', preflightReady: true, claims: { mitigationVerified: false, deploymentVerified: false, interviewVerified: false, workshopVerified: false } });
    expect(json.report.catalog.filter((c: any) => c.state === 'unavailable')).toHaveLength(10);
    const full = await f.run('doctor'); expect(full.exitCode).toBe(1); expect(JSON.parse(full.output).report.scope).toBe('catalog');
  });
  it('dry-run plans wired scenarios and aggregates without constructing execution dependencies', async () => {
    const f = fixture(); const planned = await f.run('waf-custom', '--dry-run'); expect(planned.exitCode).toBe(0); expect(JSON.parse(planned.output)).toMatchObject({ kind: 'planned', networkCalls: 0, verified: false });
    expect(f.credentialsFn).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
    for (const name of ['interview', 'all', 'rehearsal']) {
      const plan = await f.run(name, '--dry-run'); expect(plan.exitCode).toBe(0); expect(JSON.parse(plan.output)).toMatchObject({ kind: 'planned', executable: true, networkCalls: 0, verified: false });
    }
    expect((await f.run('waiting-room', '--requests', '16', '--dry-run')).exitCode).toBe(2);
    expect((await f.run('waiting-room', '--dry-run')).exitCode).toBe(0);
    expect((await f.run('waiting-room', '--requests', '40', '--dry-run')).exitCode).toBe(0);
    expect(f.calls).toEqual([]); expect(f.credentialsFn).not.toHaveBeenCalled();
  });
  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('uses the runtime Doctor minimum for dry-run public=%s rate=%s without raising caps or resolving credentials', async (publicMode, rate) => {
    const f = fixture();
    if (publicMode) f.config.imageVariant = { source: 'existing-public-readonly', id: 'public', options: { fit: 'contain', width: 64, height: 64, metadata: 'none' }, neverRequireSignedURLs: true };
    if (rate) f.config.rateLimitRuleId = 'c'.repeat(32);
    const minimum = 24 + (publicMode ? 2 : 0) + (rate ? 1 : 0);
    expect(doctorMinimumRequests(f.config)).toBe(minimum);
    // The total cap must also fit the existing one-request cleanup reserve.
    expect((await f.run('doctor', '--requests', String(minimum), '--dry-run')).exitCode).toBe(2);
    expect((await f.run('doctor', '--requests', String(minimum))).exitCode).toBe(2);
    const planned = await f.run('doctor', '--requests', String(minimum + 1), '--dry-run');
    expect(planned.exitCode).toBe(0); expect(JSON.parse(planned.output)).toMatchObject({ kind: 'planned', verified: false, networkCalls: 0, limits: { requests: minimum + 1 } });
    expect(f.credentialsFn).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it('rejects browser plans before credential resolution or target traffic', async () => {
    const f = fixture();
    f.config.demonstrations = { waitingRoom: { id: 'a'.repeat(32), settings: { hostname: new URL(f.config.environments[1].origin).hostname, path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false }, expectedTransitionMs: 110000, perNavigationRequests: 1, refreshes: 1, queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]', queueContractQualified: true } };
    expect((await f.run('waiting-room', '--dry-run')).exitCode).toBe(2);
    expect((await f.run('waiting-room', '--max-runtime', '120', '--sessions', '2', '--dry-run')).exitCode).toBe(2);
    expect((await f.run('waiting-room', '--max-runtime', '120', '--sessions', '3', '--dry-run')).exitCode).toBe(0);
    f.config.demonstrations.waitingRoom!.settings.hostname = 'wrong.example.test';
    expect((await f.run('waiting-room', '--max-runtime', '120', '--dry-run')).exitCode).toBe(2);
    expect(f.calls).toEqual([]); expect(f.credentialsFn).not.toHaveBeenCalled();
  });
  it('rejects unsafe limits/inapplicable flags and unverified ownership before target traffic', async () => {
    for (const args of [['waf-custom', '--requests', '15'], ['waf-custom', '--sessions', '8'], ['waf-custom', '--scope', 'core-waf'], ['waf-custom', '--requests', '101'], ['doctor', '--sessions', '8'], ['waf-custom', '--max-runtime', '121'], ['list', '--dry-run']]) {
      const f = fixture(); expect((await f.run(...args)).exitCode, args.join(' ')).toBe(2); expect(f.calls).toEqual([]);
    }
    const foreign = fixture('binding'); const refused = await foreign.run('waf-custom'); expect(refused.exitCode).toBe(1); expect(foreign.targets()).toBe(0);
  });
  it('reports runner failure, configuration failure and interruption with distinct exits', async () => {
    const f = fixture(); const broken = await runDemoCli(['waf-custom', '--json'], { ...f.deps, runWafCustom: async () => { throw new Error('private-error-secret'); } });
    expect(broken.exitCode).toBe(3); expect(broken.output).not.toContain('private-error-secret');
    const bad = await runDemoCli(['waf-custom', '--json'], { ...f.deps, loadConfig: () => ({ ...f.config, liveOptIn: false }) }); expect(bad.exitCode).toBe(2); expect(f.calls).toEqual([]);
    const controller = new AbortController(); controller.abort(); const stopped = await runDemoCli(['waf-custom', '--json'], { ...f.deps, signal: controller.signal }); expect(stopped.exitCode).toBe(130);
  });
  it('parses units, aggregate caps and browser-session limits explicitly', () => {
    expect(parseDemoArgs(['waf-custom', '--requests', '30', '--concurrency', '4', '--max-runtime', '90']).limits).toMatchObject({ requests: 30, concurrency: 4, maxRuntimeMs: 90000 });
    expect(parseDemoArgs(['interview']).limits).toMatchObject({ requests: 100, maxRuntimeMs: 300000 });
    expect(parseDemoArgs(['waiting-room', '--sessions', '8']).limits.sessions).toBe(8);
    expect(() => parseDemoArgs(['waf-custom', '--requests', '15.5'])).toThrow();
    expect(() => parseDemoArgs(['waf-custom', '--unknown'])).toThrow();
  });
});
