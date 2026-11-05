import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Digest } from '../../contracts/src/schemas.js';
import { sourceDigest, sourceEntries } from './deployment-plan.js';
import { validateEvidenceDirectory } from './config.js';
export function frozenSourcePath(root: string, evidenceDirectory: string, digest: string): string {
  Digest.parse(digest); const path = join(evidenceDirectory, 'deployment', 'source', digest);
  return validateEvidenceDirectory(path, root);
}
export function verifyFrozenSource(root: string, evidenceDirectory: string, digest: string): string {
  const path = frozenSourcePath(root, evidenceDirectory, digest);
  if (sourceDigest(path) !== digest) throw new Error('Frozen source integrity mismatch');
  return path;
}
// Windows-mounted drives transiently refuse renames while another process holds a freshly written tree.
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
}
export function freezeSource(root: string, evidenceDirectory: string): { path: string; digest: string } {
  const entries = sourceEntries(root); const digest = sourceDigest(root);
  const destination = frozenSourcePath(root, evidenceDirectory, digest);
  if (existsSync(destination)) return { path: verifyFrozenSource(root, evidenceDirectory, digest), digest };
  const stage = join(dirname(destination), `.staging-${randomUUID()}`);
  validateEvidenceDirectory(stage, root); mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    for (const [name, expected] of entries) {
      const source = join(root, name); const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || createHash('sha256').update(readFileSync(source)).digest('hex') !== expected) throw new Error('Source changed while freezing');
      const target = join(stage, name); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); copyFileSync(source, target, constants.COPYFILE_EXCL);
    }
    if (sourceDigest(stage) !== digest || sourceDigest(root) !== digest) throw new Error('Source changed while freezing');
    renameWithRetry(stage, destination);
    // Dependencies resolve from the verified frozen-lockfile workspace. Docker ignores these links.
    // Linked after the rename: Windows-mounted drives refuse to rename a tree whose links are being scanned.
    const directories = new Set(['', ...entries.filter(([name]) => name.endsWith('/package.json')).map(([name]) => dirname(name))]);
    for (const name of directories) if (existsSync(join(root, name, 'node_modules'))) symlinkSync(join(root, name, 'node_modules'), join(destination, name, 'node_modules'), 'dir');
    return { path: destination, digest };
  } finally { if (existsSync(stage)) rmSync(stage, { recursive: true }); }
}
