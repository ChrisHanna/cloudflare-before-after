import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WaitingRoomExecutionSchema, WaitingRoomStateMachine } from '../packages/demo-core/src/waiting-room.js';
import { OptionalSelectionsSchema } from '../packages/demo-core/src/optional-product-integration.js';
import { deployedRuntimeConfig } from '../packages/demo-core/src/runtime-config.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { workshopWaitingRoomPlan } from '../packages/demo-core/src/workshop-runner.js';
import { limitsFor } from '../packages/demo-core/src/budget.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
const execution = { queueContract: 'cloudflare-json-v1' as const, expectedTransitionMs: 15000,
  perNavigationRequests: 2, refreshes: 1, queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]' };
function fixture(mode: 'live' | 'fixture' = 'fixture') {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'room-execution-')); roots.push(root);
  const inventory = infrastructureFixture().inventory; const intent = deploymentIntent(root); intent.discovery.labId = inventory.lab_id;
  const resource = { module: 'waiting-room' as const, resourceId: '3'.repeat(32), accountId: intent.discovery.accountId,
    zoneId: intent.discovery.zoneId, labId: intent.discovery.labId, origin: intent.discovery.environments[1].origin,
    releaseDigest: intent.releaseDigest, centralPlanDigest: 'a'.repeat(64), optionalPlanDigest: 'b'.repeat(64), operationId: 'c'.repeat(64),
    functionalDigest: 'd'.repeat(64), observedAt: new Date().toISOString(), mode,
    settings: { hostname: new URL(intent.discovery.environments[1].origin).hostname, path: '/launch', total_active_users: 200,
      new_users_per_minute: 200, session_duration: 1, queue_all: false as const, suspended: false as const }, execution: { ...execution } };
  const config = deployedRuntimeConfig(intent, inventory, 'c'.repeat(32), [], undefined, [resource]);
  return { root, intent, inventory, resource, config };
}
describe('reviewed Waiting Room execution settings are expectations, not queue proof', () => {
  it('accepts explicit bounded selection inputs while keeping omission explicit', () => {
    const f = fixture();
    const selected = OptionalSelectionsSchema.parse([{ module: 'waiting-room', settings: f.resource.settings, execution }]);
    expect(selected[0]).toMatchObject({ execution });
    const omitted = OptionalSelectionsSchema.parse([{ module: 'waiting-room', settings: f.resource.settings }]);
    expect(omitted[0]).not.toHaveProperty('execution');
  });
  it.each([
    { expectedTransitionMs: 0 }, { expectedTransitionMs: 110001 }, { perNavigationRequests: 0 }, { refreshes: 9 },
    { perNavigationRequests: 10, refreshes: 8 }, { queueSelector: 'main\ninput' }, { storefrontSelector: '' },
    { queueContract: 'asserted-html-selector' }, { queueContractQualified: true }, { liveReadiness: true },
  ])('rejects invalid limits or asserted proof fields: %j', fault => {
    expect(WaitingRoomExecutionSchema.safeParse({ ...execution, ...fault }).success).toBe(false);
  });
  it('projects declared settings without inferring actual live queue qualification', () => {
    const f = fixture('live'); const room = f.config.demonstrations!.waitingRoom!;
    expect(room).toEqual({ id: f.resource.resourceId, settings: f.resource.settings,
      expectedTransitionMs: 15000, perNavigationRequests: 2, refreshes: 1, queueSelector: '[data-queue]',
      storefrontSelector: '[data-storefront]', queueContractQualified: false });
    expect(workshopWaitingRoomPlan(f.config, limitsFor('scenario', { requests: 100 }))).toMatchObject({ expectedTransitionMs: 15000, telemetryRequests: 10 });
    const runId = randomUUID(); const machine = new WaitingRoomStateMachine(runId, 'live', { mode: 'live', state: 'observed', matchesScope: true,
      queueContractQualified: room.queueContractQualified, releaseDigest: f.intent.releaseDigest });
    machine.register('session-3', 'after', { ownerId: randomUUID(), runId, sessionId: 'session-3', releaseDigest: f.intent.releaseDigest });
    machine.observe({ sessionId: 'session-3', requestId: randomUUID(), observedAt: new Date().toISOString(), queue: true,
      storefront: false, queueCookiePresent: true, cookieContinuity: true, receipts: [] });
    expect(machine.result().liveReadiness).toBe(false); expect(machine.result().counts.queued).toBe(0);
    expect(machine.result().missingProof.join()).toContain('Unqualified queue');
  });
  it('qualifies modeled fixture selectors only, never a live execution claim', () => {
    const f = fixture(); expect(f.config.demonstrations!.waitingRoom!.queueContractQualified).toBe(true);
    expect(f.config.optionalResources![0]!.mode).toBe('fixture');
    expect(f.config).not.toHaveProperty('liveReadiness');
  });
  it('refuses interview plans that cannot fit the fixed Waiting Room slot', () => {
    const f = fixture(); f.config.demonstrations!.waitingRoom!.expectedTransitionMs = 90000;
    expect(() => workshopWaitingRoomPlan(f.config, limitsFor('scenario', { requests: 100, maxRuntimeMs: 75000 }))).toThrow('fit');
    expect(workshopWaitingRoomPlan(f.config, limitsFor('scenario', { requests: 100, maxRuntimeMs: 120000 }))).not.toBeNull();
  });
  it('refuses the actual default request envelope before any dispatch or browser launch', async () => {
    const f = fixture(); const dispatch = vi.fn(async () => { throw new Error('No requests allowed'); });
    const launch = vi.fn(async () => { throw new Error('No browser launch allowed'); });
    const result = await runDemoCli(['waiting-room', '--requests', '30', '--json'], { projectRoot: f.root, mode: 'fixture',
      loadConfig: () => f.config, credentials: () => ({ reader: FIXTURE_CREDENTIALS.reader, collector: FIXTURE_CREDENTIALS.collector, runner: FIXTURE_CREDENTIALS.runner }),
      dispatch, workshop: { browser: { launch } } });
    expect(result.exitCode).not.toBe(0); expect(dispatch).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  });
});
