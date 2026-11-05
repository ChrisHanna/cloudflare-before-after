import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const scratch = process.env.KIROCREW_SCRATCH;
if (!scratch) throw new Error('KIROCREW_SCRATCH required');
const home = mkdtempSync(join(scratch, 'lab-cli-smoke-'));
const bundle = join(home, 'compiled');
const env = { PATH: process.env['PATH'] ?? '', HOME: home, TMPDIR: home, CI: 'true', NO_COLOR: '1' };
const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', env, timeout: 5000 }).status === 0;
beforeAll(() => {
  const build = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', bundle], { encoding: 'utf8', env, timeout: 60000 });
  expect(build.status, build.stdout + build.stderr).toBe(0);
  writeFileSync(join(bundle, 'package.json'), '{"type":"module"}');
  symlinkSync(resolve('node_modules'), join(bundle, 'node_modules'), 'dir');
}, 65000);
afterAll(() => rmSync(home, { recursive: true, force: true }));
function command(args: string[], surface: 'lab' | 'demo' = 'lab') {
  return spawnSync(process.execPath, [join(bundle, 'packages/demo-core/src', `${surface}-cli.js`), ...args], { cwd: process.cwd(), timeout: 60000, encoding: 'utf8', env });
}
describe('deployment-cli executable smoke (no credentials or network)', () => {
  it('runs the actual demo catalog/help and produces clean JSON without lab configuration', () => {
    const result = command(['list', '--json'], 'demo');
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).entries).toHaveLength(11);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
    const invalid = command(['unknown-command', '--json'], 'demo'); expect(invalid.status).toBe(2); expect(JSON.parse(invalid.stdout).error).toContain('Invalid');
  }, 65000);
  it('runs the actual compiled command and preserves single-document JSON', () => {
    const result = command(['capabilities', '--profile', 'not-a-profile', '--json']);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ remoteWrites: 0 });
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  }, 65000);
  it('exposes actual planning, approval and apply help without configuring an account', () => {
    const result = command(['--help']);
    expect(result.status).toBe(0); expect(result.stdout.startsWith('Usage: pnpm lab')).toBe(true);
    expect(result.stdout).toContain('plan|approve|apply'); expect(result.stdout).toContain('Estimates are not provider-enforced');
  }, 65000);
  it.skipIf(!pnpm)('preserves the package-script contract through installed pnpm', () => {
    const result = spawnSync('pnpm', ['--silent', 'demo', 'list', '--json'], { cwd: process.cwd(), timeout: 60000, encoding: 'utf8', env });
    expect(result.status).toBe(0); expect(JSON.parse(result.stdout).entries).toHaveLength(11);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  }, 65000);
});
