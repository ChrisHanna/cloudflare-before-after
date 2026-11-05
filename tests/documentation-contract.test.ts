import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { exampleIntent } from '../packages/demo-core/src/example-config.js';
import { assessCost } from '../packages/demo-core/src/deployment-plan.js';
import { runLabCli } from '../packages/demo-core/src/lab-cli.js';
import { parseDemoArgs } from '../packages/demo-core/src/demo-cli.js';
import { CATALOG } from '../scenarios/catalog.js';

describe('documentation command contracts', () => {
  it('generates schema-valid blocked examples, with no credential or provider access', async () => {
    const intent = exampleIntent(process.cwd());
    expect(intent.discovery.liveOptIn).toBe(false); expect(assessCost(intent.costs).blockers).toContain('Material monthly costs are unresolved');
    const { apiTokenMode, allowBroadApiToken, ...references } = intent.discovery.credentials;
    expect(apiTokenMode).toBeUndefined(); expect(allowBroadApiToken).toBeUndefined();
    expect(Object.values(references).every(ref => ref?.startsWith('env:LAB_'))).toBe(true);
    expect(() => exampleIntent('relative')).toThrow('Absolute');
    const result = await runLabCli(['plan', '--dry-run', '--json'], { projectRoot: process.cwd(), loadConfig: () => intent, provider: () => { throw new Error('No provider allowed'); }, createExecutor: async () => { throw new Error('No executor allowed'); } });
    expect(result.exitCode).toBe(0); expect(JSON.parse(result.output)).toMatchObject({ kind: 'planned', remoteWrites: 0, deploymentAuthorized: false });
  });
  it('keeps all eleven presenter stories and actual CLI contracts', () => {
    const text = readFileSync('docs/workshop.md', 'utf8');
    for (const manifest of CATALOG) {
      expect(text).toContain(`| ${manifest.id} |`);
      expect(manifest.notes.problem.length).toBeGreaterThan(0); expect(manifest.notes.question.length).toBeGreaterThan(0);
      expect(parseDemoArgs([manifest.id, '--dry-run', '--json']).scenarioId).toBe(manifest.id);
    }
    expect(parseDemoArgs(['doctor', '--scope', 'core-waf', '--json']).scope).toBe('core-waf');
    for (const flag of ['--requests', '--concurrency', '--max-runtime', '--sessions']) expect(() => parseDemoArgs(['waf-custom', flag, '999'])).toThrow();
    expect(text).toContain('actual absolute planPath'); expect(text).toContain('provider-enforced spending cap');
    expect(text).toContain('PLAN_JSON="$(pnpm --silent lab plan');
    expect(text).not.toContain('PLAN_JSON="$(pnpm lab plan');
    expect(text).toContain('No automatic rollback'); expect(text).toContain('SAVED EVIDENCE');
  });
  it('exposes real package entrypoints and a nonpassing live command', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.scripts['test:golden-path']).toBe('node scripts/golden-path.mjs');
    expect(pkg.scripts['verify:live']).toBe('node scripts/golden-path.mjs --live');
    const run = spawnSync(process.execPath, ['scripts/golden-path.mjs', '--live'], { encoding: 'utf8' });
    expect(run.status).toBe(1); expect(JSON.parse(run.stdout)).toMatchObject({ mode: 'live', status: 'unavailable', remoteWrites: 0, liveReadiness: false });
    const bad = spawnSync(process.execPath, ['scripts/golden-path.mjs', '--unsafe'], { encoding: 'utf8' }); expect(bad.status).toBe(2);
  });
  it('rejects malformed or repeated live activation flags without loading production modules', () => {
    for (const args of [['--live', '--opt-in', '--opt-in'], ['--live', '--resume-plan', 'relative'], ['--live', '--unsafe']]) {
      const run = spawnSync(process.execPath, ['scripts/golden-path.mjs', ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.KIROCREW_SCRATCH!, CI: 'true' } });
      expect(run.status).toBe(2); expect(run.stdout).toBe('');
    }
  });
  it('keeps CI offline, one-worker and separate from live qualification', () => {
    const ci = readFileSync('.github/workflows/offline.yml', 'utf8');
    expect(ci).toContain('pnpm install --offline --frozen-lockfile');
    expect(ci).toContain('--maxWorkers=1');
    for (const root of ['infra/terraform', 'infra/terraform/core-public', 'infra/terraform/routing']) expect(ci).toContain(root);
    for (const input of ['OFFLINE_TF_PROVIDER_MIRROR', 'OFFLINE_TERRAFORM_BIN']) {
      expect(ci).toContain(`vars.${input}`); expect(ci).toContain(`${input}="$${input}"`);
    }
    expect(ci).not.toMatch(/run:.*(?:verify:live|lab apply|wrangler deploy|curl|npx)/);
    expect(ci).not.toContain('secrets.');
    expect(ci).toContain('persist-credentials: false'); expect(ci).toContain('env -i');
    const runner = readFileSync('scripts/offline-gates.mjs', 'utf8');
    for (const command of ['--frozen-lockfile', 'tsconfig.build.json', 'apps/command-center', 'playwright/test/cli.js', 't38-at11-14', 'golden-path.mjs', 'wrangler/bin/wrangler.js']) expect(runner).toContain(command);
    for (const root of ['infra/terraform', 'infra/terraform/core-public', 'infra/terraform/routing']) expect(runner).toContain(`path: '${root}'`);
    for (const flag of ['-backend=false', '-input=false', '-get=false', '-upgrade=false', '-lockfile=readonly']) expect(runner).toContain(`'${flag}'`);
    expect(runner).toContain('filesystem_mirror'); expect(runner).not.toMatch(/direct\s*\{|network_mirror\s*\{/);
    for (const guard of ['provider-package-lock-hash-mismatch', 'terraform-version-pin-mismatch', 'readonly-lock-changed']) expect(runner).toContain(guard);
    expect(runner).toContain('shell: false'); expect(runner).toContain("killSignal: 'SIGKILL'");
    expect(runner).toContain('maxBuffer: MAX_OUTPUT'); expect(runner).toContain('finally { if (work) rmSync');
    const docs = readFileSync('docs/workshop.md', 'utf8');
    expect(docs).toContain('all three trusted Terraform roots'); expect(docs).toContain('cannot prove frozen installation');
    expect(docs).not.toContain('It neither initializes nor');
    expect(runner).toContain("COREPACK_ENABLE_NETWORK: '0'");
    expect(runner).toContain("WRANGLER_SEND_METRICS: 'false'");
    expect(runner).not.toContain('...process.env');
    expect(runner).toContain("status: missing ? 'unexecuted'");
    const browser = readFileSync('playwright.config.ts', 'utf8');
    expect(browser).toContain('127.0.0.1'); expect(browser).not.toContain("command: 'pnpm");
  });
});
