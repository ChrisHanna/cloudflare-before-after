import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
for (const role of ['before', 'after']) it(`${role}: bounded settled retention never removes pending evidence or resets budget`, async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('tests/runtime/container-restart-sequence-p2-runner.mjs'), '--bounds-only', ...(role === 'after' ? ['--after'] : [])], { cwd: resolve('.'), timeout: 120000, maxBuffer: 1024 * 1024 });
  expect(`${stdout}${stderr}`).not.toMatch(/PRIVATE_CANARY|Bearer /);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ kind: 'restart-p2-bounds', role, productionHandler: true, cap: 100, highWater: 200, knownIds: 100, retainedUnresolved: 2, coverage: 'unknown', cloudRequests: 0 });
  expect(result.checks).toBeGreaterThanOrEqual(13);
}, 125000);
