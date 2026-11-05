export async function boundedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break; length += part.value.byteLength; if (length > maxBytes) { await reader.cancel(); throw new Error('Setup response exceeds cap'); } chunks.push(part.value); } }
  finally { reader.releaseLock(); signal.removeEventListener('abort', abort); }
  const all = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; } return all;
}
