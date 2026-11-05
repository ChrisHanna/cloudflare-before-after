import { boundedBytes } from './deployment-http.js';
import type { Dispatch } from './transport.js';
export interface ReadbackOptions {
  attempts?: number; attemptTimeoutMs?: number; delayMs?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}
const pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason ?? new Error('Readback aborted')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error('Readback aborted')); };
  signal.addEventListener('abort', stop, { once: true });
});
// A fresh Container can take longer than one request to start, so only transient failures are retried.
export async function readStorefront(dispatch: Dispatch, origin: string, expected: { role: 'before' | 'after'; releaseDigest: string }, signal: AbortSignal, options: ReadbackOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 3; const delay = options.delayMs ?? (attempt => attempt * 3000); const sleep = options.sleep ?? pause;
  for (let attempt = 1; ; attempt++) {
    const outcome = await once(dispatch, origin, expected, signal, options.attemptTimeoutMs ?? 25000);
    if (outcome === 'ok') return;
    if (outcome === 'mismatch' || attempt >= attempts || signal.aborted) throw new Error('Deployed storefront readback failed');
    await sleep(delay(attempt), signal);
  }
}
async function once(dispatch: Dispatch, origin: string, expected: { role: 'before' | 'after'; releaseDigest: string }, signal: AbortSignal, timeoutMs: number): Promise<'ok' | 'mismatch' | 'transient'> {
  const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const response = await dispatch(`${origin}/catalog`, { method: 'GET', redirect: 'error', signal: attemptSignal });
    const body = await boundedBytes(response, 32768, attemptSignal);
    if (response.status === 429 || response.status >= 500) return 'transient';
    const exact = response.status === 200 && response.headers.get('x-lab-role') === expected.role && response.headers.get('x-lab-release') === expected.releaseDigest
      && (response.headers.get('x-lab-services') ?? '').includes('container-completed') && new TextDecoder().decode(body).includes('Synthetic');
    return exact ? 'ok' : 'mismatch';
  } catch (error) {
    if (signal.aborted) throw error;
    return 'transient';
  }
}
