import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { labConfig } from './fixtures/lab.js';
import { assertLiveReady, validateEvidenceDirectory, validateLabConfig } from '../packages/demo-core/src/config.js';
const created: string[] = [];
afterAll(() => { for (const p of created) rmSync(p, { recursive: true, force: true }); });
describe('lab-config', () => {
  it('accepts explicit owned isolated fixture configuration', () => {
    const config = labConfig();
    expect(validateLabConfig(config, process.cwd())).toEqual(config);
  });
  it('rejects spoofed environments, shared bindings, mismatched versions and raw credentials', () => {
    for (const mutate of [
      (c: any) => { c.purpose = 'production'; },
      (c: any) => { c.ownedLab = false; },
      (c: any) => { c.environments[1].role = 'before'; },
      (c: any) => { c.environments[1].d1Id = c.environments[0].d1Id; },
      (c: any) => { c.environments[1].releaseDigest = 'b'.repeat(64); },
      (c: any) => { c.credentials.reader = 'raw-secret'; },
      (c: any) => { c.inventory[0].labId = 'other'; },
      (c: any) => { c.inventory = []; },
      (c: any) => { c.credentials.password = 'secret'; },
    ]) { const c = labConfig(); mutate(c); expect(() => validateLabConfig(c, process.cwd())).toThrow(); }
  });
  it('requires explicit opt-in and observed ownership', () => {
    const c = labConfig();
    const keys = new Set(c.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
    expect(() => assertLiveReady(c, keys)).toThrow('opt-in');
    c.liveOptIn = true;
    expect(() => assertLiveReady(c, new Set())).toThrow('ownership');
    expect(() => assertLiveReady(c, keys)).not.toThrow();
  });
  it('rejects paths outside ignored evidence root and symlink escapes', () => {
    expect(() => validateEvidenceDirectory('/tmp/evidence', process.cwd())).toThrow();
    expect(() => validateEvidenceDirectory('../.evidence', process.cwd())).toThrow();
    const scratch = process.env.KIROCREW_SCRATCH;
    if (!scratch) throw new Error('KIROCREW_SCRATCH required for filesystem tests');
    const root = mkdtempSync(join(scratch, 'lab-config-')); created.push(root);
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(root, '.evidence'));
    expect(() => validateEvidenceDirectory(join(root, '.evidence', 'run'), root)).toThrow('Symlink');
  });
});
