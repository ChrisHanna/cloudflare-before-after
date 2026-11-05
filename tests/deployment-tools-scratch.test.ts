import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalDeploymentTools, resolveToolScratch } from '../packages/demo-core/src/deployment-tools.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';

const roots: string[] = [];
const owned = process.env.KIROCREW_SCRATCH ?? tmpdir();
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(owned, 'tool-scratch-')); roots.push(root); return root; }
function printTmpdir(root: string) {
  const intent = deploymentIntent(root); const fake = join(root, 'terraform-tmpdir-fixture');
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write(process.env.TMPDIR ?? '');\n`); chmodSync(fake, 0o700);
  const tool = new LocalDeploymentTools(root, intent.discovery.evidenceDirectory, FIXTURE_CREDENTIALS.deployer, fake);
  return tool.terraform(['version'], join(intent.discovery.evidenceDirectory, 'deployment/tool-home'));
}
describe('tool scratch directory', () => {
  it('keeps an explicitly configured Linux directory unchanged', () => {
    expect(resolveToolScratch({ KIROCREW_SCRATCH: '/tmp/cf-lab-explicit' })).toBe('/tmp/cf-lab-explicit');
  });
  it('creates a private directory under the system temp location when none is configured', () => {
    const base = fixture(); const scratch = resolveToolScratch({}, () => base);
    expect(scratch.startsWith(join(base, 'cf-lab-'))).toBe(true); expect(existsSync(scratch)).toBe(true);
  });
  it.each([
    ['a Windows-mounted configured path', () => resolveToolScratch({ KIROCREW_SCRATCH: '/mnt/c/users/lab/tmp' }), 'Linux storage'],
    ['a Windows-mounted system temp location', () => resolveToolScratch({}, () => '/mnt/d/Temp'), 'Linux storage'],
    ['a relative path', () => resolveToolScratch({ KIROCREW_SCRATCH: 'relative/tmp' }), 'absolute'],
  ])('refuses %s before creating anything', (_name, run, message) => {
    expect(run).toThrow(message);
  });
  it('gives every tool process the owned scratch instead of the tool home', async () => {
    const root = fixture(); const scratch = fixture(); vi.stubEnv('KIROCREW_SCRATCH', scratch);
    expect(await printTmpdir(root)).toBe(scratch);
  });
  it('falls back to a Linux temp directory, never the checkout, when no scratch is configured', async () => {
    const root = fixture(); vi.stubEnv('KIROCREW_SCRATCH', undefined);
    const used = await printTmpdir(root); roots.push(used);
    expect(used.startsWith(join(tmpdir(), 'cf-lab-'))).toBe(true); expect(used).not.toContain('tool-home'); expect(used.startsWith(root)).toBe(false);
  });
});
