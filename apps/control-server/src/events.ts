export interface ControlEvent { id: number; type: string; observedAt: string; data: unknown }
interface Subscriber { controller: ReadableStreamDefaultController<Uint8Array>; cleanup(): void }
export class EventFeed {
  readonly #events: ControlEvent[] = [];
  readonly #subscribers = new Set<Subscriber>();
  #sequence = 0;
  #closed = false;
  constructor(readonly snapshot: () => unknown, readonly capacity = 64) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256) throw new Error('Invalid event replay capacity');
  }
  publish(type: string, data: unknown): ControlEvent {
    if (!/^[a-z-]{1,32}$/.test(type)) throw new Error('Invalid event type');
    const serialized = JSON.stringify({ id: this.#sequence + 1, type, observedAt: new Date().toISOString(), data });
    if (new TextEncoder().encode(serialized).byteLength > 65536) throw new Error('Event exceeds bounded payload');
    const event: ControlEvent = JSON.parse(serialized);
    this.#sequence = event.id;
    this.#events.push(event); if (this.#events.length > this.capacity) this.#events.shift();
    if (!this.#closed) for (const subscriber of [...this.#subscribers]) this.#push(subscriber, event);
    return structuredClone(event);
  }
  #push(subscriber: Subscriber, event: ControlEvent): void {
    if ((subscriber.controller.desiredSize ?? 0) <= 0) { subscriber.cleanup(); try { subscriber.controller.close(); } catch {} return; }
    try { subscriber.controller.enqueue(new TextEncoder().encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)); }
    catch { subscriber.cleanup(); }
  }
  stream(after: number, signal?: AbortSignal): ReadableStream<Uint8Array> {
    if (!Number.isInteger(after) || after < 0 || after > this.#sequence) throw new Error('Invalid replay position');
    if (this.#subscribers.size >= 4) throw new Error('Too many event subscribers');
    let subscriber: Subscriber | undefined;
    return new ReadableStream<Uint8Array>({
      start: controller => {
        const abort = () => { subscriber?.cleanup(); try { controller.close(); } catch {} };
        subscriber = { controller, cleanup: () => { if (subscriber) this.#subscribers.delete(subscriber); signal?.removeEventListener('abort', abort); } };
        const oldest = this.#events[0]?.id ?? this.#sequence;
        const replay = this.#events.filter(e => e.id > after);
        // Bound initial replay too; an expired or long replay is replaced by one snapshot.
        if ((after > 0 && after < oldest - 1) || replay.length > 6) this.#push(subscriber, { id: this.#sequence, type: 'snapshot', observedAt: new Date().toISOString(), data: this.snapshot() });
        else for (const event of replay) this.#push(subscriber, event);
        if (this.#closed || signal?.aborted) { subscriber.cleanup(); controller.close(); return; }
        this.#subscribers.add(subscriber); signal?.addEventListener('abort', abort, { once: true });
      },
      cancel: () => subscriber?.cleanup(),
    }, { highWaterMark: 8 });
  }
  close(): void {
    this.#closed = true;
    for (const subscriber of [...this.#subscribers]) { subscriber.cleanup(); try { subscriber.controller.close(); } catch {} }
  }
  get sequence(): number { return this.#sequence; }
  get subscriberCount(): number { return this.#subscribers.size; }
}
