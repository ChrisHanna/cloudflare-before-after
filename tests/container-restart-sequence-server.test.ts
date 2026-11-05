import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
it('actual production HTTP handler propagates cancelled socket into Node app receipt gating', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('tests/runtime/container-restart-sequence-runner.mjs'), '--production-server'], { cwd: resolve('.'), timeout: 90000, maxBuffer: 1024 * 1024 });
  expect(`${stdout}${stderr}`).not.toMatch(/PRIVATE_CANARY|Bearer /);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ kind: 'restart-sequence-repaired', role: 'before', productionHandler: true, uniqueConflict: false, cloudRequests: 0 });
  expect(result.checks).toBeGreaterThanOrEqual(23);
}, 95000);
