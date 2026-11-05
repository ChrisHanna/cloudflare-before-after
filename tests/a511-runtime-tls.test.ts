import { expect, it } from 'vitest';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { receiptSender } from '../apps/storefront-container/src/app.js';
// @ts-expect-error Local non-TS fixture helper deliberately lives outside build inputs.
import { exec, makeTlsFixture } from './runtime/a511-fixtures.mjs';
it('real Node HTTPS sender verifies CA/hostname, strict status/ack, no-follow and malformed receipts', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'a511-tls-')); const servers: ReturnType<typeof createServer>[] = [];
  try {
    const tls = await makeTlsFixture(scratch);
    const require = createRequire(await realpath(resolve('node_modules/wrangler/package.json'))); const { build } = require('esbuild');
    const bundle = join(scratch, 'sender.mjs'); await build({ entryPoints: [resolve('apps/storefront-container/src/app.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const secret = 'a511-only-synthetic-ingest-secret'; let mode = 'valid'; let calls = 0;
    const start = async (material: any) => {
      const server = createServer(material, async (req, res) => {
        calls++; let text = ''; for await (const part of req) text += part;
        if (req.url !== '/ingest' || req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401); res.end(); return; }
        const body = JSON.parse(text);
        if (mode === 'timeout') { req.on('close', () => res.destroy()); return; }
        const status = mode.startsWith('status-') ? Number(mode.slice(7)) : 204;
        res.writeHead(status, { 'x-receipt-id': mode === 'wrong-ack' ? randomUUID() : body.id, ...(status >= 300 && status < 400 ? { location: 'https://localhost/never-follow' } : {}) }); res.end();
      });
      server.on('tlsClientError', () => {}); servers.push(server);
      await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); return (server.address() as any).port;
    };
    const port = await start(tls.valid); const wrongPort = await start(tls.wrong);
    const receipt = { schemaVersion: 1 as const, id: randomUUID(), runId: randomUUID(), requestId: randomUUID(), scenarioId: 'analytics' as const, targetRole: 'before' as const, producerId: 'synthetic-producer', sequence: 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' as const };
    const child = async (ca = tls.ca, values: any = {}) => {
      const { stdout, stderr } = await exec(process.execPath, [resolve('tests/runtime/a511-tls-child.mjs'), bundle, JSON.stringify({ port, secret, receipt, ...values })], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, timeout: 10000 });
      expect(`${stdout}${stderr}`).not.toMatch(/CANARY|PRIVATE|Bearer/); return JSON.parse(stdout).ok;
    };
    for (const stage of ['entry', 'completion']) expect(await child(tls.ca, { receipt: { ...receipt, stage } })).toBe(true);
    expect(await child(tls.untrusted)).toBe(false); expect(await child(tls.ca, { port: wrongPort })).toBe(false);
    expect(await child(tls.ca, { secret: 'wrong-synthetic-credential-at-least-24' })).toBe(false);
    for (const code of [200, 401, 301, 302, 303, 307, 308]) { mode = `status-${code}`; const before = calls; expect(await child()).toBe(false); expect(calls - before).toBe(1); }
    mode = 'wrong-ack'; expect(await child()).toBe(false);
    mode = 'valid'; const before = calls; expect(await child(tls.ca, { receipt: { ...receipt, stage: 'forged' } })).toBe(false); expect(calls).toBe(before);
    mode = 'timeout'; expect(await child()).toBe(false);
    for (const url of ['http://localhost/ingest', 'https://localhost:444/ingest', 'https://user:pass@localhost/ingest', 'https://localhost/other', 'https://localhost/ingest?q=x', 'https://localhost/ingest#x']) expect(() => receiptSender(url, secret)).toThrow();
  } finally { for (const server of servers) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } await rm(scratch, { recursive: true, force: true }); }
}, 60000);
