import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventFeed } from '../apps/control-server/src/events.js';
import { controlFixture } from './fixtures/control.js';
import type { DemoCliDependencies } from '../packages/demo-core/src/demo-cli.js';
const fixtures: ReturnType<typeof controlFixture>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.cleanup(); });
describe('event-stream', () => {
  it('replays monotonic immutable events and replaces expired history with a bounded snapshot', async () => {
    const feed = new EventFeed(() => ({ phase: 'correlate', requestsUsed: 4 }), 4);
    const original = { value: 'original' }; const returned = feed.publish('phase', original); original.value = 'changed'; (returned.data as any).value = 'also-changed';
    const first = feed.stream(0); const reader = first.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('original'); await reader.cancel();
    for (let i = 0; i < 10; i++) feed.publish('phase', { value: i });
    const sequence = feed.sequence; expect(() => feed.publish('phase', { tooLarge: 'x'.repeat(65536) })).toThrow('bounded'); expect(feed.sequence).toBe(sequence);
    feed.close(); const expired = feed.stream(1).getReader(); const data = new TextDecoder().decode((await expired.read()).value); expect(data).toContain('event: snapshot'); expect(data).toContain('requestsUsed');
    expect((await expired.read()).done).toBe(true);
  });
  it('disconnects slow subscribers and bounds subscriber count without affecting the producer', async () => {
    const feed = new EventFeed(() => ({})); const reader = feed.stream(0).getReader();
    expect(feed.subscriberCount).toBe(1); for (let i = 0; i < 9; i++) feed.publish('phase', { value: i }); expect(feed.subscriberCount).toBe(0);
    expect(feed.sequence).toBe(9); await reader.cancel();
    const subscriptions = Array.from({ length: 4 }, () => feed.stream(feed.sequence).getReader()); expect(() => feed.stream(feed.sequence)).toThrow('Too many');
    for (const r of subscriptions) await r.cancel(); expect(feed.subscriberCount).toBe(0); feed.close();
  });
  it('reconnects API event readers without restarting work or resetting run counters', async () => {
    let hooks: DemoCliDependencies | undefined;
    const execute = vi.fn(async (_args: readonly string[], deps: DemoCliDependencies) => {
      hooks = deps; deps.onStarted?.({ runId: randomUUID(), stop: () => {} }); deps.onPhase?.('preflight');
      await new Promise<void>(resolve => deps.signal!.addEventListener('abort', () => resolve(), { once: true }));
      return { exitCode: 130, output: JSON.stringify({ kind: 'result', outcome: 'inconclusive' }) };
    });
    const f = controlFixture({ execute }); fixtures.push(f); await f.login();
    const started = await (await f.request('/api/runs', 'POST', { command: 'waf-custom', idempotencyKey: randomUUID(), liveOptIn: true })).json() as any;
    await vi.waitFor(() => expect(hooks).toBeDefined()); const id = started.run.id;
    const stream = await f.request(`/api/runs/${id}/events`); expect(stream.headers.get('content-type')).toBe('text/event-stream'); const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('id: 1'); await reader.cancel();
    expect((await (await f.request(`/api/runs/${id}`)).json() as any).run.status).toBe('running');
    for (let i = 0; i < 70; i++) hooks!.onPhase?.('correlate');
    const reconnected = await f.request(`/api/runs/${id}/events`, 'GET', undefined, { 'last-event-id': '1' }); const replay = reconnected.body!.getReader();
    expect(new TextDecoder().decode((await replay.read()).value)).toContain('event: snapshot'); await replay.cancel();
    expect(execute).toHaveBeenCalledOnce(); expect(f.calls).toEqual([]);
    expect((await f.request(`/api/runs/${id}/events`, 'GET', undefined, { 'last-event-id': 'not-an-id' })).status).toBe(400);
    await f.request(`/api/runs/${id}/stop`, 'POST', {}); expect((await f.wait(id)).status).toBe('cancelled');
  });
});
