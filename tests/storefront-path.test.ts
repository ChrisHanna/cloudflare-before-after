import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { StorefrontData, CATALOG_SEED, type Database } from '../apps/storefront-worker/src/d1.js';
import { OwnedAssets, type ObjectBucket } from '../apps/storefront-worker/src/assets.js';
import { createStorefrontWorker, type StorefrontBindings } from '../apps/storefront-worker/src/worker.js';
import { createContainerApp } from '../apps/storefront-container/src/app.js';
import { fixtureReservedRequest } from './container-restart-sequence-fixture.js';
import { createTrustedCollectors } from '../packages/demo-core/src/trusted-collectors.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { labConfig } from './fixtures/lab.js';
import { ServiceReadReceiptSchema } from '../packages/contracts/src/service-read.js';
import { collectDeploymentVerification } from '../packages/demo-core/src/deployment-verification-core.js';
import { makeArtifact, ReportStore } from '../packages/demo-core/src/reports.js';
import { runDemoCli } from '../packages/demo-core/src/demo-cli.js';
import { apiShieldModule } from '../packages/demo-core/src/api-shield.js';
import { apiOptions } from './api-shield-fixtures.js';
import type { PolicyRequest } from '../packages/demo-core/src/api-shield-proof.js';
import { readPlatformTlsVerification } from '../packages/demo-core/src/platform-tls.js';
import { TlsClientVerificationSchema } from '../packages/contracts/src/tls-client-verification.js';
import type { SafeResponse } from '../packages/demo-core/src/transport.js';
import { deploymentFixture } from './workshop-core-fixtures.js';
let mf: Miniflare; const previousTmp = process.env.TMPDIR;
const envs: StorefrontBindings[] = []; const entries: any[] = []; const instanceKeys: string[] = []; const evidenceRoots: string[] = [];
const runSecret = 'fixture-lab-run-secret-at-least-24'; const internalSecret = 'fixture-internal-secret-at-least-24';
beforeAll(async () => {
  if (!process.env.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH required');
  process.env.TMPDIR = process.env.KIROCREW_SCRATCH;
  mf = new Miniflare({ modules: true, script: 'export default { fetch() { return new Response("Local bindings"); } }', host: '127.0.0.1', port: 0, d1Databases: { BEFORE: 'before', AFTER: 'after' }, r2Buckets: { BEFORE: 'before', AFTER: 'after' }, d1Persist: false, r2Persist: false });
  for (const role of ['before', 'after'] as const) {
    const db = await mf.getD1Database(role.toUpperCase());
    await db.exec(readFileSync('apps/storefront-worker/migrations/0001_storefront.sql', 'utf8').replace(/\n/g, ' '));
    await db.exec(readFileSync('apps/storefront-worker/migrations/0005_verification_probes.sql', 'utf8').replace(/\n/g, ' '));
    const bucket = await mf.getR2Bucket(role.toUpperCase()) as unknown as ObjectBucket;
    await new StorefrontData(db as unknown as Database, role).seed(); await new OwnedAssets(bucket, role).seedDetail('launch-shirt', 'Synthetic detail');
    const cache = new Map<string, ReturnType<typeof createContainerApp>>();
    envs.push({ role, origin: `https://${role}.example.test`, releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), runSecret, internalSecret, labId: 'owned-lab', db: db as unknown as Database, bucket,
      image: { id: 'launch-shirt', role, labId: 'owned-lab', immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'owned', variant: 'public', expectedDigest: 'b'.repeat(64) },
      containers: { getByName(key) {
        instanceKeys.push(key); let app = cache.get(key);
        if (!app) { const [roleKey, scenarioId, runId] = key.split(':'); app = createContainerApp({ role: roleKey as any, scenarioId: scenarioId as any, runId: runId!, producerId: `${role}-producer`, releaseDigest: 'a'.repeat(64), internalSecret, sendReceipt: async receipt => { entries.push(receipt); } }); cache.set(key, app); }
        return { fetch: async req => app!.request(await fixtureReservedRequest(req, { producerId: `${role}-producer`, releaseDigest: 'a'.repeat(64), internalSecret })) };
      } },
    });
  }
}, 30000);
afterAll(async () => { await mf?.dispose(); evidenceRoots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });
describe('storefront-path', () => {
  it('returns only scoped platform TLS facts after actual local Container completion', async () => {
    const env = envs.find(value => value.role === 'after')!; const app = createStorefrontWorker(env);
    const runId = randomUUID(); const requestId = randomUUID(); const start = new Date(Date.now() - 1000).toISOString();
    const request = new Request(`${env.origin}/api`, { headers: { 'x-demo-run-id': runId, 'x-demo-request-id': requestId,
      'x-demo-scenario': 'api-shield', 'x-demo-run-token': runSecret } });
    Object.defineProperty(request, 'cf', { value: { tlsClientAuth: { certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0',
      certFingerprintSHA256: 'b'.repeat(64), certSubjectDN: 'PRIVATE-PERSON', certIssuerDN: 'PRIVATE-ISSUER', certRFC9440: 'PRIVATE-CERT-DER' } } });
    const response = await app.fetch(request); expect(response.status).toBe(200);
    const text = await response.text(); const body = JSON.parse(text); const facts = TlsClientVerificationSchema.parse(body.tlsClientVerification);
    expect(facts).toMatchObject({ runId, requestId, targetRole: 'after', scenarioId: 'api-shield', certificateVerified: true, fingerprintSha256: 'b'.repeat(64) });
    expect(entries.some(receipt => receipt.runId === runId && receipt.requestId === requestId && receipt.stage === 'completion')).toBe(true);
    expect(text).not.toMatch(/PRIVATE|certSubjectDN|certIssuerDN|certRFC9440/); expect(text).not.toContain(runSecret);
    const safe: SafeResponse = { status: response.status, excerpt: text, rayId: null, latencyMs: 1,
      metadata: { role: response.headers.get('x-lab-role') === 'after' ? 'after' : null, releaseDigest: response.headers.get('x-lab-release'),
        services: ['container-completed'], contentType: 'application/json', bodyBytes: Buffer.byteLength(text) } };
    expect(readPlatformTlsVerification(safe, { runId, requestId, releaseDigest: env.releaseDigest, hostname: 'after.example.test', start, end: new Date().toISOString() })).toEqual(facts);
  });
  it.each(['valid', 'revoked', 'fingerprint', 'unverified', 'missing', 'unknown', 'qualified', 'revoked-final-unreadable', 'revoked-origin-unreadable', 'negative-admitted-origin-unreadable'] as const)('joins actual local TLS/admission evidence without inventing negative proof: %s', async fault => {
    const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'platform-cli-')); evidenceRoots.push(root);
    const config = labConfig(root); config.liveOptIn = true;
    const declared = apiOptions().policy;
    const policy = { ...declared, beforeOrigin: config.environments[0].origin, afterOrigin: config.environments[1].origin,
      authorizedCertificate: { ...declared.authorizedCertificate, hostname: 'after.example.test' } };
    config.demonstrations = { apiShield: policy };
    let targetCalls = 0; let afterCalls = 0; let policyReads = 0;
    const edgeEvents = new Map<string, { datetime: string; rayName: string; action: string; source: string; ruleId: string; clientRequestHTTPHost: string }>();
    const dispatch = async (url: string, init: RequestInit) => {
      const target = new URL(url);
      if (target.origin === config.apiOrigin) {
        if (target.pathname.endsWith('/graphql')) {
          const query = JSON.parse(String(init.body)).query as string; const ray = /rayName: "([a-f0-9]{16})"/.exec(query)?.[1];
          const event = ray ? edgeEvents.get(ray) : null;
          return Response.json({ data: { viewer: { zones: [{ firewallEventsAdaptive: event ? [event] : [] }] } } });
        }
        if (++policyReads > 1 && fault === 'revoked-final-unreadable') return new Response('Source unavailable', { status: 403 });
        return Response.json({ success: true, result: { id: 'e'.repeat(32), version: '1', phase: 'http_request_firewall_custom', rules: [
          { id: policy.policyId, expression: apiShieldModule(policy).expression, enabled: true, action: 'block' },
        ] } });
      }
      if (target.origin === config.telemetryOrigin) {
        if (target.searchParams.get('role') === 'after' && (fault === 'revoked-origin-unreadable' && afterCalls === 3
          || fault === 'negative-admitted-origin-unreadable' && afterCalls === 1)) return new Response('Collector unavailable', { status: 403 });
        const found = entries.filter(receipt => receipt.runId === target.searchParams.get('runId') && receipt.targetRole === target.searchParams.get('role'));
        return Response.json({ schemaVersion: 1, targetRole: target.searchParams.get('role'), runId: target.searchParams.get('runId'),
          scenarioId: 'api-shield', originCount: found.filter(receipt => receipt.stage === 'entry').length, receipts: found,
          coverage: { healthy: true, complete: true, gaps: [], windowStart: target.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: found.length } });
      }
      if (target.pathname === '/internal/checkpoint') return Response.json({ healthy: true });
      expect(target.pathname).toBe('/api'); targetCalls++;
      const env = envs.find(value => value.origin === target.origin)!; const ray = targetCalls.toString(16).padStart(16, '0');
      if (env.role === 'after' && ++afterCalls < 3 && !(fault === 'negative-admitted-origin-unreadable' && afterCalls === 1)) {
        if (fault === 'qualified') edgeEvents.set(ray, { datetime: new Date().toISOString(), rayName: ray, action: 'block', source: 'firewallrules',
          ruleId: policy.policyId, clientRequestHTTPHost: target.hostname });
        return new Response('Synthetic edge control', { status: 403, headers: { 'cf-ray': `${ray}-DFW` } });
      }
      const request = new Request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), 'cf-ray': ray } });
      if (fault !== 'unknown') Object.defineProperty(request, 'cf', { value: { tlsClientAuth: {
        certPresented: fault === 'missing' ? '0' : '1', certVerified: fault === 'missing' ? 'NONE' : fault === 'unverified' ? 'FAILED' : 'SUCCESS',
        certRevoked: fault.startsWith('revoked') ? '1' : '0', certFingerprintSHA256: fault === 'missing' ? '' : fault === 'fingerprint'
          ? (policy.authorizedCertificate.fingerprint === 'e'.repeat(64) ? 'd'.repeat(64) : 'e'.repeat(64)) : policy.authorizedCertificate.fingerprint,
        certSubjectDN: 'PRIVATE-PERSON', certRFC9440: 'PRIVATE-CERT-DER',
      } } });
      const response = await createStorefrontWorker(env).fetch(request); response.headers.set('cf-ray', `${ray}-DFW`); return response;
    };
    const maskingAdapter = vi.fn(async (request: PolicyRequest) => request.case !== 'authorized' ? null : ({ product: 'mtls', policyId: policy.policyId,
      hostname: 'after.example.test', path: '/api', certificate: 'authorized', verified: true, revoked: false,
      fingerprint: policy.authorizedCertificate.fingerprint, action: 'allow', source: 'cloudflare-client-verification' }));
    const conflict = !['valid', 'unknown', 'qualified'].includes(fault);
    const result = await runDemoCli(['api-shield', '--json', '--requests', '100'], { projectRoot: root, mode: 'fixture',
      loadConfig: () => config, credentials: () => ({ reader: 'offline-platform-reader-credential', collector: 'offline-platform-collector-credential', runner: runSecret }),
      dispatch, ownership: async () => new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)), ownershipRequests: 0,
      ...(conflict ? { workshop: { policySignal: maskingAdapter } } : {}) });
    const data = JSON.parse(result.output); expect(data.kind, result.output).toBe('result');
    expect(result.exitCode).toBe(fault === 'qualified' ? 0 : 1);
    expect(data.report.result.outcome).toBe(fault === 'qualified' ? 'verified' : conflict ? 'failed' : 'inconclusive'); expect(targetCalls).toBe(4);
    expect(data.report.mode).toBe('fixture');
    if (conflict) expect(maskingAdapter.mock.calls.some(([request]) => request.case === 'authorized')).toBe(fault === 'revoked-origin-unreadable');
    if (fault.includes('unreadable')) expect(data.report.result.contradictions.length).toBeGreaterThan(0);
    const artifacts = new ReportStore(root, config.evidenceDirectory).loadArtifacts(data.report.result.runId);
    const facts = artifacts.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'tls-client-verification');
    expect(facts).toHaveLength(fault === 'unknown' ? 0 : fault === 'negative-admitted-origin-unreadable' ? 2 : 1);
    if (fault === 'valid') expect(facts[0]!.payload).toMatchObject({ certificateVerified: true, fingerprintSha256: policy.authorizedCertificate.fingerprint });
    const signals = artifacts.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'verification'
      && artifact.payload.policySignal?.product === 'mtls' && artifact.payload.policySignal.source === 'cloudflare-client-verification');
    expect(signals).toHaveLength(fault === 'unknown' ? 0 : 1);
    expect(JSON.stringify(artifacts)).not.toMatch(/PRIVATE-PERSON|PRIVATE-CERT-DER/);
    expect(data.report.result.missingProof.some((text: string) => text.includes('product attribution'))).toBe(fault !== 'qualified');
    if (fault === 'qualified') {
      const blocked = artifacts.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'verification'
        && artifact.payload.policySignal?.product === 'mtls' && artifact.payload.policySignal.source === 'cloudflare-mtls-rule-event');
      expect(blocked).toHaveLength(2);
      for (const artifact of blocked) expect(artifact.payload).toMatchObject({ policySignal: { certificate: 'unknown', verified: null, revoked: null, fingerprint: null, action: 'block' } });
    }
  });
  it('does not trust forged TLS headers or missing platform metadata', async () => {
    const env = envs.find(value => value.role === 'after')!;
    const response = await createStorefrontWorker(env).request(`${env.origin}/api`, { headers: {
      'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'api-shield', 'x-demo-run-token': runSecret,
      'cf-cert-verified': 'SUCCESS', 'cf-client-cert-sha256': 'b'.repeat(64), 'x-tls-client-auth': 'verified',
    } });
    expect(response.status).toBe(200); expect((await response.json() as any).tlsClientVerification).toBeNull();
  });
  it('keeps platform certificate facts out of baseline, public and unrelated scenario responses', async () => {
    for (const kind of ['before', 'public', 'scenario', 'missing-run', 'missing-request'] as const) {
      const env = envs.find(value => value.role === (kind === 'before' ? 'before' : 'after'))!;
      const headers = new Headers(kind === 'public' ? {} : { 'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(),
        'x-demo-scenario': kind === 'scenario' ? 'analytics' : 'api-shield', 'x-demo-run-token': runSecret });
      if (kind === 'missing-run') headers.delete('x-demo-run-id');
      if (kind === 'missing-request') headers.delete('x-demo-request-id');
      const request = new Request(`${env.origin}/api`, { headers });
      Object.defineProperty(request, 'cf', { value: { tlsClientAuth: { certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0', certFingerprintSHA256: 'b'.repeat(64) } } });
      const response = await createStorefrontWorker(env).fetch(request); expect(response.status).toBe(200);
      expect(await response.json()).not.toHaveProperty('tlsClientVerification');
    }
  });
  it('requires lab authorization and the exact deployment hostname before TLS disclosure', async () => {
    const env = envs.find(value => value.role === 'after')!; const app = createStorefrontWorker(env); const before = entries.length;
    const headers = { 'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'api-shield' };
    const unauthorized = await app.request(`${env.origin}/api`, { headers }); expect(unauthorized.status).toBe(401);
    const wrong = await app.request('https://foreign.example.test/api', { headers: { ...headers, 'x-demo-run-token': runSecret } }); expect(wrong.status).toBe(421);
    expect(await unauthorized.json()).not.toHaveProperty('tlsClientVerification'); expect(await wrong.json()).not.toHaveProperty('tlsClientVerification');
    expect(entries).toHaveLength(before);
  });
  it('returns unknown instead of guessing malformed platform verification', async () => {
    const env = envs.find(value => value.role === 'after')!;
    const request = new Request(`${env.origin}/api`, { headers: { 'x-demo-run-id': randomUUID(), 'x-demo-request-id': randomUUID(),
      'x-demo-scenario': 'api-shield', 'x-demo-run-token': runSecret } });
    Object.defineProperty(request, 'cf', { value: { tlsClientAuth: { certPresented: '1', certVerified: 'SUCCESS', certRevoked: '0', certFingerprintSHA256: 'b'.repeat(128) } } });
    const response = await createStorefrontWorker(env).fetch(request); expect(response.status).toBe(200);
    expect((await response.json() as any).tlsClientVerification).toBeNull();
  });
  it('uses real local D1/R2 and delegates both equivalent storefronts to scoped Container applications', async () => {
    const run = randomUUID(); const bodies: string[] = [];
    for (const env of envs) {
      const requestId = randomUUID();
      const response = await createStorefrontWorker(env).request(`${env.origin}/catalog`, { headers: { 'x-demo-run-id': run, 'x-demo-request-id': requestId, 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': runSecret, 'x-lab-role': 'forged' } });
      expect(response.status).toBe(200); expect(response.headers.get('x-lab-role')).toBe(env.role);
      expect(response.headers.get('x-lab-services')).toContain('images-reference');
      const text = await response.text(); bodies.push(text); expect(text).toContain('imagedelivery.net');
      expect(entries.some(r => r.stage === 'entry' && r.requestId === requestId && r.targetRole === env.role)).toBe(true);
      expect(instanceKeys).toContain(`${env.role}:waf-custom:${run}`);
    }
    const normalizeView = (html: string, label: string) => {
      expect(html.split(label)).toHaveLength(4);
      const visible = [`<p class="role-badge">${label}</p>`, `<p class="eyebrow" data-demo-public>Synthetic shopper · ${label}</p>`, `<dd>${label}</dd>`];
      for (const fragment of visible) { expect(html.split(fragment)).toHaveLength(2); html = html.replace(fragment, fragment.replace(label, 'Workshop view')); }
      return html;
    };
    expect(normalizeView(bodies[0]!, 'Before baseline')).toBe(normalizeView(bodies[1]!, 'After custom WAF lab'));
  });
  it('joins real local D1/R2/Container reads with the guarded service collector', async () => {
    const config = labConfig(); config.liveOptIn = true;
    for (const original of envs) {
      const target = config.environments.find(e => e.role === original.role)!;
      const env = { ...original, serviceResources: { d1: target.d1Id, r2: target.r2Bucket, container: target.containerBinding } };
      const app = createStorefrontWorker(env); const runId = randomUUID(); const start = new Date(Date.now() - 1000).toISOString();
      const ledger = new BudgetLedger({ limits: { cleanupRequests: 0 } });
      const scope = { role: env.role, hostname: new URL(env.origin).hostname, runId, scenarioId: 'waf-custom' as const, requestId: randomUUID(), releaseDigest: env.releaseDigest, start, end: new Date().toISOString() };
      let fault = '';
      const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), credentials: { reader: 'offline-read-service-credential', collector: 'offline-collector-service-credential', runner: runSecret }, dispatch: async (url, init) => {
        const u = new URL(url);
        if (u.origin === config.telemetryOrigin) {
          const receipts = entries.filter(r => r.runId === runId && r.targetRole === env.role);
          return Response.json({ schemaVersion: 1, targetRole: env.role, runId, scenarioId: scope.scenarioId, originCount: receipts.filter(r => r.stage === 'entry').length, receipts, coverage: { healthy: true, complete: true, gaps: [], windowStart: start, watermark: new Date().toISOString(), producerSequence: receipts.length } });
        }
        if (u.pathname === '/internal/checkpoint') return Response.json({ checkpoint: true });
        const response = await app.request(url, init);
        if (!fault) return response;
        const receipt = ServiceReadReceiptSchema.parse(await response.json());
        if (fault === 'run') receipt.runId = randomUUID();
        if (fault === 'request') receipt.requestId = randomUUID();
        if (fault === 'release') receipt.releaseDigest = 'f'.repeat(64);
        if (fault === 'role') receipt.targetRole = env.role === 'after' ? 'before' : 'after';
        if (fault === 'resource') receipt.operations[0]!.resourceId = 'foreign-db';
        if (fault === 'incomplete') receipt.operations.pop();
        return Response.json(receipt, { headers: response.headers });
      } });
      try {
        const read = await collector.serviceRead(scope);
        expect(read.state).toBe('observed'); expect(read.value?.operations).toHaveLength(3);
        expect(read.value?.serviceStates).toEqual({ d1: 'observed', r2: 'observed', container: 'observed', images: 'unknown' });
        expect(read.value?.container?.requestCompleted).toBe(true); expect(ledger.snapshot.requestsUsed).toBe(3);
        for (const kind of ['run', 'request', 'release', 'role', 'resource', 'incomplete']) {
          fault = kind;
          const bad = await collector.serviceRead({ ...scope, requestId: randomUUID(), end: new Date().toISOString() });
          expect(bad.state).not.toBe('observed'); expect(bad.value).toBeNull();
        }
        const before = entries.length;
        expect((await app.request(`${env.origin}/internal/service-read`)).status).toBe(400);
        expect((await app.request(`${env.origin}/internal/service-read`, { headers: { 'x-demo-run-id': runId, 'x-demo-scenario': scope.scenarioId, 'x-demo-request-id': randomUUID() } })).status).toBe(401);
        expect(entries).toHaveLength(before);
      } finally { ledger.stop(); }
    }
  });
  it.each(['d1', 'r2'] as const)('joins explicit %s write/read/cleanup to actual local bindings and Container receipts', async service => {
    const config = labConfig(); config.liveOptIn = true;
    for (const original of envs) {
      const target = config.environments.find(env => env.role === original.role)!;
      const env = { ...original, serviceResources: { d1: target.d1Id, r2: target.r2Bucket, container: target.containerBinding } };
      const app = createStorefrontWorker(env); const ledger = new BudgetLedger(); const runId = randomUUID(); const requestId = randomUUID();
      const start = new Date(Date.now() - 1000).toISOString(); let posts = 0; let fault = '';
      const collector = createTrustedCollectors({ config, ledger, mode: 'fixture', observedOwnedResources: new Set(config.inventory.map(item => `${item.type}:${item.role}:${item.id}`)),
        credentials: { reader: 'offline-d1-probe-reader-credential', collector: 'offline-d1-probe-collector-credential', runner: runSecret }, dispatch: async (url, init) => {
          const u = new URL(url);
          if (u.origin === config.telemetryOrigin) {
            if (fault === 'origin') return new Response('Unavailable', { status: 503 });
            if (fault === 'telemetry-denied') return new Response('Private denied body', { status: 403 });
            const receipts = entries.filter(row => row.runId === runId && row.targetRole === env.role);
            return Response.json({ schemaVersion: 1, targetRole: env.role, runId, scenarioId: 'waf-custom', originCount: receipts.filter(row => row.stage === 'entry').length,
              receipts, coverage: { healthy: true, complete: true, gaps: [], windowStart: start, watermark: new Date().toISOString(), producerSequence: receipts.length } });
          }
          if (u.pathname === '/internal/checkpoint') return fault === 'checkpoint-denied' ? new Response('Private denied body', { status: 403 }) : Response.json({ healthy: true });
          expect(u.pathname).toBe(`/internal/${service}-write-read`); expect(init.method).toBe('POST'); posts++;
          if (fault === 'denied') return new Response('Private denied body', { status: 403 });
          const response = await app.request(url, init);
          if (!fault || fault === 'origin') return response;
          const body = await response.json() as Record<string, unknown>;
          if (fault === 'run') body.runId = randomUUID();
          if (fault === 'resource') body.resourceId = 'foreign-database';
          if (fault === 'digest') body.contentDigest = 'f'.repeat(64);
          if (fault === 'cleanup') body.cleanup = 'unknown';
          return Response.json(body, { status: fault === 'cleanup' ? 503 : response.status, headers: response.headers });
        } });
      try {
        const scope = { role: env.role, hostname: new URL(env.origin).hostname, runId, requestId, scenarioId: 'waf-custom' as const, releaseDigest: env.releaseDigest, start, end: new Date().toISOString() };
        const probe = service === 'd1' ? collector.d1WriteRead.bind(collector) : collector.r2WriteRead.bind(collector);
        expect((await probe(scope)).state).toBe('unsupported'); expect(posts).toBe(0);
        const result = await probe(scope, true);
        expect(result.state).toBe('observed'); expect(result.value).toMatchObject({ writeReadConfirmed: true, cleanupConfirmed: true, isolation: 'unknown' });
        expect(result.value?.receipt).toMatchObject({ write: 'observed', read: 'observed', cleanup: 'observed', resourceId: service === 'd1' ? target.d1Id : target.r2Bucket });
        expect(posts).toBe(1); expect(ledger.snapshot.requestsUsed).toBe(3);
        for (const kind of ['run', 'resource', 'digest', 'cleanup', 'origin', 'denied', 'checkpoint-denied', 'telemetry-denied']) {
          fault = kind;
          const bad = await probe({ ...scope, requestId: randomUUID(), end: new Date().toISOString() }, true);
          expect(bad.state).toBe(['run', 'resource', 'digest'].includes(kind) ? 'mismatch' : 'unknown');
          if (kind.includes('denied')) { expect(bad.permission).toBe('denied'); expect(bad.gaps.join()).toContain('denied'); }
          if (kind === 'cleanup') expect(bad.value, JSON.stringify({ service, role: env.role, state: bad.state, gaps: bad.gaps,
            receipt: bad.value?.receipt, container: bad.value?.container })).toMatchObject({ writeReadConfirmed: true, cleanupConfirmed: false, isolation: 'unknown' });
        }
        expect(posts).toBe(9); fault = '';
        if (service === 'd1') {
          const rows = await env.db.prepare('SELECT probe_id FROM verification_probes WHERE run_id=? AND request_id=?').bind(runId, requestId).all(); expect(rows.results).toHaveLength(0);
        } else expect((await env.bucket.list({ prefix: `verification/${env.role}/waf-custom/${runId}/`, limit: 100 })).objects).toHaveLength(0);
        expect((await new StorefrontData(env.db, env.role).product('launch-shirt'))?.content_digest).toBe(CATALOG_SEED.content_digest);
        const count = entries.length;
        for (const input of [
          { token: '', scenario: 'waf-custom', body: { action: `${service}-write-read` } },
          { token: runSecret, scenario: 'turnstile', body: { action: `${service}-write-read` } },
          { token: runSecret, scenario: 'waf-custom', body: { action: `${service}-write-read`, sql: 'DELETE FROM catalog' } },
        ]) {
          const response = await app.request(`${env.origin}/internal/${service}-write-read`, { method: 'POST', headers: { 'content-type': 'application/json',
            'x-demo-run-token': input.token, 'x-demo-run-id': runId, 'x-demo-request-id': randomUUID(), 'x-demo-scenario': input.scenario }, body: JSON.stringify(input.body) });
          expect(response.status).toBe(input.token ? 400 : 401);
        }
        expect(entries).toHaveLength(count);
      } finally { ledger.stop(); }
    }
  });
  it.each(['none', 'code-drift', 'binding-drift', 'denied'] as const)('uses actual partial default fingerprints without inventing deployment: %s', async fault => {
    const config = labConfig(); config.liveOptIn = true;
    const apps = envs.map(original => { const env = config.environments.find(e => e.role === original.role)!; return createStorefrontWorker({ ...original, serviceResources: { d1: env.d1Id, r2: env.r2Bucket, container: env.containerBinding } }); });
    let calls = 0; const paths: string[] = []; const codeCalls = new Map<string, number>(); const settingsCalls = new Map<string, number>();
    const result = await collectDeploymentVerification({ projectRoot: process.cwd(), config, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), expected: deploymentFixture().state, mode: 'fixture', credentials: { runner: runSecret, collector: 'offline-default-collector-credential', reader: 'offline-default-reader-credential' }, plannedRequests: 22, dispatch: async (url, init) => {
      calls++; const u = new URL(url); paths.push(u.pathname);
      if (u.origin === config.apiOrigin) {
        const env = config.environments.find(e => u.pathname.includes(`/scripts/${e.workerName}/`));
        if (!env) throw new Error('Unplanned provider read');
        if (u.pathname.endsWith('/content/v2')) {
          const count = (codeCalls.get(env.role) ?? 0) + 1; codeCalls.set(env.role, count);
          if (fault === 'denied' && env.role === 'after' && count === 2) return new Response('Private denied', { status: 403 });
          const change = fault === 'code-drift' && env.role === 'after' && count === 2 ? '// changed actual code' : '';
          return new Response(`export default { fetch() { return new Response("CODE_PRIVATE_CANARY"); } }${change}`, { headers: { 'content-type': 'application/javascript' } });
        }
        const count = (settingsCalls.get(env.role) ?? 0) + 1; settingsCalls.set(env.role, count);
        const database = fault === 'binding-drift' && env.role === 'after' && count === 3 ? 'foreign-database' : env.d1Id;
        return Response.json({ success: true, result: { bindings: [{ name: 'DB', type: 'd1', database_id: database }, { name: 'OBJECTS', type: 'r2_bucket', bucket_name: env.r2Bucket }] } });
      }
      if (u.origin === config.telemetryOrigin) {
        const receipts = entries.filter(r => r.runId === u.searchParams.get('runId') && r.targetRole === u.searchParams.get('role'));
        return Response.json({ schemaVersion: 1, targetRole: u.searchParams.get('role'), runId: u.searchParams.get('runId'), scenarioId: u.searchParams.get('scenarioId'), originCount: receipts.filter(r => r.stage === 'entry').length, receipts, coverage: { healthy: true, complete: true, gaps: [], windowStart: u.searchParams.get('start'), watermark: new Date().toISOString(), producerSequence: receipts.length } });
      }
      const index = config.environments.findIndex(e => e.origin === u.origin); if (index < 0) throw new Error('Foreign dispatch');
      if (u.pathname === '/internal/checkpoint') return Response.json({ checkpoint: true });
      return apps[index]!.request(url, init);
    } });
    expect(result.deploymentVerified).toBe(false); expect(result.beforeFingerprint).toBeNull(); expect(result.afterFingerprint).toBeNull();
    expect(result.probes).toHaveLength(2); expect(result.artifacts).toHaveLength(fault === 'denied' ? 13 : 14);
    const partials = result.artifacts!.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'worker-readback'); expect(partials).toHaveLength(4);
    expect(result.checks.find(check => check.id === 'after-worker-code-unchanged')?.passed).toBe(!['code-drift', 'denied'].includes(fault));
    expect(result.checks.find(check => check.id === 'after-worker-bindings-unchanged')?.passed).toBe(fault !== 'binding-drift');
    if (fault !== 'none') expect(result.blockers).toContain(fault === 'binding-drift' ? 'after-worker-bindings-unchanged' : 'after-worker-code-unchanged');
    const code = result.artifacts!.filter(artifact => 'kind' in artifact.payload && artifact.payload.kind === 'worker-code-fingerprint');
    expect(code).toHaveLength(fault === 'denied' ? 3 : 4); expect(JSON.stringify(result)).not.toContain('CODE_PRIVATE_CANARY'); expect(result.requestsUsed).toBe(calls); expect(calls).toBe(20);
    expect(paths.filter(path => path.endsWith('/content/v2'))).toHaveLength(4);
    expect(paths.filter(path => path.endsWith('/settings'))).toHaveLength(6);
    expect(paths.filter(path => path === '/internal/service-read')).toHaveLength(2);
    expect(paths.filter(path => path === '/internal/checkpoint')).toHaveLength(4);
    expect(paths.filter(path => path === '/receipts')).toHaveLength(4);
    for (const probe of result.probes) {
      expect(probe.operations).toHaveLength(3);
      expect(probe.operations.some(op => op.operation === 'isolation' || op.operation === 'write-read' || op.service === 'images')).toBe(false);
      for (const operation of probe.operations) {
        const artifact = result.artifacts!.find(a => a.id === operation.evidence.id)!;
        expect(makeArtifact(artifact).ref).toEqual(operation.evidence);
      }
    }
  });
  it('does not count worker-only health as Container arrival or permit forged correlation', async () => {
    const env = envs[0]!; const app = createStorefrontWorker(env); const count = entries.length;
    expect((await app.request(`${env.origin}/health`)).status).toBe(200); expect(entries).toHaveLength(count);
    expect((await app.request('https://after.example.test/catalog')).status).toBe(421);
    expect((await app.request(`${env.origin}/catalog`, { headers: { 'x-demo-run-id': randomUUID() } })).status).toBe(401);
    expect(entries).toHaveLength(count);
  });
  it('stores only validated baseline synthetic registrations and fails protected verification closed', async () => {
    const run = randomUUID(); const id = randomUUID();
    for (const env of envs) {
      const response = await createStorefrontWorker(env).request(`${env.origin}/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-run-id': run, 'x-demo-scenario': 'turnstile', 'x-demo-run-token': runSecret }, body: JSON.stringify({ record_id: id, display_name: 'synthetic-person', note: '<script>inert</script>', turnstileToken: null }) });
      expect(response.status).toBe(env.role === 'before' ? 201 : 503);
      const row = await new StorefrontData(env.db, env.role).scope('turnstile', run).get(id);
      expect(row !== null).toBe(env.role === 'before');
    }
  });
  it('rejects foreign image resource identity and never renders test signatures as executable HTML', async () => {
    const env = envs[0]!;
    expect(() => createStorefrontWorker({ ...env, image: { ...env.image, role: 'after' } })).toThrow('Foreign');
    const response = await createStorefrontWorker(env).request(`${env.origin}/catalog?signature=${encodeURIComponent('<script>inert</script>')}`);
    const text = await response.text(); expect(text).toContain('&lt;script&gt;'); expect(text).not.toContain('<script>');
  });
});
