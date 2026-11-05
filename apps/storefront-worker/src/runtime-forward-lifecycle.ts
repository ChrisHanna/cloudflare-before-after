import { RuntimeFailure } from './runtime-failure.js';

/** Own native-forward leases. SDK 0.3.7 exposes an expiry hook, not begin/end
 * accounting. Do not mutate its private inflight counter or error formatter. */
export class ForwardActivity {
  #active = 0;
  constructor(private readonly renew: () => void) {}
  get active(): boolean { return this.#active !== 0; }
  #begin(): () => void {
    this.#active++; this.renew(); let released = false;
    return () => { if (!released) { released = true; this.#active--; if (!this.active) this.renew(); } };
  }
  async forward(request: Request, dispatch: (request: Request) => Promise<Response>): Promise<Response> {
    const release = this.#begin();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let finished = false; let cancelling = false;
    const finish = () => {
      if (finished) return;
      finished = true; request.signal.removeEventListener('abort', abort);
      try { reader?.releaseLock(); } catch { /* A pending read owns the lock until cancellation settles. */ }
      release();
    };
    const cancelSource = async () => { try { await reader?.cancel(); } catch { /* Never retain or log provider errors. */ } };
    const abort = () => {
      if (finished || cancelling || !reader) return;
      cancelling = true;
      void cancelSource().then(() => {
        finish();
        try { controller?.error(new RuntimeFailure('forward', 'cancelled')); } catch { /* Consumer already settled. */ }
      });
    };
    try {
      request.signal.throwIfAborted();
      const response = await dispatch(request);
      if (request.signal.aborted) { try { await response.body?.cancel(); } catch { /* Fixed error below. */ } throw new RuntimeFailure('forward', 'cancelled'); }
      if (!response.body) { finish(); return response; }
      reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(value) { controller = value; },
        async pull(value) {
          try {
            const part = await reader!.read();
            if (finished || cancelling) return;
            if (part.done) { finish(); value.close(); } else value.enqueue(part.value);
          } catch {
            if (!finished && !cancelling) { finish(); value.error(new RuntimeFailure('forward', 'unknown')); }
          }
        },
        async cancel() { if (finished || cancelling) return; cancelling = true; await cancelSource(); finish(); },
      }, { highWaterMark: 0 });
      // Observe source errors even if the caller has not started reading yet.
      // A normal closed stream still releases at consumer EOF, not at headers.
      void reader.closed.catch(() => {
        if (!finished && !cancelling) { finish(); controller?.error(new RuntimeFailure('forward', 'unknown')); }
      });
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      await cancelSource(); finish();
      // Do not hand a raw provider exception to SDK logging or response code.
      if (request.signal.aborted) throw new RuntimeFailure('forward', 'cancelled');
      if (error instanceof RuntimeFailure) throw error;
      throw new RuntimeFailure('forward', 'unknown');
    }
  }
}
