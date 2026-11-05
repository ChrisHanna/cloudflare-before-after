import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createContainerApp, receiptSender } from './app.js';
import { Role, ScenarioId, Id, Digest } from '../../../packages/contracts/src/schemas.js';
const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
export function startContainer() {
  const caPath = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';
  // Node loads extra roots before application startup; fail closed if the
  // runtime mount or verified TLS configuration was not supplied as expected.
  try {
    if (process.env['NODE_EXTRA_CA_CERTS'] !== caPath || process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') throw new Error();
    const ca = readFileSync(caPath, 'utf8');
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
    new X509Certificate(ca);
    createSecureContext({ ca });
  } catch { throw new Error('Container CA trust unavailable'); }
  const app = createContainerApp({ role: Role.parse(required('APP_ROLE')), scenarioId: ScenarioId.parse(required('APP_SCENARIO')), runId: Id.parse(required('APP_RUN_ID')), producerId: required('APP_PRODUCER'), releaseDigest: Digest.parse(required('APP_RELEASE')), internalSecret: required('APP_INTERNAL_SECRET'), sendReceipt: receiptSender(required('RECEIPT_URL'), required('RECEIPT_INGEST_SECRET')) });
  const port = Number(process.env['PORT'] ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Container port');
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    const onAborted = () => abort.abort();
    const cleanup = () => { req.removeListener('aborted', onAborted); res.removeListener('close', onClose); res.removeListener('finish', cleanup); };
    const onClose = () => { if (!res.writableEnded) abort.abort(); cleanup(); };
    req.once('aborted', onAborted); res.once('close', onClose); res.once('finish', cleanup);
    if (req.aborted) abort.abort();
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { res.writeHead(413); res.end(); return; } chunks.push(chunk); }
      const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) { if (typeof v === 'string') headers.set(k, v); }
      abort.signal.throwIfAborted();
      const response = await app.request(`http://127.0.0.1:${port}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, signal: abort.signal, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const body = Buffer.from(await response.arrayBuffer());
      if (!abort.signal.aborted && !res.destroyed) { res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body); }
    } catch { if (!res.destroyed && !res.writableEnded) { res.writeHead(500); res.end('Container request failed'); } }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'storefront-container', port: (server.address() as AddressInfo).port })));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => server.close());
  return server;
}
startContainer();
