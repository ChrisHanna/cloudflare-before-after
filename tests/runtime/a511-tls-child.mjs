import { pathToFileURL } from 'node:url';
const { receiptSender } = await import(pathToFileURL(process.argv[2]).href);
const spec = JSON.parse(process.argv[3]); let ok = false;
try {
  // Closed adapter: preserves HTTPS/hostname verification, maps ONLY fixture
  // localhost:443 to the ephemeral loopback TLS listener. No external socket.
  const dispatch = (url, init) => {
    if (String(url) !== 'https://localhost/ingest') throw new Error('Closed adapter denied');
    return fetch(`https://localhost:${spec.port}/ingest`, init);
  };
  await receiptSender('https://localhost/ingest', spec.secret, dispatch)(spec.receipt); ok = true;
} catch { /* No provider message, certificate, receipt body or credential in output. */ }
console.log(JSON.stringify({ ok }));
