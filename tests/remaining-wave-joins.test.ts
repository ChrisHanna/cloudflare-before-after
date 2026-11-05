import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { BrowserTransport } from '../packages/demo-core/src/browser-transport.js';
import { WaitingRoomStateMachine, navigateWaitingRoomShopper } from '../packages/demo-core/src/waiting-room.js';
import { validateBrowserFrame } from '../packages/contracts/src/waiting-room.js';
import { buildReadinessReport } from '../packages/demo-core/src/readiness-report-core.js';
import { evaluateDeployment, deploymentFingerprint } from '../packages/demo-core/src/deployment-verification-core.js';
import { createExecutionAudit } from '../packages/demo-core/src/execution-audit.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { controlFixture } from './fixtures/control.js';
import { browserOptions } from './browser-transport-fixtures.js';
import { deploymentFixture, digest, time, end } from './workshop-core-fixtures.js';

describe('remaining wave: joined offline boundaries, not acceptance', () => {
  it('serves real masked owned frames and routes admitted navigation in the same context', async () => {
    const o = browserOptions(); o.navigationPaths = ['/launch', '/catalog'];
    o.previewSelectors = ['main']; o.framePublicText = ['Synthetic shopper', 'Synthetic queue'];
    const receipts: Receipt[] = []; let visits = 0;
    o.fixture = async request => {
      visits++; const queue = request.sessionId === 'session-3';
      if (!queue && request.requestId) receipts.push({ schemaVersion: 1, id: randomUUID(), runId: o.correlation.runId, requestId: request.requestId, scenarioId: 'waiting-room', targetRole: request.sessionId === 'session-1' ? 'before' : 'after', producerId: `fixture-${request.sessionId}`, sequence: visits, observedAt: new Date().toISOString(), rayId: null, releaseDigest: digest, stage: 'entry' });
      return { status: 200, contentType: 'text/html', headers: { 'set-cookie': '__cfwaitingroom=private-cookie-canary; Path=/; Secure; HttpOnly' }, body: `<main ${queue ? 'data-queue' : 'data-storefront'}><p data-demo-public>${queue ? 'Synthetic queue' : 'Synthetic shopper'}</p><input value="private-cookie-canary"><div data-private>PRIVATE-CANARY</div></main>` };
    };
    const transport = (await BrowserTransport.create(o))!;
    const machine = new WaitingRoomStateMachine(o.correlation.runId, 'fixture', { mode: 'fixture', state: 'observed', matchesScope: true, queueContractQualified: true, releaseDigest: digest });
    const selectors = { queue: '[data-queue]', storefront: '[data-storefront]' };
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void; const prepared = new Promise<void>(resolve => { ready = resolve; });
    let navigationCalls = 0; let executionError: unknown;
    const server = controlFixture({ demo: { mode: 'fixture', loadConfig: () => o.config }, execute: async (_args, deps) => {
      try {
        deps.onStarted?.({ runId: o.correlation.runId, stop: release });
        for (const role of ['before', 'after', 'after'] as const) {
          const id = await transport.open(role); machine.register(id, role, transport.frameScope(id));
          await transport.navigate(id, `https://${role}.example.test/launch`);
          const view = await transport.inspect(id, selectors); const linked = receipts.filter(r => r.requestId === view.requestId);
          machine.observe({ ...view, queueObservation: view, receipts: linked });
          if (view.storefront) await transport.confirmAdmission(id, selectors.storefront, linked);
        }
        deps.onWaitingRoom?.(machine.result());
        deps.onRoomControl?.({
          scopes: () => transport.sessions.filter(s => s.state === 'open').map(s => transport.frameScope(s.sessionId)),
          capture: scope => transport.captureFrame(scope, 'main'),
          navigate: async (scope, path, signal) => {
          navigationCalls++;
          const result = await navigateWaitingRoomShopper({ transport, machine, scope, path, selectors, signal: signal ?? transport.signal, receipts: async id => receipts.filter(r => r.requestId === id) });
          deps.onWaitingRoom?.(result);
        } });
        for (const id of ['session-2', 'session-3']) deps.onFrame?.(await transport.captureFrame(transport.frameScope(id), 'main'));
        ready(); await held;
        return { exitCode: 1, output: JSON.stringify({ kind: 'result', outcome: 'inconclusive', reason: 'Offline boundary test only' }) };
      } catch (error) { executionError = error; ready(); throw error; }
    } });
    o.config.evidenceDirectory = join(server.root, '.evidence');
    try {
      await server.login();
      const started = await server.request('/api/runs', 'POST', { command: 'waiting-room', liveOptIn: true, idempotencyKey: randomUUID() });
      expect(started.status).toBe(202); const jobId = (await started.json() as any).run.id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([prepared, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Preparation deadline')), 10000); })]); }
      finally { if (timer) clearTimeout(timer); }
      expect(executionError).toBeUndefined();
      const job = (await (await server.request(`/api/runs/${jobId}`)).json() as any).run;
      expect(job.actualRunId).toBe(o.correlation.runId); expect(job.id).not.toBe(job.actualRunId);
      const scope = transport.frameScope('session-2'); const base = `/api/runs/${jobId}/sessions/session-2`;
      const framePath = `${base}/frame?${new URLSearchParams({ scope: JSON.stringify(scope) })}`;
      const response = await server.request(framePath); expect(response.status).toBe(200);
      const frame = validateBrowserFrame(await response.json(), scope, 'fixture');
      expect(frame.frame.startsWith('data:image/png;base64,')).toBe(true);
      expect(JSON.stringify(job)).not.toContain('private-cookie-canary');
      const before = visits;
      expect((await server.request(`${base}/navigation`, 'POST', { scope, path: '/catalog' }, { 'x-csrf-token': 'invalid' })).status).toBe(403);
      expect((await server.request(`${base}/navigation`, 'POST', { scope: { ...scope, ownerId: randomUUID() }, path: '/catalog' })).status).toBe(409);
      expect((await server.request(`${base}/navigation`, 'POST', { scope, path: '/admin' })).status).toBe(409);
      const queuedScope = transport.frameScope('session-3');
      expect((await server.request(`/api/runs/${jobId}/sessions/session-3/navigation`, 'POST', { scope: queuedScope, path: '/catalog' })).status).toBe(409);
      expect(navigationCalls).toBe(0); expect(visits).toBe(before);
      expect((await server.request(`${base}/navigation`, 'POST', { scope, path: '/catalog' })).status).toBe(200);
      expect(navigationCalls).toBe(1); expect(visits).toBe(before + 1);
      expect(machine.result().sessions.find(s => s.sessionId === 'session-2')?.cookieContinuity).toBe(true);
      // A frame from the prior document is gone, even within its five-second TTL.
      expect((await server.request(framePath)).status).toBe(404);
      expect((await server.request(`${base}/capture`, 'POST', { ...scope, runId: randomUUID() })).status).toBe(409);
      await new Promise(resolve => setTimeout(resolve, 1050));
      const recaptured = await server.request(`${base}/capture`, 'POST', scope);
      expect(recaptured.status).toBe(200); validateBrowserFrame(await recaptured.json(), scope, 'fixture');
      expect(visits).toBe(before + 1); // Actual pixels cost no storefront request.
      const qPath = `/api/runs/${jobId}/sessions/session-3/frame?${new URLSearchParams({ scope: JSON.stringify(queuedScope) })}`;
      await server.login(); // A second presenter cannot borrow the first one's browser.
      expect((await server.request(qPath)).status).toBe(404);
      expect((await server.request(`${base}/navigation`, 'POST', { scope, path: '/catalog' })).status).toBe(404);
      expect(navigationCalls).toBe(1);
      expect(machine.result().liveReadiness).toBe(false);
    } finally { release(); await server.cleanup(); await transport.close(); o.ledger.stop(); }
  }, 20000);

  it.each(['missing', 'copied', 'foreign', 'incomplete'] as const)('rejects %s audit despite a caller zero count', kind => {
    const f = deploymentFixture(); const configurationDigest = deploymentFingerprint(f.state);
    const scope = { runId: randomUUID(), releaseDigest: digest, configurationDigest, mode: 'live' as const, accountId: f.config.accountId, zoneId: f.config.zoneId };
    const audit = createExecutionAudit(scope, { before: f.config.environments[0].origin, after: f.config.environments[1].origin, telemetry: f.config.telemetryOrigin });
    audit.beginVerification(); const evidence = audit.finish();
    const deployment = evaluateDeployment({ mode: 'live', expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, observedAt: end, startedAt: time, beforeObservedAt: time, afterObservedAt: end });
    const report = buildReadinessReport({ mode: 'live', scope: 'core', observedAt: end, releaseDigest: digest, configurationDigest, hostnames: ['before.example.test', 'after.example.test'], includedModules: [], excludedModules: [], core: { appliedInventoryDigest: digest, observedInventoryDigest: digest, reachableRoles: ['before', 'after'] }, deployment, captures: [], currentScenarioDigests: {}, setupMutations: 0, measured: { requestsUsed: 0, durationMs: 0 }, ...(kind === 'missing' ? {} : { executionAudit: { scope: kind === 'foreign' ? { ...scope, runId: randomUUID() } : scope, evidence: kind === 'copied' ? structuredClone(evidence) : evidence } }) });
    expect(report.claims.deploymentVerified.verified).toBe(false);
    expect(report.claims.deploymentVerified.blockers).toContain('Complete independently scoped execution audit is missing or unqualified');
    expect(report.claims.interviewVerified.verified).toBe(false); expect(report.claims.workshopVerified.verified).toBe(false);
  });
});
