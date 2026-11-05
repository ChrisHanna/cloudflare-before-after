import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
it('pinned native workerd: SDK HTTPS/no-follow/acks, real storage, Turnstile and safe stages', async () => {
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [resolve('tests/runtime/a511-native-runner.mjs')], { cwd: resolve('.'), timeout: 90000, maxBuffer: 1024 * 1024 });
  expect(`${stdout}${stderr}`).not.toMatch(/CANARY_PROVIDER_PRIVATE|Bearer |private-input-token/);
  const result = JSON.parse(stdout.trim().split('\n').at(-1)!);
  expect(result).toMatchObject({ kind: 'a511-native-runtime', mode: 'repaired', cloudRequests: 0 });
  expect(result.checks).toBeGreaterThanOrEqual(68);
}, 100000);
