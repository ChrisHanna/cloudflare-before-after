import type { Clock } from '../../packages/demo-core/src/budget.js';
export class TestClock implements Clock {
  #time = 0;
  #timers = new Set<{ at: number; fn: () => void }>();
  now(): number { return this.#time; }
  schedule(ms: number, fn: () => void): () => void {
    const timer = { at: this.#time + ms, fn }; this.#timers.add(timer);
    return () => this.#timers.delete(timer);
  }
  advance(ms: number): void {
    const end = this.#time + ms;
    while (true) {
      const next = [...this.#timers].filter(t => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.#time = next.at; this.#timers.delete(next); next.fn();
    }
    this.#time = end;
  }
}
