import { createHash } from 'node:crypto';
import { digestValue } from './canonical.js';
export const MAX_WORKER_CODE_BYTES = 4 * 1024 * 1024;
export interface WorkerCodeMaterial { format: 'javascript' | 'multipart'; moduleCount: number; contentBytes: number; codeDigest: string }
const js = new Set(['application/javascript', 'text/javascript', 'application/javascript+module', 'text/javascript+module']);
const modules = new Set([...js, 'application/wasm', 'application/octet-stream', 'text/plain', 'application/json', 'application/source-map']);
const safeName = (name: string) => /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,159}$/.test(name) && !name.split('/').some(part => part === '..' || part === '.' || !part);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Bounded provider bytes only. No source, module names or response snippets escape. */
export async function readWorkerCodeMaterial(response: Response, signal: AbortSignal): Promise<WorkerCodeMaterial | null> {
  try { return await readMaterial(response, signal); }
  catch { throw new Error('Worker code read unavailable or outside its bounds'); }
}
async function readMaterial(response: Response, signal: AbortSignal): Promise<WorkerCodeMaterial | null> {
  const contentType = response.headers.get('content-type') ?? ''; const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (response.status !== 200 || !js.has(type) && type !== 'multipart/form-data') { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader(); if (!reader) return null;
  const chunks: Uint8Array[] = []; let length = 0; let finished = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) { finished = true; break; }
      length += part.value.byteLength;
      if (length > MAX_WORKER_CODE_BYTES) { await reader.cancel(); throw new Error('Worker code exceeds byte limit'); }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!length) return null;
  const bytes = Buffer.concat(chunks);
  if (js.has(type)) return { format: 'javascript', moduleCount: 1, contentBytes: length, codeDigest: digestValue({ format: 'javascript', type, digest: hash(bytes) }) };
  // The download contract supplies the entrypoint header. Never guess a main
  // module from filenames, ordering, an expected bundle or caller configuration.
  const main = response.headers.get('cf-worker-main-module-part');
  if (!main || !safeName(main)) return null;
  const form = await new Response(bytes, { headers: { 'content-type': contentType } }).formData();
  const files: { name: string; filename: string; type: string; digest: string }[] = [];
  const names = new Set<string>(); let mainIsScript = false;
  for (const [name, value] of form.entries()) {
    signal.throwIfAborted();
    if (files.length >= 32 || !safeName(name) || names.has(name) || typeof value === 'string'
      || !safeName(value.name) || !modules.has(value.type)) return null;
    names.add(name);
    if (name === main) mainIsScript = js.has(value.type);
    const data = new Uint8Array(await value.arrayBuffer()); signal.throwIfAborted();
    files.push({ name, filename: value.name, type: value.type, digest: hash(data) });
  }
  if (!files.length || !mainIsScript) return null;
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return { format: 'multipart', moduleCount: files.length, contentBytes: length, codeDigest: digestValue({ format: 'multipart', main, files }) };
}
