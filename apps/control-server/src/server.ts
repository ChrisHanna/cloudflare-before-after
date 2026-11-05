import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createControlApp, type ControlAppOptions } from './app.js';
import { loadRuntimeConfig } from '../../../packages/demo-core/src/runtime-config.js';
export async function startControlServer(options: Omit<ControlAppOptions, 'origin'> & { port?: number }) {
  const port = options.port ?? 8787; if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid loopback control port');
  let control: ReturnType<typeof createControlApp> | undefined;
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const disconnect = new AbortController(); const abort = () => disconnect.abort();
    request.once('aborted', abort); response.once('close', abort);
    try {
      if (!control || !request.url?.startsWith('/') || request.headers.host !== new URL(control.origin).host) { response.writeHead(403); response.end('Unexpected local control host'); return; }
      if (request.method === 'GET' && (request.url === '/' || /^\/assets\/[A-Za-z0-9._-]+\.(js|css)$/.test(request.url))) {
        const root = resolve(options.projectRoot, 'apps/command-center/dist'); const file = request.url === '/' ? join(root, 'index.html') : join(root, request.url.slice(1));
        if (!existsSync(file)) { response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); response.end('Build the Command Center with pnpm build.'); return; }
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024 || !realpathSync(file).startsWith(`${realpathSync(root)}/`)) throw new Error('Invalid static bundle');
        const origin = request.headers.origin; if (origin && origin !== control.origin) { response.writeHead(403); response.end('Cross-origin page request rejected'); return; }
        response.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': control.presentationPolicy() });
        response.end(readFileSync(file)); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      request.setTimeout(10000, () => request.destroy());
      for await (const chunk of request) { size += chunk.length; if (size > 8192) { response.writeHead(413); response.end('Control request exceeds size cap'); return; } chunks.push(chunk); }
      const headers = new Headers(); for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
      const result = await control.app.fetch(new Request(`${control.origin}${request.url}`, { method: request.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}), signal: disconnect.signal }));
      response.statusCode = result.status;
      for (const [name, value] of result.headers) if (name.toLowerCase() !== 'set-cookie') response.setHeader(name, value);
      const cookies = result.headers.getSetCookie(); if (cookies.length) response.setHeader('set-cookie', cookies);
      const reader = result.body?.getReader();
      if (reader) {
        try { while (!disconnect.signal.aborted) { const part = await reader.read(); if (part.done) break; if (!response.write(Buffer.from(part.value))) await new Promise<void>(done => {
          const finish = () => { response.removeListener('drain', finish); response.removeListener('close', finish); done(); };
          response.once('drain', finish); response.once('close', finish);
        }); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      }
      response.end();
    } catch { if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' }); if (!response.destroyed) response.end('{"error":"Local control request failed"}'); }
    finally { request.removeListener('aborted', abort); response.removeListener('close', abort); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); ready(); }); });
  const address = server.address() as AddressInfo; const origin = `http://127.0.0.1:${address.port}`;
  try { control = createControlApp({ ...options, origin }); }
  catch (error) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); throw error; }
  const owned = control;
  return { origin, control: owned, address: { host: address.address, port: address.port }, async close() { await owned.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
async function main(args: string[]) {
  let port = 8787; let configPath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log('Usage: pnpm control-server [--port 8787] [--config /absolute/runtime.json]\nLoopback only. Approve matching browser sign-in codes in this interactive terminal. No bearer/bootstrap secrets are printed.'); return; }
    if (args[i] === '--port') { const value = args[++i]; if (!value || !/^\d+$/.test(value)) throw new Error('Invalid port'); port = Number(value); continue; }
    if (args[i] === '--config') { const value = args[++i]; if (!value || !value.startsWith('/')) throw new Error('Absolute config path required'); configPath = value; continue; }
    throw new Error('Unknown control server flag');
  }
  let running: Awaited<ReturnType<typeof startControlServer>>; let queue = Promise.resolve(); let terminal: ReturnType<typeof createInterface> | undefined; let stopping = false;
  running = await startControlServer({ projectRoot: process.cwd(), port, demo: { loadConfig: () => loadRuntimeConfig(process.cwd(), configPath) }, onPendingApproval: code => {
    if (!process.stdin.isTTY || !process.stderr.isTTY) return;
    queue = queue.then(async () => {
      if (stopping) return; terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { const answer = await terminal.question(`Browser sign-in code ${code}. Type that code only if it matches your browser:\n> `); if (answer.trim() === code) running.control.approvePending(code); }
      catch {} finally { terminal.close(); terminal = undefined; }
    });
  } });
  console.log(`Command Center: ${running.origin}\nBrowser sign-in requires matching-code approval in this terminal. No Cloudflare request runs until an authenticated command is started.`);
  const stop = async () => { if (stopping) return; stopping = true; terminal?.close(); await running.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(() => { console.error('Control server could not start. Check the local port/configuration; no authentication secrets were printed.'); process.exitCode = 1; });
}
