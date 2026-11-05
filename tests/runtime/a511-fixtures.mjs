import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
export const exec = promisify(execFile);
/** Generated local-only CA/keys. Never reads the machine's real credentials. */
export async function makeTlsFixture(dir) {
  const run = args => exec('openssl', args, { cwd: dir, timeout: 10000 });
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=a511 synthetic CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
  for (const [name, host] of [['valid', 'localhost'], ['wrong', 'wrong.example.test']]) {
    await run(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', `${name}.key`, '-out', `${name}.csr`]);
    await run(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-copy_extensions', 'copy', '-out', `${name}.crt`]);
  }
  await run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=untrusted synthetic CA', '-keyout', 'other.key', '-out', 'other.crt']);
  const material = async name => ({ key: await readFile(join(dir, `${name}.key`)), cert: await readFile(join(dir, `${name}.crt`)) });
  return { ca: join(dir, 'ca.crt'), untrusted: join(dir, 'other.crt'), valid: await material('valid'), wrong: await material('wrong') };
}
