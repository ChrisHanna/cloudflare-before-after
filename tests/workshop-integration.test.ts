import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { runDoctor } from '../packages/demo-core/src/doctor.js';
import { runWorkshopScenario, workshopMinimum } from '../packages/demo-core/src/workshop-runner.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import { PolicySignalSchema } from '../packages/demo-core/src/api-shield-proof.js';
import { accessOptions } from './api-shield-fixtures.js';
import { labConfig } from './fixtures/lab.js';
import { demoLabFixture } from './fixtures/demo-lab.js';
import { installedBrowser } from './browser-transport-fixtures.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { controlFixture } from './fixtures/control.js';
import { ddosEventsBody, isApprovedReadGraphqlBody } from '../packages/demo-core/src/graphql.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
import { CATALOG_SEED, type Database } from '../apps/storefront-worker/src/d1.js';
import { contentDigest } from '../apps/storefront-worker/src/assets.js';
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function fixture(fault: 'none' | 'signal' | 'origin' = 'none') {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'workshop-integration-')); roots.push(root);
  const config = labConfig(root); config.liveOptIn = true;
  const p = accessOptions(); p.policy.beforeOrigin = config.environments[0].origin; p.policy.afterOrigin = config.environments[1].origin;
  p.readback!.hostname = new URL(p.policy.afterOrigin).hostname;
  config.demonstrations = { access: p.policy };
  const credentials = { reader: 'fixture-reader-long-enough-at-least-24', collector: 'fixture-collector-long-enough-at-least-24', runner: 'fixture-runner-long-enough-at-least-24' };
  const clientId = 'fixture-client-id-canary-long-enough'; const clientSecret = 'fixture-client-secret-canary-long-enough';
  const receipts: Receipt[] = []; let calls = 0;
  const signalByRequest = new Map<string, unknown>();
  const dispatch = async (url: string, init: RequestInit) => {
    calls++; const u = new URL(url); const h = new Headers(init.headers);
    if (u.origin === config.apiOrigin) {
      expect(h.get('authorization')).toBe(`Bearer ${credentials.reader}`);
      if (u.pathname.endsWith('/readback')) return Response.json(p.readback);
      if (u.pathname.endsWith('/signal')) return Response.json(signalByRequest.get(u.searchParams.get('requestId')!));
      throw new Error('Unplanned provider request');
    }
    if (u.origin === config.telemetryOrigin) {
      expect(h.get('authorization')).toBe(`Bearer ${credentials.collector}`);
      const role = u.searchParams.get('role')!;
      const found = receipts.filter(r => r.runId === u.searchParams.get('runId') && r.targetRole === role);
      return Response.json({ schemaVersion: 1, targetRole: role, runId: u.searchParams.get('runId'), scenarioId: u.searchParams.get('scenarioId'), originCount: found.length, receipts: found, coverage: { healthy: true, complete: true, windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: found.length, gaps: [] } });
    }
    const env = config.environments.find(e => e.origin === u.origin); if (!env) throw new Error('Unapproved fixture target');
    expect(h.get('x-demo-run-token')).toBe(credentials.runner);
    if (u.pathname === '/internal/checkpoint') return Response.json({ checkpoint: true });
    const authorized = h.get('cf-access-client-id') === clientId && h.get('cf-access-client-secret') === clientSecret;
    const allowed = env.role === 'before' || authorized;
    if (allowed || fault === 'origin') receipts.push({ schemaVersion: 1, id: randomUUID(), runId: h.get('x-demo-run-id')!, requestId: h.get('x-demo-request-id')!, scenarioId: 'access', targetRole: env.role, producerId: `fixture-${env.role}`, sequence: receipts.length + 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: env.releaseDigest, stage: 'entry' });
    const signal = env.role === 'before' || fault === 'signal' ? null : { product: 'access', applicationId: p.policy.applicationId, policyId: p.policy.policyId, audience: p.policy.audience, hostname: new URL(env.origin).hostname, path: '/admin', action: authorized ? 'allow' : 'login', identity: authorized ? 'lab-service-token' : 'none', source: 'cloudflare-access' };
    signalByRequest.set(h.get('x-demo-request-id')!, signal);
    return new Response(allowed ? '<main>synthetic admin</main>' : null, { status: allowed ? 200 : 302, headers: allowed ? {} : { location: 'https://personal-login.invalid/?token=must-not-follow' } });
  };
  const ownership = async () => new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`));
  const workshop = {
    resolveServiceToken: () => ({ clientId, clientSecret }),
    policyReadback: async (_id: 'access' | 'api-shield', client: Parameters<NonNullable<import('../packages/demo-core/src/workshop-runner.js').WorkshopRunnerOptions['policyReadback']>>[1], signal: AbortSignal) => (await client.requestJson({ url: `${config.apiOrigin}/client/v4/accounts/${config.accountId}/readback`, kind: 'cloudflare', headers: { authorization: `Bearer ${credentials.reader}` } }, z.unknown(), signal)).data,
    policySignal: async (q: import('../packages/demo-core/src/api-shield-proof.js').PolicyRequest, _response: unknown, client: Parameters<NonNullable<import('../packages/demo-core/src/workshop-runner.js').WorkshopRunnerOptions['policyReadback']>>[1], signal: AbortSignal) => q.role === 'before' ? null : (await client.requestJson({ url: `${config.apiOrigin}/client/v4/accounts/${config.accountId}/signal?requestId=${q.requestId}`, kind: 'cloudflare', headers: { authorization: `Bearer ${credentials.reader}` } }, PolicySignalSchema.nullable(), signal)).data,
  };
  return { root, config, credentials, dispatch, ownership, workshop, receipts, count: () => calls, clientSecret };
}
let accessPair: CryptoKeyPair; let accessJwk: JsonWebKey;
beforeAll(async () => {
  accessPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  accessJwk = { ...await crypto.subtle.exportKey('jwk', accessPair.publicKey), alg: 'RS256', use: 'sig', kid: 'synthetic-key' } as JsonWebKey; delete accessJwk.ext;
});
async function nativeAccessFixture(fault = '') {
  const f = fixture(); f.config.credentials.accessReaderTokenKind = 'account'; const p = f.config.demonstrations!.access!; const tokenId = '4'.repeat(32);
  const clientId = 'SYNTHETIC-NATIVE-CLIENT.access'; const clientSecret = 'SYNTHETIC-NATIVE-CLIENT-SECRET';
  const issuer = 'https://synthetic-team.cloudflareaccess.com'; const observedAt = new Date().toISOString();
  const tokenExpiresAt = new Date(Date.parse(observedAt) + 3600000).toISOString();
  f.config.demonstrations = { access: p, accessIdentity: { issuer, source: 'verified-rs256-service-jwt' },
    serviceToken: { ref: p.serviceTokenRef!, id: tokenId, clientIdRef: 'env:SYNTHETIC_CLIENT_ID', clientSecretRef: 'env:SYNTHETIC_CLIENT_SECRET' } };
  const trust = { issuer, audience: p.audience, approvedClientId: clientId, jwks: JSON.stringify({ keys: [accessJwk] }), jwksUrl: `${issuer}/cdn-cgi/access/certs`, keysObservedAt: observedAt };
  const detail = 'Synthetic detail'; const detailDigest = await contentDigest(detail); const receipts: Receipt[] = [];
  const applications: Record<string, unknown>[] = [{ id: p.applicationId, aud: p.audience, type: 'self_hosted', domain: 'after.example.test/admin', destinations: [{ type: 'public', uri: 'after.example.test/admin' }] }];
  const events: Record<string, unknown>[] = []; const calls: string[] = []; let appReads = 0; let workerCalls = 0;
  const caches = new Map<string, ReturnType<typeof createContainerApp>>();
  const db: Database = { prepare: () => { const stmt = { bind: () => stmt, first: async <T>() => CATALOG_SEED as T, all: async <T>() => ({ results: [] as T[] }), run: async () => ({}) }; return stmt; }, batch: async () => ({}) };
  const apps = new Map(f.config.environments.map(env => {
    const bindings: StorefrontBindings = { role: env.role, origin: env.origin, releaseDigest: env.releaseDigest, viewRunId: randomUUID(), labId: f.config.labId,
      runSecret: f.credentials.runner, internalSecret: 'synthetic-native-internal-secret', db,
      bucket: { get: async () => ({ text: async () => detail, customMetadata: { digest: detailDigest, environment: env.role, ownership: 'immutable-catalog' } }),
        put: async () => { throw new Error('No writes'); }, delete: async () => { throw new Error('No writes'); }, list: async () => ({ objects: [], truncated: false }) },
      image: { id: env.imageIds[0]!, role: env.role, labId: f.config.labId, immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'synthetic', variant: 'public', expectedDigest: 'a'.repeat(64) },
      ...(env.role === 'after' ? { accessIdentity: { mode: 'fixture' as const, trust: fault === 'issuer' ? { ...trust, issuer: 'https://other-team.cloudflareaccess.com', jwksUrl: 'https://other-team.cloudflareaccess.com/cdn-cgi/access/certs' } : trust } } : {}),
      containers: { getByName(key) { let app = caches.get(key);
        if (!app) { const [, scenarioId, runId] = key.split(':'); app = createContainerApp({ role: env.role, scenarioId: scenarioId as 'access', runId: runId!, producerId: `${env.role}-synthetic-container`, releaseDigest: env.releaseDigest,
          internalSecret: 'synthetic-native-internal-secret', sendReceipt: async receipt => { receipts.push(receipt); } }); caches.set(key, app); }
        return { fetch: async request => app!.request(await fixtureReservedRequest(request, { producerId: `${env.role}-synthetic-container`, releaseDigest: env.releaseDigest, internalSecret: 'synthetic-native-internal-secret' })) };
      } },
    };
    return [env.origin, createStorefrontWorker(bindings)] as const;
  }));
  const dispatch = async (url: string, init: RequestInit) => {
    calls.push(url); const u = new URL(url); const headers = new Headers(init.headers);
    if (u.origin === f.config.apiOrigin) {
      let result: unknown;
      if (u.pathname.endsWith('/tokens/verify')) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active' } });
      if (u.pathname.endsWith(`/tokens/${'6'.repeat(32)}`)) return Response.json({ success: true, result: { id: '6'.repeat(32), status: 'active', policies: [{ effect: 'allow', resources: { [`com.cloudflare.api.account.${f.config.accountId}`]: '*' }, permission_groups: [{ id: '7'.repeat(32), name: 'Access: Apps and Policies Read' }] }] } });
      if (u.pathname.endsWith('/access/apps')) {
        appReads++;
        if (fault === 'drift' && appReads > 1 || fault === 'alternate-scope') applications[0]!.destinations = [{ type: 'public', uri: 'before.example.test/admin' }];
        if (fault === 'session-drift' && appReads > 1) applications[0]!.session_duration = '1h';
        if (fault === 'final-denied' && appReads >= 4) return new Response('PRIVATE-DENIAL', { status: 403 });
        result = applications;
      } else if (u.pathname.endsWith('/policies')) result = [{ id: p.policyId, decision: 'non_identity', precedence: 1, include: [{ service_token: { token_id: tokenId } }], exclude: [], require: [] }];
      else if (u.pathname.includes('/service_tokens/')) result = { id: tokenId, client_id: clientId, expires_at: tokenExpiresAt, name: 'PRIVATE-TOKEN-NAME' };
      else if (u.pathname.endsWith('/access_requests')) result = ['no-event', 'branded-only'].includes(fault) ? [] : fault === 'audit-cap'
        ? Array.from({ length: 100 }, (_, i) => ({ ...events[0], ray_id: i === 0 ? events[0]?.ray_id : (i + 100).toString(16).padStart(16, '0') })) : events;
      else throw new Error('No provider fallback');
      return Response.json({ success: true, result, result_info: { page: 1, total_pages: fault === 'pages' && u.pathname.endsWith('/access_requests') ? 2 : 1 } });
    }
    if (u.origin === f.config.telemetryOrigin) {
      const start = u.searchParams.get('start')!; const end = u.searchParams.get('end')!;
      const found = receipts.filter(r => r.runId === u.searchParams.get('runId') && r.targetRole === u.searchParams.get('role') && r.observedAt >= start && r.observedAt <= end);
      if (fault === 'origin-denied' && u.searchParams.get('role') === 'after') return new Response('PRIVATE-DENIAL', { status: 403 });
      return Response.json({ schemaVersion: 1, targetRole: u.searchParams.get('role'), runId: u.searchParams.get('runId'), scenarioId: 'access',
        originCount: found.filter(r => r.stage === 'entry').length, receipts: found,
        coverage: { healthy: fault !== 'coverage', complete: fault !== 'coverage', windowStart: start, watermark: end,
          producerSequence: receipts.filter(r => r.targetRole === u.searchParams.get('role')).length, gaps: [] } });
    }
    if (u.pathname === '/internal/checkpoint') return Response.json({ checkpoint: true });
    const isAfter = u.origin === f.config.environments[1].origin;
    const authorized = headers.get('cf-access-client-id') === clientId && headers.get('cf-access-client-secret') === clientSecret;
    const ray = calls.length.toString(16).padStart(16, '0'); headers.set('cf-ray', ray);
    if (isAfter && !authorized && fault !== 'admitted') {
      const event: Record<string, unknown> = { action: fault === 'action' ? 'unknown' : 'login', allowed: fault === 'allowed' ? true : false,
        app_uid: fault === 'wrong-app' ? '9'.repeat(32) : p.applicationId,
        app_domain: fault === 'wrong-domain' ? 'before.example.test/admin' : 'after.example.test/admin', ray_id: fault === 'wrong-ray' ? '9'.repeat(16) : ray,
        created_at: new Date(Date.now() + (fault === 'event-time' ? 1000 : 0)).toISOString(), user_email: 'private-person@example.invalid', assertion: 'PRIVATE-ASSERTION' };
      events.push(event); if (fault === 'ambiguous') events.push({ ...event });
      return new Response(['branded', 'branded-only'].includes(fault) ? 'Cloudflare Access login' : null, { status: 403, headers: fault === 'no-ray' ? {} : { 'cf-ray': `${ray}-DFW` } });
    }
    if (isAfter) {
      const now = Math.floor(Date.now() / 1000);
      const text = `${Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'synthetic-key' })).toString('base64url')}.${Buffer.from(JSON.stringify({ type: 'app', aud: [p.audience], iss: issuer,
        common_name: fault === 'uuid' ? tokenId : clientId, sub: '', iat: now - 1, exp: now + 60 })).toString('base64url')}`;
      const jwt = `${text}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', accessPair.privateKey, new TextEncoder().encode(text))).toString('base64url')}`;
      headers.set('cf-access-jwt-assertion', fault === 'signature' ? jwt.slice(0, -4) + 'AAAA' : jwt);
    }
    workerCalls++; const response = await apps.get(u.origin)!.fetch(new Request(url, { ...init, headers }));
    response.headers.set('cf-ray', `${ray}-DFW`); return response;
  };
  const execute = () => runWorkshopScenario({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scenarioId: 'access', dispatch,
    ownershipPreflight: { minimumRequests: 0, run: f.ownership }, resolveServiceToken: () => ({ clientId, clientSecret }),
    policyReadback: async () => { throw new Error('Access readback callback must not run'); }, policySignal: async () => { throw new Error('Access signal callback must not run'); } });
  return { ...f, dispatch, execute, calls, receipts, workerCalls: () => workerCalls, clientId, clientSecret };
}
describe('native Access Worker/Container/runner/report path without success callbacks', () => {
  it('counts discovery without raising caps or charging neutral audit mode for unused JWT reads', async () => {
    const f = await nativeAccessFixture(); expect(workshopMinimum('access', 11, f.config)).toBe(35);
    delete f.config.demonstrations!.accessIdentity;
    expect(workshopMinimum('access', 11, f.config)).toBe(29); expect(f.calls).toHaveLength(0);
  });
  it('refuses a 24-request plan before any dispatch, preserving cleanup reserve', async () => {
    const f = await nativeAccessFixture();
    await expect(runWorkshopScenario({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scenarioId: 'access', dispatch: f.dispatch,
      limits: { requests: 24 }, ownershipPreflight: { minimumRequests: 0, run: f.ownership } })).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  it('joins real RSA, Worker and Container helpers without substituting a login failure for the negative case', async () => {
    const f = await nativeAccessFixture(); const capture = await f.execute();
    expect(capture.decision, JSON.stringify(capture.report.result)).toMatchObject({ outcome: 'inconclusive', mode: 'fixture' });
    expect(capture.decision.missingProof).toContain('Missing/invalid nonpersonal Access-token denial producer remains unqualified');
    expect(capture.decision.missingProof).not.toContain('after authorized product attribution');
    expect(capture.decision.missingProof).toContain('after missing product attribution');
    expect(capture.report.result.requestsUsed).toBe(24); expect(f.calls).toHaveLength(24); expect(f.workerCalls()).toBe(2);
    const proofs = capture.artifacts.filter(a => a.source === 'verification').map(a => a.payload);
    expect(proofs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'access-service-admission', approvingPolicyId: null, fullRuntimeState: null }),
      expect.objectContaining({ kind: 'access-application-rejection', credentialCaseCoverage: 'unqualified', event: expect.objectContaining({ policyId: null, audience: null, identity: 'unknown', allowed: false }) })]));
    const store = new ReportStore(f.root, f.config.evidenceDirectory); store.save(capture.report, capture.artifacts);
    expect(store.load(capture.report.result.runId)).toEqual(capture.report);
    for (const secret of [f.clientId, f.clientSecret, 'PRIVATE-TOKEN-NAME', 'PRIVATE-ASSERTION', 'private-person']) expect(JSON.stringify(capture)).not.toContain(secret);
    expect(capture.artifacts.filter(a => 'kind' in a.payload && a.payload.kind === 'access-config-snapshot')).toHaveLength(4);
  });
  it('runs the native Access CLI and saves joined observations without a T29 pass', async () => {
    const f = await nativeAccessFixture();
    const result = await runDemoCli(['access', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config,
      credentials: () => f.credentials, dispatch: f.dispatch, ownership: f.ownership, ownershipRequests: 0,
      workshop: { resolveServiceToken: () => ({ clientId: f.clientId, clientSecret: f.clientSecret }) } });
    expect(result.exitCode, result.output).toBe(1); const data = JSON.parse(result.output);
    expect(data.report.result).toMatchObject({ outcome: 'inconclusive', requestsUsed: 24, scenarioId: 'access' });
    expect(new ReportStore(f.root, f.config.evidenceDirectory).load(data.report.result.runId)).toEqual(data.report);
    expect(result.output).not.toContain(f.clientId); expect(result.output).not.toContain(f.clientSecret);
  });
  it.each(['no-event', 'branded-only', 'action', 'allowed', 'wrong-app', 'wrong-domain', 'wrong-ray', 'event-time', 'audit-cap', 'ambiguous', 'pages', 'no-ray', 'origin-denied', 'coverage', 'signature', 'uuid', 'issuer', 'final-denied'])(
    'keeps native %s proof non-passing', async fault => {
      const f = await nativeAccessFixture(fault); const r = await f.execute(); expect(r.decision.outcome).not.toBe('verified');
      expect(r.report.result.requestsUsed).toBe(f.calls.length); expect(f.calls.length).toBeLessThanOrEqual(30);
      expect(JSON.stringify(r)).not.toMatch(/PRIVATE-ASSERTION|private-person|PRIVATE-TOKEN-NAME/);
    });
  it.each(['admitted', 'drift', 'session-drift', 'alternate-scope'])('fails native %s contradictions without source fallback', async fault => {
    const f = await nativeAccessFixture(fault); const r = await f.execute(); expect(r.decision.outcome).toBe('failed');
    if (fault === 'alternate-scope') expect(f.workerCalls()).toBe(0);
  });
});
describe('joined CLI and concrete workshop runners', () => {
  it('runs the actual Access CLI through authenticated control-server execution', async () => {
    const f = fixture(); const server = controlFixture({ projectRoot: f.root, demo: { mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch: f.dispatch, ownership: f.ownership, ownershipRequests: 0, workshop: f.workshop } });
    try {
      expect((await server.request('/api/runs', 'POST', { command: 'access', liveOptIn: true, idempotencyKey: randomUUID() })).status).toBe(401);
      await server.login();
      const started = await server.request('/api/runs', 'POST', { command: 'access', liveOptIn: true, idempotencyKey: randomUUID() }); expect(started.status).toBe(202);
      const id = (await started.json() as any).run.id; const job = await server.wait(id);
      expect(job.result.report.result).toMatchObject({ scenarioId: 'access', outcome: 'inconclusive', requestsUsed: 0 });
      const calls = f.count(); await server.request(`/api/runs/${id}`); await server.request('/api/readiness');
      expect((await server.request(`/api/runs/${id}/sessions/session-1/preview`)).status).toBe(404);
      expect((await server.request(`/api/runs/${id}/advance`, 'POST', {})).status).toBe(409); expect(f.count()).toBe(calls);
    } finally { await server.cleanup(); }
  });
  it('refuses Access callback-only proof through the CLI without native config', async () => {
    const f = fixture();
    const r = await runDemoCli(['access', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch: f.dispatch, ownership: f.ownership, ownershipRequests: 0, workshop: f.workshop });
    expect(r.exitCode).toBe(1); const data = JSON.parse(r.output);
    expect(data.report.result).toMatchObject({ scenarioId: 'access', outcome: 'inconclusive', requestsUsed: 0, cleanup: 'complete' });
    expect(f.count()).toBe(0); expect(f.receipts).toHaveLength(0);
    expect(r.output).not.toContain(f.clientSecret); expect(r.output).not.toContain('must-not-follow');
    expect(new ReportStore(f.root, f.config.evidenceDirectory).load(data.report.result.runId)).toEqual(data.report);
  });
  it.each(['signal', 'origin'] as const)('rejects %s proof faults across actual CLI/server-ready report paths', async fault => {
    const f = fixture(fault); const r = await runDemoCli(['access', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => f.config, credentials: () => f.credentials, dispatch: f.dispatch, ownership: f.ownership, ownershipRequests: 0, workshop: f.workshop });
    expect(r.exitCode).toBe(1); expect(JSON.parse(r.output).report.result.outcome).toBe('inconclusive');
  });
  it('charges nested doctor reads against the aggregate parent', async () => {
    const f = fixture(); const lab = demoLabFixture(f.root); const parent = new BudgetLedger({ scope: 'all', limits: { cleanupRequests: 0 } });
    try { const r = await runDoctor({ projectRoot: f.root, config: lab.config, credentials: lab.credentials, mode: 'fixture', dispatch: lab.dispatch, scope: 'core-waf', parent }); expect(r.preflightReady).toBe(true); expect(parent.snapshot.requestsUsed).toBe(r.requestsUsed); expect(r.requestsUsed).toBeGreaterThan(0); } finally { parent.stop(); }
  });
  it('executes all/rehearsal with eleven honest outcomes and persists blocked readiness', async () => {
    const f = fixture(); const lab = demoLabFixture(f.root);
    const r = await runDemoCli(['rehearsal', '--max-runtime', '60', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: lab.dispatch });
    expect(r.exitCode).toBe(1); const data = JSON.parse(r.output); expect(data.kind).toBe('aggregate'); expect(data.result.items).toHaveLength(11);
    expect(data.result.requestsUsed).toBeGreaterThanOrEqual(data.result.doctor.requestsUsed); expect(data.result.requestsUsed).toBe(lab.calls.length); expect(data.readiness.claims.workshopVerified.verified).toBe(false); expect(data.readiness.claims.deploymentVerified.verified).toBe(false); expect(data.readinessPath.startsWith(lab.config.evidenceDirectory)).toBe(true);
  });
  it('all dispatches real CLI drivers without exceeding the cumulative allowance', async () => {
    const f = fixture(); const lab = demoLabFixture(f.root);
    const r = await runDemoCli(['all', '--json'], { projectRoot: f.root, mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: lab.dispatch });
    const data = JSON.parse(r.output); expect(data.kind).toBe('aggregate'); expect(data.result.items).toHaveLength(11);
    expect(data.result.items.find((i: any) => i.scenarioId === 'waf-custom').capture.report.result.outcome).toBe('verified');
    expect(data.result.requestsUsed).toBe(lab.calls.length); expect(data.result.requestsUsed).toBeLessThanOrEqual(300); expect(r.exitCode).toBe(1);
  });
  it('allows only fixed bounded read-only historical DDoS queries', () => {
    const body = ddosEventsBody({ zoneId: 'a'.repeat(32), hostname: 'after.example.test', start: '2026-11-04T00:00:00Z', end: '2026-11-04T00:01:00Z', limit: 50 });
    expect(isApprovedReadGraphqlBody(body)).toBe(true); expect(isApprovedReadGraphqlBody(body.replace('l7ddos', 'firewallrules'))).toBe(false); expect(isApprovedReadGraphqlBody(body.replace('query DdosEvents', 'mutation DdosEvents'))).toBe(false);
  });
  it.each(['none', 'initial-drift', 'drift', 'unreadable', 'plan'] as const)('runs Waiting Room with scoped receipts and final readback: %s', async fault => {
    const f = fixture(); const room = { hostname: new URL(f.config.environments[1].origin).hostname, path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false as const, queue_all: false as const };
    f.config.demonstrations = { waitingRoom: { id: 'a'.repeat(32), settings: room, expectedTransitionMs: 20, perNavigationRequests: 1, refreshes: 1, queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]', queueContractQualified: true } };
    const visits = new Map<string, number>(); const snapshots: import('../packages/demo-core/src/waiting-room.js').WaitingRoomResult[] = []; const previews: import('../packages/demo-core/src/browser-transport.js').BrowserPreview[] = [];
    let runId = ''; const receipts: Receipt[] = []; let calls = 0; let readbacks = 0; const collectorRoles: string[] = [];
    if (fault === 'plan') { f.config.demonstrations.waitingRoom!.refreshes = 8; f.config.demonstrations.waitingRoom!.perNavigationRequests = 10; }
    const dispatch = async (url: string, init: RequestInit) => { calls++; const u = new URL(url); if (u.origin === f.config.apiOrigin) { readbacks++; if (readbacks === 2 && fault === 'unreadable') return Response.json({ error: 'unreadable' }, { status: 503 }); return Response.json({ success: true, result: { id: 'a'.repeat(32), host: fault === 'initial-drift' || readbacks === 2 && fault === 'drift' ? 'wrong.example.test' : room.hostname, path: room.path, total_active_users: 200, new_users_per_minute: 200, session_duration: 1, suspended: false, queue_all: false } }); } if (u.origin === f.config.telemetryOrigin) { const role = u.searchParams.get('role'); collectorRoles.push(role!); const found = receipts.filter(r => r.targetRole === role); return Response.json({ schemaVersion: 1, runId, scenarioId: 'waiting-room', targetRole: role, originCount: found.length, receipts: found, coverage: { healthy: true, complete: true, windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: found.length, gaps: [] } }); } return Response.json({ checkpoint: true }); };
    const execute = () => runWorkshopScenario({ projectRoot: f.root, config: f.config, credentials: f.credentials, mode: 'fixture', scenarioId: 'waiting-room', dispatch, ownershipPreflight: { minimumRequests: 0, run: f.ownership }, onStarted: info => { runId = info.runId; }, onWaitingRoom: v => snapshots.push(v), onPreview: v => previews.push(v), browser: { launch: installedBrowser, fixture: async request => {
      const n = (visits.get(request.sessionId) ?? 0) + 1; visits.set(request.sessionId, n); const queue = request.sessionId === 'session-3' && n === 1;
      if (!queue && request.requestId) receipts.push({ schemaVersion: 1, id: randomUUID(), runId, requestId: request.requestId, scenarioId: 'waiting-room', targetRole: request.sessionId === 'session-1' ? 'before' : 'after', producerId: 'fixture-container', sequence: receipts.length + 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: f.config.environments[0].releaseDigest, stage: 'entry' });
      return { status: 200, contentType: 'text/html', headers: queue ? { 'set-cookie': '__cfwaitingroom=fixture-private-cookie; Path=/; Secure' } : {}, body: queue ? '<main data-queue>Queued synthetic shopper</main>' : '<main data-storefront>Synthetic launch shirt</main>' };
    } } });
    if (fault === 'plan') { await expect(execute()).rejects.toThrow(); expect(calls).toBe(0); expect(visits.size).toBe(0); return; }
    const r = await execute();
    if (fault === 'initial-drift') { expect(r.decision.outcome).toBe('failed'); expect(calls).toBe(1); expect(visits.size).toBe(0); expect(collectorRoles).toEqual([]); return; }
    expect(r.waitingRoom?.fixtureAssertionsPassed).toBe(fault === 'none'); expect(r.decision.outcome).toBe(fault === 'drift' ? 'failed' : 'inconclusive'); expect(r.report.result.sessionsUsed).toBe(3); expect(r.report.result.requestsUsed).toBe(15);
    expect(calls).toBe(10); // Five browser dispatches are separately metered.
    expect(readbacks).toBe(2); expect(collectorRoles).toEqual(['before', 'after', 'after', 'after']);
    if (fault === 'unreadable') expect(r.report.result.observedConfigDigest).toBeNull();
    if (fault === 'drift') expect(r.decision.contradictions).toContain('Waiting Room configuration changed or differs from the declared room');
    expect(snapshots.some(s => s.sessions.some(v => v.lastObservedState === 'queued'))).toBe(true); expect(snapshots.at(-1)?.sessions.every(s => s.state === 'closed')).toBe(true); expect(previews).toHaveLength(5); expect(JSON.stringify(previews)).not.toContain('fixture-private-cookie');
  }, 30000);
});
