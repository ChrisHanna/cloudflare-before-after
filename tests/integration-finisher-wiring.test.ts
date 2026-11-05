import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLabCli } from '../packages/demo-core/src/lab-cli.js';
import { deploymentIntent, FIXTURE_CREDENTIALS, minimalSourceTree } from './fixtures/deployment.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { createDeploymentPlan, digestValue } from '../packages/demo-core/src/deployment-plan.js';
import { createOptionalProductProvider, executeOptionalProductSetupStep, optionalProductDesired, planOptionalProductSetup } from '../packages/demo-core/src/optional-product-setup.js';
import { approveOptionalSetup, defaultOptionalProvider, loadOptionalApproval, loadOptionalSetup, saveOptionalSetup } from '../packages/demo-core/src/optional-product-integration.js';
import { OptionalProductFileJournal } from '../packages/demo-core/src/optional-product-setup-store.js';
import { accessPolicyDispatch } from '../packages/demo-core/src/access-policy-transport.js';
import { apiShieldDispatch } from '../packages/demo-core/src/api-shield-transport.js';
import { createExecutionAudit, assessExecutionAudit } from '../packages/demo-core/src/execution-audit.js';
import { accessOptions, apiOptions } from './api-shield-fixtures.js';
import type { LabCliDependencies } from '../packages/demo-core/src/lab-cli.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { labConfig } from './fixtures/lab.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'join-')); roots.push(root); minimalSourceTree(root);
  const now = Date.now(); const intent = deploymentIntent(root, now); intent.profile = 'workshop';
  const optionalKeys = new Set(['custom-waf', 'security-events', 'rate-limiting', 'bot-management', 'turnstile', 'api-shield', 'ddos-evidence']);
  const inspect = async (key: string) => ({ state: optionalKeys.has(key) ? 'unknown' as const : 'available' as const, source: 'offline-boundary', reasons: [] });
  const capability = await discoverCapabilities(intent.discovery, 'workshop', { mode: 'fixture', inspect }, undefined, new Date(now).toISOString());
  const plan = createDeploymentPlan(intent, capability, 'b'.repeat(64), root, now, ['core', 'access', 'waiting-room']);
  const selections = [{ module: 'access' as const, serviceTokenId: 'd'.repeat(32) }, { module: 'waiting-room' as const, settings: { hostname: 'after.example.test', path: '/launch' as const, total_active_users: 200, new_users_per_minute: 200, session_duration: 1, queue_all: false as const, suspended: false as const } }];
  const resources: Record<string, any[]> = { access: [], 'waiting-room': [] }; const writes: string[] = [];
  const dispatch = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const wrap = (result: unknown) => Response.json({ success: true, result, result_info: { page: 1, total_pages: 1 } });
    if (path === `/client/v4/zones/${intent.discovery.zoneId}`) return wrap({ id: intent.discovery.zoneId, account: { id: intent.discovery.accountId }, name: 'example.test' });
    if (path.includes('/service_tokens/')) return wrap({ id: 'd'.repeat(32) });
    if (path.includes('/policies')) return wrap(resources.access![0]?.policies);
    const module = path.includes('/access/apps') ? 'access' : path.includes('/waiting_rooms') ? 'waiting-room' : null;
    if (!module) throw new Error('Unplanned offline endpoint');
    if (init.method === 'POST') { writes.push(module); const body = JSON.parse(String(init.body)); const resource = { ...body, id: (module === 'access' ? '1' : '2').repeat(32) }; resources[module]!.push(resource); return wrap(resource); }
    return wrap(resources[module]);
  });
  const provider = createOptionalProductProvider('fixture', { exchange: async (request, signal) => (await dispatch(`https://api.cloudflare.com/client/v4${request.path}`, { method: request.method, ...(request.method === 'POST' ? { body: JSON.stringify(request.body) } : {}), signal })).json(), inspectCertificate: async () => { throw new Error('Not selected'); } });
  return { root, now, intent, capability, inspect, plan, selections, provider, dispatch, writes, resources };
}
describe('integration finisher: actual production joins, offline transports', () => {
  it('persists exact extension, rejects changed targets and refuses copied approval digests', async () => {
    const f = await fixture(); const signal = new AbortController().signal;
    const setup = await planOptionalProductSetup(f.plan, f.selections, f.provider, {}, signal, f.now);
    const central = join(f.intent.discovery.evidenceDirectory, 'deployment', 'plans', 'central.json');
    // Use the real store directory through the CLI fixture below; here create it explicitly.
    const { mkdirSync } = await import('node:fs'); mkdirSync(join(f.intent.discovery.evidenceDirectory, 'deployment', 'plans'), { recursive: true });
    const path = saveOptionalSetup(f.root, central, setup);
    expect(loadOptionalSetup(f.root, path, f.plan)).toEqual(setup);
    expect(() => approveOptionalSetup(f.root, path, f.plan, `APPROVE OPTIONAL ${digestValue(setup)}`, false, f.now)).toThrow('interactive');
    approveOptionalSetup(f.root, path, f.plan, `APPROVE OPTIONAL ${digestValue(setup)}`, true, f.now);
    expect(loadOptionalApproval(f.root, path, f.plan, f.now).centralPlanDigest).toBe(digestValue(f.plan));
    const changed = structuredClone(f.plan); changed.intent.discovery.environments[1].origin = 'https://other.example.test';
    expect(() => loadOptionalSetup(f.root, path, changed)).toThrow('immutable');
    expect(() => loadOptionalApproval(f.root, path, f.plan, f.now + 900001)).toThrow('expired');
    const approved = JSON.parse(readFileSync(`${path}.approval.json`, 'utf8')); approved.planDigest = 'f'.repeat(64); writeFileSync(`${path}.approval.json`, JSON.stringify(approved));
    expect(() => loadOptionalApproval(f.root, path, f.plan, f.now)).toThrow('changed'); expect(f.writes).toEqual([]);
  });
  it('joins plan/dual approval/apply and durable intent to the real optional executor', async () => {
    const f = await fixture(); const selectionsPath = join(f.root, 'selections.json'); writeFileSync(selectionsPath, JSON.stringify(f.selections));
    let lastPlan: typeof f.plan;
    const deps: LabCliDependencies = { projectRoot: f.root, loadConfig: () => f.intent, sourceDigest: () => 'b'.repeat(64), now: () => f.now,
      provider: () => ({ provider: { mode: 'fixture', inspect: f.inspect }, close() {} }), prepare: async () => [], credentials: () => FIXTURE_CREDENTIALS,
      optionalProvider: plan => { lastPlan = plan; return f.provider; },
      confirm: async prompt => ({ interactiveTTY: true, confirmation: /Type (APPROVE(?: OPTIONAL)? [a-f0-9]{64})/.exec(prompt)![1]! }),
      createExecutor: async plan => ({ mode: 'fixture', close: async () => {}, execute: async (step, context) => {
        if (step.kind !== 'product-policy') return;
        await executeOptionalProductSetupStep(step, { plan, setup: loadOptionalSetup(f.root, optionalPath, plan), approval: loadOptionalApproval(f.root, optionalPath, plan, f.now), provider: f.provider, journal: new OptionalProductFileJournal(f.root, f.intent.discovery.evidenceDirectory), context, revalidate: async () => lastPlan, now: () => f.now });
      } }),
    };
    const command = (...args: string[]) => runLabCli([...args, '--json'], deps);
    const result = await command('plan', '--optional-selections', selectionsPath); expect(result.exitCode).toBe(0);
    const saved = JSON.parse(result.output); const optionalPath = saved.optionalPlanPath as string; expect(optionalPath).toContain('.optional.json');
    expect((await command('apply', '--plan', saved.planPath, '--optional-plan', optionalPath)).exitCode).toBe(2); expect(f.writes).toEqual([]);
    expect((await command('approve', '--plan', saved.planPath)).exitCode).toBe(2); expect(f.writes).toEqual([]);
    expect((await command('approve', '--plan', saved.planPath, '--optional-plan', optionalPath)).exitCode).toBe(0);
    const applied = await command('apply', '--plan', saved.planPath, '--optional-plan', optionalPath);
    expect(applied.exitCode).toBe(0); expect(f.writes).toEqual(['access', 'waiting-room']);
    expect(JSON.parse(applied.output).record.status).toBe('succeeded');
  });
  it('default provider sends real supported paths with injected I/O, not live calls', async () => {
    const f = await fixture(); const plan = structuredClone(f.plan); plan.mode = 'live'; plan.capability.mode = 'live'; plan.intent.discovery.liveOptIn = true;
    const provider = defaultOptionalProvider(plan, FIXTURE_CREDENTIALS, f.dispatch);
    for (const selection of f.selections) {
      const state = await provider.inspect(plan, selection, new AbortController().signal);
      await provider.create(plan, selection, state, new AbortController().signal);
      const observed = await provider.inspect(plan, selection, new AbortController().signal);
      expect(observed.resources[0]).toMatchObject(optionalProductDesired(plan, selection));
    }
    expect(f.writes).toEqual(['access', 'waiting-room']);
    for (const [url, init] of f.dispatch.mock.calls) {
      expect(url.startsWith('https://api.cloudflare.com/client/v4/')).toBe(true); expect(init.redirect).toBe('error');
      expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${init.method === 'POST' ? FIXTURE_CREDENTIALS.deployer : FIXTURE_CREDENTIALS.reader}`);
    }
    const invalid = structuredClone(plan); invalid.intent.discovery.liveOptIn = false;
    expect(() => defaultOptionalProvider(invalid, FIXTURE_CREDENTIALS, f.dispatch)).toThrow('Explicit');
  });
  it('binds service-token and native certificate dispatch to exact run/request scope', async () => {
    const scope = { runId: randomUUID(), requestId: randomUUID(), scenarioId: 'access' as const };
    const raw = vi.fn(async () => new Response('synthetic'));
    const policy = accessOptions().policy;
    const transport = accessPolicyDispatch(policy, policy.serviceTokenRef, () => ({ clientId: 'c'.repeat(24), clientSecret: 's'.repeat(24) }), raw, { scope });
    const init = { method: 'GET', redirect: 'manual' as const, headers: { 'x-demo-run-id': scope.runId, 'x-demo-request-id': scope.requestId, 'x-demo-scenario': scope.scenarioId } };
    await expect(transport.dispatch(`${policy.afterOrigin}/admin`, { ...init, headers: { ...init.headers, 'x-demo-request-id': randomUUID() } })).rejects.toThrow('Foreign');
    expect(raw).not.toHaveBeenCalled(); await transport.dispatch(`${policy.afterOrigin}/admin`, init); expect(raw).toHaveBeenCalledOnce();
    const api = apiOptions().policy;
    const native = apiShieldDispatch(api, null, () => { throw new Error('No certificate read'); }, { scope: { ...scope, scenarioId: 'api-shield' } });
    await expect(native.dispatch(`${api.afterOrigin}/api`, init)).rejects.toThrow('Foreign'); // Stops before node:https.
  });
  it.each(['configured', 'confirmed-public-only', 'audit-only'] as const)('uses the default Access reader without making proof from redirects: %s', async credentialMode => {
    const f = await fixture(); const config = labConfig(f.root); config.liveOptIn = true; config.credentials.accessReaderTokenKind = 'account';
    const policy = { ...accessOptions().policy, beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin };
    const tokenId = 'd'.repeat(32);
    if (credentialMode !== 'confirmed-public-only') config.demonstrations = { access: policy, serviceToken: { ref: policy.serviceTokenRef!, id: tokenId, clientIdRef: 'env:LAB_CLIENT_ID', clientSecretRef: 'env:LAB_CLIENT_SECRET' } };
    else {
      policy.serviceTokenRef = null; config.demonstrations = { access: policy };
      config.optionalResources = [{ module: 'access', resourceId: policy.applicationId, policyId: policy.policyId, audience: policy.audience, serviceTokenId: tokenId,
        accountId: config.accountId, zoneId: config.zoneId, labId: config.labId, origin: config.environments[1].origin,
        releaseDigest: config.environments[1].releaseDigest, centralPlanDigest: 'a'.repeat(64), optionalPlanDigest: 'b'.repeat(64),
        operationId: 'c'.repeat(64), functionalDigest: 'd'.repeat(64), observedAt: new Date().toISOString(), mode: 'fixture' }];
    }
    const receipts: Receipt[] = []; let calls = 0; const scopes: string[] = []; const authRows: Record<string, unknown>[] = [];
    const apps = [{ id: policy.applicationId, domain: 'after.example.test/admin', aud: policy.audience, type: 'self_hosted' }, { id: '9'.repeat(32), domain: 'unrelated.example.test/admin', aud: 'e'.repeat(64), type: 'self_hosted' }];
    const dispatch = async (url: string, init: RequestInit) => {
      calls++; const u = new URL(url); const h = new Headers(init.headers);
      if (u.pathname.endsWith('/tokens/verify')) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active' } });
      if (u.pathname.endsWith(`/tokens/${'6'.repeat(32)}`)) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active', policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${config.accountId}`]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }] } });
      if (u.pathname.endsWith('/access/logs/access_requests')) return Response.json({ success: true, result: authRows, result_info: { page: 1, total_pages: 1 } });
      if (u.origin === config.apiOrigin) return Response.json({ success: true, result: u.pathname.endsWith('/policies') ? [{ id: policy.policyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] }] : apps, result_info: { page: 1, total_pages: 1 } });
      if (u.origin === config.telemetryOrigin) {
        const found = receipts.filter(r => r.runId === u.searchParams.get('runId') && r.targetRole === u.searchParams.get('role'));
        return Response.json({ schemaVersion: 1, targetRole: u.searchParams.get('role'), runId: u.searchParams.get('runId'), scenarioId: 'access', originCount: found.filter(r => r.stage === 'entry').length, receipts: found, coverage: { healthy: true, complete: true, gaps: [], windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: found.length } });
      }
      if (u.pathname === '/internal/checkpoint') return Response.json({ healthy: true });
      const env = config.environments.find(e => e.origin === u.origin)!; expect(u.pathname).toBe('/admin');
      scopes.push(h.get('x-demo-request-id')!);
      const allowed = env.role === 'before' || h.get('cf-access-client-secret') === 's'.repeat(24);
      if (allowed) for (const stage of ['entry', 'completion'] as const) receipts.push({ schemaVersion: 1, id: randomUUID(), runId: h.get('x-demo-run-id')!, requestId: h.get('x-demo-request-id')!, scenarioId: 'access', targetRole: env.role, producerId: `${env.role}-producer`, sequence: receipts.filter(r => r.targetRole === env.role).length + 1, releaseDigest: env.releaseDigest, observedAt: new Date().toISOString(), rayId: null, stage });
      const ray = scopes.length.toString(16).padStart(16, '0');
      if (credentialMode === 'audit-only' && env.role === 'after') authRows.push({ action: 'login', allowed, ray_id: ray,
        app_uid: policy.applicationId, app_domain: 'after.example.test/admin', created_at: new Date().toISOString(),
        user_email: 'private-person@example.invalid', ip_address: '203.0.113.17', connection: 'PRIVATE-CONNECTION' });
      return new Response(allowed ? 'Synthetic admin' : null, { status: allowed ? 200 : 302, headers: {
        ...(!allowed ? { location: 'https://personal-login.invalid/' } : {}), ...(credentialMode === 'audit-only' ? { 'cf-ray': `${ray}-DFW` } : {}),
      } });
    };
    const credentials = { reader: 'offline-reader-distinct-credential', collector: 'offline-collector-distinct-credential', runner: 'offline-runner-distinct-credential' };
    const owned = new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
    const result = await runDemoCli(['access', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => config, credentials: () => credentials, dispatch, ownership: async () => owned, ownershipRequests: 0, workshop: { resolveServiceToken: () => ({ clientId: 'c'.repeat(24), clientSecret: 's'.repeat(24) }) } });
    expect(result.exitCode).toBe(1); const data = JSON.parse(result.output);
    expect(data.report.result.outcome).toBe('inconclusive'); expect(scopes).toHaveLength(credentialMode === 'confirmed-public-only' ? 2 : 3); expect(new Set(scopes).size).toBe(scopes.length);
    expect(calls).toBe(credentialMode === 'audit-only' ? 17 : credentialMode === 'configured' ? 15 : 12); expect(data.report.result.requestsUsed).toBe(calls); expect(data.executionAudit.scope.runId).toBe(data.report.result.runId);
    expect(data.executionAudit.coverage).toContain('native-dispatch'); expect(data.executionAudit.events.some((e: any) => e.boundary === 'runtime-dispatch' && e.state === 'completed')).toBe(true);
    expect(result.output).not.toContain('s'.repeat(24)); expect(result.output).not.toContain('personal-login');
    if (credentialMode === 'audit-only') {
      const artifacts = new ReportStore(f.root, config.evidenceDirectory).loadArtifacts(data.report.result.runId);
      const auth = artifacts.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'access-authentication');
      expect(auth).toHaveLength(2);
      expect(auth.every(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'access-authentication' && artifact.payload.policyId === null && artifact.payload.identity === 'unknown')).toBe(true);
      expect(JSON.stringify(artifacts)).not.toMatch(/private-person|203\.0\.113\.17|PRIVATE-CONNECTION/);
      expect(data.report.result.missingProof.some((text: string) => text.includes('product attribution'))).toBe(true);
    }
    const ledger = new BudgetLedger();
    try {
      const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources: owned, credentials, dispatch });
      expect((await collector.accessPolicy(policy, tokenId)).state).toBe('observed');
      apps.push({ ...apps[0]!, id: '8'.repeat(32) });
      expect((await collector.accessPolicy(policy, tokenId)).state).toBe('mismatch');
    } finally { ledger.stop(); }
  });
  it.each(['run', 'configuration', 'source'] as const)('rejects foreign setup %s before an audited callback', async fault => {
    const f = await fixture(); const audit = createExecutionAudit({ runId: f.plan.id, releaseDigest: f.intent.releaseDigest, configurationDigest: f.plan.intentDigest, sourceDigest: f.plan.sourceDigest, mode: 'fixture', accountId: f.intent.discovery.accountId, zoneId: f.intent.discovery.zoneId }, { before: f.intent.discovery.environments[0].origin, after: f.intent.discovery.environments[1].origin, telemetry: f.intent.discovery.telemetryOrigin });
    const plan = structuredClone(f.plan);
    if (fault === 'run') plan.id = randomUUID();
    if (fault === 'configuration') plan.intentDigest = 'f'.repeat(64);
    if (fault === 'source') plan.sourceDigest = 'f'.repeat(64);
    const perform = vi.fn();
    expect(() => audit.hookSetupContext({ plan, signal: new AbortController().signal, perform, observeResource() {} })).toThrow('Foreign');
    expect(perform).not.toHaveBeenCalled();
  });
  it('observes native/browser boundaries independently and rejects serialized authority', async () => {
    const f = await fixture(); const scope = { runId: randomUUID(), releaseDigest: f.intent.releaseDigest, configurationDigest: f.plan.intentDigest, mode: 'fixture' as const, accountId: f.intent.discovery.accountId, zoneId: f.intent.discovery.zoneId };
    const targets = { before: f.intent.discovery.environments[0].origin, after: f.intent.discovery.environments[1].origin, telemetry: f.intent.discovery.telemetryOrigin };
    const audit = createExecutionAudit(scope, targets); const wrap = audit.hookNativeDispatchFactory();
    const raw = vi.fn(async () => new Response('synthetic')); const browser = audit.hookBrowserDispatch(raw);
    audit.beginVerification(); const native = wrap(raw);
    await native(`${targets.after}/api`, { method: 'GET' }); await browser(`${targets.before}/launch`, { method: 'GET' });
    await expect(browser(`${targets.before}/internal/seed`, { method: 'POST' })).rejects.toThrow('blocked');
    const evidence = audit.finish(); expect(evidence.events.some(e => e.boundary === 'native-dispatch' && e.state === 'completed')).toBe(true);
    expect(evidence.events.some(e => e.boundary === 'browser-dispatch' && e.state === 'blocked')).toBe(true);
    expect(raw).toHaveBeenCalledTimes(2); expect(assessExecutionAudit(evidence, scope).readinessClaimValid).toBe(false);
    expect(assessExecutionAudit(JSON.parse(JSON.stringify(evidence)), scope).outcome).toBe('unknown');
  });
});
