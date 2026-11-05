import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
// @ts-expect-error Local non-TS fixture helper deliberately lives outside build inputs.
import { exec, makeTlsFixture } from './runtime/a511-fixtures.mjs';
it('Docker namespace: current server accepts only loopback-published authenticated checkpoint', async context => {
  // No pull/build. This image supplies Node only; current source is bundled and mounted read-only.
  const image = 'cloudflare-workshop-container:local';
  try { await exec('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeout: 5000 }); }
  catch { context.skip('Local Node fixture image unavailable: external Container routing remains unproved'); return; }
  const scratch = await mkdtemp(join(tmpdir(), 'a511-docker-')); const name = `a511-runtime-${randomUUID()}`; let started = false;
  try {
    await chmod(scratch, 0o755); const tls = await makeTlsFixture(scratch); await chmod(tls.ca, 0o644);
    const require = createRequire(await realpath(resolve('node_modules/wrangler/package.json'))); const { build } = require('esbuild');
    await build({ entryPoints: [resolve('apps/storefront-container/src/server.ts')], outfile: join(scratch, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const secret = 'a511-synthetic-container-only-secret';
    const vars = { APP_ROLE: 'before', APP_SCENARIO: 'analytics', APP_RUN_ID: randomUUID(), APP_PRODUCER: 'synthetic-producer', APP_RELEASE: 'a'.repeat(64), APP_INTERNAL_SECRET: secret, RECEIPT_URL: 'https://localhost/ingest', RECEIPT_INGEST_SECRET: 'a511-synthetic-receipt-only-secret', NODE_EXTRA_CA_CERTS: '/etc/cloudflare/certs/cloudflare-containers-ca.crt', NODE_TLS_REJECT_UNAUTHORIZED: '1', PORT: '8080' };
    await exec('docker', ['run', '--pull=never', '-d', '--rm', '--name', name, '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m', '--cpus=1', '-p', '127.0.0.1::8080', '-v', `${scratch}:/runtime:ro`, '-v', `${tls.ca}:/etc/cloudflare/certs/cloudflare-containers-ca.crt:ro`, ...Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--entrypoint', 'node', image, '/runtime/server.mjs'], { timeout: 15000 }); started = true;
    const { stdout } = await exec('docker', ['port', name, '8080/tcp'], { timeout: 5000 }); const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1]; expect(port).toBeDefined();
    const local = await exec('docker', ['exec', name, 'node', '-e', `fetch('http://127.0.0.1:8080/internal/checkpoint',{headers:{authorization:'Bearer '+process.env.APP_INTERNAL_SECRET}}).then(r=>console.log(r.status))`], { timeout: 5000 });
    expect(local.stdout.trim(), 'Current server must first respond within the fixture namespace').toBe('200');
    const url = `http://127.0.0.1:${port}/internal/checkpoint`; let response: Response | undefined;
    for (let tries = 0; tries < 20; tries++) { try { response = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(500) }); break; } catch { await new Promise(r => setTimeout(r, 100)); } }
    expect(response?.status, 'Docker published port must reach current server across its namespace').toBe(200);
    const data = await response!.json(); expect(data).toMatchObject({ producerId: vars.APP_PRODUCER, runId: vars.APP_RUN_ID, lastAttemptedSequence: 0 });
    expect((await fetch(url, { signal: AbortSignal.timeout(1000) })).status).toBe(401);
  } finally { if (started) await exec('docker', ['stop', '-t', '1', name], { timeout: 10000 }); await rm(scratch, { recursive: true, force: true }); }
}, 45000);
