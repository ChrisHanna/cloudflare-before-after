import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const config = JSON.parse(process.argv[3]);
// Closed loopback receipt transport. Never forwards an unknown URL.
const dispatch = async (url, init) => {
  if (String(url) !== 'https://telemetry.example.test/ingest') throw new Error('Closed fixture denied');
  return fetch(`http://127.0.0.1:${config.bridgePort}/egress`, { ...init, headers: { ...init.headers, 'x-fixture-key': config.key } });
};
if (process.argv[4] === 'production-server') {
  // Only test-local CA path, loopback bind and explicit receipt DI are mapped
  // during bundling. Actual production HTTP handler/app code is unmodified.
  globalThis.__restartReceiptDispatch = dispatch;
  globalThis.__restartSignalRecord = (req, res, signal) => {
    const sample = reason => setImmediate(() => {
      const listenerLeaks = req.listeners('aborted').some(f => f.name === 'onAborted') || res.listeners('close').some(f => f.name === 'onClose') || res.listeners('finish').some(f => f.name === 'cleanup');
      if (process.connected) process.send({ kind: 'signal', reason, ended: res.writableEnded, aborted: signal.aborted, listenerLeaks }, () => {});
    });
    req.once('aborted', () => sample('request-aborted')); res.once('close', () => sample('response-close')); res.once('finish', () => sample('response-finish'));
  };
  await import(pathToFileURL(process.argv[2]).href);
  process.send({ kind: 'ready', port: Number(process.env.PORT) });
} else {
  const { createContainerApp, receiptSender } = await import(pathToFileURL(process.argv[2]).href);
  const sendReceipt = receiptSender(config.RECEIPT_URL, config.RECEIPT_INGEST_SECRET, dispatch);
  const app = createContainerApp({ role: config.APP_ROLE, scenarioId: config.APP_SCENARIO, runId: config.APP_RUN_ID, producerId: config.APP_PRODUCER, releaseDigest: config.APP_RELEASE, internalSecret: config.APP_INTERNAL_SECRET, sendReceipt });
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const part of req) body += part;
      const abort = new AbortController(); req.on('aborted', () => abort.abort()); res.on('close', () => { if (!res.writableEnded) abort.abort(); });
      const request = new Request(`http://container.internal${req.url}`, { method: req.method, headers: req.headers, signal: abort.signal, ...(body ? { body } : {}) });
      const response = await app.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(503); res.end('Fixture request failed'); }
  });
  server.listen(0, '127.0.0.1', () => process.send({ kind: 'ready', port: server.address().port }));
  process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
}
