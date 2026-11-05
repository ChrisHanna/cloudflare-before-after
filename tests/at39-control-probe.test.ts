import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startControlServer } from '../apps/control-server/src/server.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { installedBrowser } from './browser-transport-fixtures.js';
import { DeploymentStore } from '../packages/demo-core/src/deployment-store.js';
import { createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { applyReviewedPlan, type SetupContext } from '../packages/demo-core/src/deployment-apply.js';
import { assessExecutionAudit, type ExecutionAudit } from '../packages/demo-core/src/execution-audit.js';
import { FIXTURE_CREDENTIALS } from './fixtures/deployment.js';

const project = '/mnt/c/users/NotAPC/Desktop/cloudflare_before_after';

describe('AT-15 actual control/UI/probe boundaries, fixture only', () => {
  it.each(['current', 'foreign-run'] as const)('joins allowed controls, UI counts and scoped receipts: %s', async fault => {
    const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'ui-'));
    const lab = demoLabFixture(root);
    const dispatch = async (url: string, init: RequestInit) => {
      const response = await lab.dispatch(url, init);
      if (fault !== 'foreign-run' || new URL(url).pathname !== '/receipts') return response;
      const data = await response.json();
      data.receipts = data.receipts.map((receipt: object) => ({ ...receipt, runId: randomUUID() }));
      return Response.json(data);
    };
    const control = await startControlServer({ projectRoot: root, port: 0,
      demo: { mode: 'fixture', dispatch, loadConfig: () => lab.config, credentials: () => lab.credentials } });
    const vite = await createServer({ root: join(project, 'apps/command-center'), cacheDir: join(root, 'vite'),
      configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0,
        proxy: { '/api': { target: control.origin, changeOrigin: true, headers: { origin: control.origin } } } } });
    const browser = await installedBrowser();
    try {
      await vite.listen(); const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw new Error('Loopback address missing');
      const origin = `http://127.0.0.1:${address.port}`; const context = await browser.newContext();
      try {
        const login = await fetch(`${control.origin}/api/bootstrap/redeem`, { method: 'POST',
          headers: { origin: control.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: control.control.issueBootstrap() }) });
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie()[0]!.split(';')[0]!; const equals = cookie.indexOf('=');
        await context.addCookies([{ name: cookie.slice(0, equals), value: cookie.slice(equals + 1), url: origin, httpOnly: true, sameSite: 'Strict' }]);
        // Every browser request stays on this loopback origin. Provider-looking
        // URLs above are passed only to the injected in-memory transport.
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage(); await page.goto(origin);
        await page.getByLabel('Allow bounded demo traffic to this lab').check();
        const created = page.waitForResponse(r => r.url().endsWith('/api/runs') && r.request().method() === 'POST');
        await page.getByRole('button', { name: 'Start scenario', exact: true }).click();
        const id = (await (await created).json()).run.id;
        await page.getByRole('link', { name: 'Open captured comparison report ↗' }).waitFor();
        const job = (await (await context.request.get(`${origin}/api/runs/${id}`)).json()).run;
        const report = job.result.report; expect(report.mode).toBe('fixture');
        expect(await page.getByRole('region', { name: 'Run evidence' }).innerText()).toContain(job.actualRunId);
        expect(report.result.requestsUsed).toBe(lab.calls.length);
        expect(report.result.requestsUsed).toBeLessThanOrEqual(30);
        expect(report.result.peakConcurrency).toBeLessThanOrEqual(2);
        for (const role of ['before', 'after']) {
          const panel = page.getByRole('article', { name: `${role === 'before' ? 'Before' : 'After'} evidence counts`, exact: true });
          const view = job.evidence.roles.find((value: { role: string }) => value.role === role);
          const controls = job.observations.filter((value: { targetRole: string; status: number }) => value.targetRole === role && value.status === 200);
          expect(controls.length).toBeGreaterThan(0);
          const receipts = job.artifacts.filter((a: any) => a.source === 'origin' && a.targetRole === role && a.payload.stage === 'entry');
          if (fault === 'current') {
            for (const probe of controls) expect(receipts.some((a: any) => a.runId === probe.runId && a.requestId === probe.requestId && a.payload.releaseDigest === report.result.releaseDigest)).toBe(true);
            expect(view.originReceived).toBe(new Set(receipts.map((a: any) => a.payload.requestId)).size);
          }
          expect(await panel.locator('[data-count="Requests"]').innerText()).toBe(String(view.requests));
          expect(await panel.locator('[data-count="Origin received"]').innerText()).toBe(view.originReceived === null ? 'Unknown' : String(view.originReceived));
          for (const source of view.sources) if (source.observedAt) expect(await panel.innerText()).toContain(source.observedAt);
        }
        if (fault === 'current') {
          expect(report.result.outcome).toBe('verified');
          const edge = job.artifacts.find((a: any) => a.source === 'cloudflare');
          expect(await page.getByRole('table', { name: 'Observed edge actions' }).innerText()).toContain(edge.payload.ruleId);
          expect(report.result.observedConfigDigest).not.toBeNull();
        } else expect(report.result.outcome).not.toBe('verified');
        const count = lab.calls.length;
        await page.getByRole('button', { name: 'Refresh local view' }).click();
        const replay = await context.request.get(`${origin}/api/runs/${id}/events?after=0`);
        expect(await replay.text()).toContain(job.actualRunId); expect(lab.calls.length).toBe(count);
        const text = await page.locator('body').innerText(); expect(text).toContain('FIXTURE');
        for (const secret of [...Object.values(lab.credentials), lab.canary]) expect(text).not.toContain(secret);
      } finally { await context.close(); }
    } finally { await browser.close(); await vite.close(); await control.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30000);

  it('uses the central reviewed-apply audit, not a caller zero, to block interview repair', async () => {
    const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'audit-')); const lab = demoLabFixture(root);
    try {
      const now = Date.now(); lab.intent.profile = 'core';
      const capabilities = await discoverCapabilities(lab.intent.discovery, 'core', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'offline-boundary', reasons: [] }) }, undefined, new Date(now).toISOString());
      const plan = createDeploymentPlan(lab.intent, capabilities, lab.intent.releaseDigest, root, now);
      const store = new DeploymentStore(root, lab.config.evidenceDirectory); const saved = store.save(plan);
      store.approve(saved.planPath, `APPROVE ${saved.digest}`, true, now);
      let audit: ExecutionAudit | undefined; let retained: SetupContext | undefined;
      const result = await applyReviewedPlan(store, saved.planPath, { intent: lab.intent, capability: capabilities,
        sourceDigest: plan.sourceDigest, credentials: FIXTURE_CREDENTIALS,
        createExecutor: async (_plan, installedAudit) => { audit = installedAudit; return { mode: 'fixture',
          execute: async (_step, context) => { retained = context; await context.perform('owned-fixture-write', 'owned-fixture', async () => {}); }, close: async () => {} }; } });
      expect(result.status).toBe('succeeded'); expect(audit).toBeDefined(); expect(retained).toBeDefined();
      audit!.beginVerification(); audit!.beginInterview(); const repair = vi.fn(async () => {});
      await expect(retained!.perform('console-repair', 'owned-fixture', repair)).rejects.toThrow('blocked');
      expect(repair).not.toHaveBeenCalled(); const evidence = audit!.finish();
      expect(evidence.scope).toMatchObject({ runId: plan.id, sourceDigest: plan.sourceDigest, configurationDigest: plan.intentDigest });
      expect(evidence.events.some(e => e.phase === 'deployment' && e.boundary === 'setup-context' && e.state === 'completed')).toBe(true);
      expect(evidence.events.some(e => e.phase === 'interview' && e.effect === 'setup' && e.state === 'blocked')).toBe(true);
      expect(assessExecutionAudit(evidence, evidence.scope)).toMatchObject({ outcome: 'repair-detected', noRepairObserved: false, readinessClaimValid: false });
      expect(assessExecutionAudit(JSON.parse(JSON.stringify(evidence)), evidence.scope).outcome).toBe('unknown');
      expect(assessExecutionAudit(evidence, { ...evidence.scope, runId: randomUUID() }).outcome).toBe('unknown');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
