import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
import { discoverCapabilities, capabilityDigest } from '../packages/demo-core/src/capabilities.js';
import { createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { defaultOptionalProvider, OptionalSelectionsSchema } from '../packages/demo-core/src/optional-product-integration.js';
import { planOptionalProductSetup, type OptionalProductSelection } from '../packages/demo-core/src/optional-product-setup.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });
const NOW = Date.parse('2026-11-04T10:00:00.000Z'); const CERTIFICATE = 'c'.repeat(32); const FINGERPRINT = 'f'.repeat(64);
async function fixture() {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'managed-certificate-')); roots.push(root);
  const intent = deploymentIntent(root, NOW); intent.profile = 'workshop';
  const capability = await discoverCapabilities(intent.discovery, 'workshop', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture-only', reasons: [] }) }, undefined, new Date(NOW).toISOString());
  const plan = createDeploymentPlan(intent, capability, 'b'.repeat(64), root, NOW, ['core', ...capability.includedModules]);
  expect(plan.blockers).toEqual([]);
  // Exercise the read-only live protocol with synthetic inputs, not an actual
  // approvable live plan. No frozen source, apply, approval or executor is used.
  plan.mode = 'live'; plan.capability.mode = 'live'; plan.capabilityDigest = capabilityDigest(plan.capability);
  const before = new URL(intent.discovery.environments[0].origin).hostname; const after = new URL(intent.discovery.environments[1].origin).hostname;
  const selection: Extract<OptionalProductSelection, { module: 'api-shield' }> = { module: 'api-shield', certificateId: CERTIFICATE,
    certificateSource: 'zone-managed', certificateRef: 'certificate:lab-api', fingerprint: FINGERPRINT };
  const certificate: Record<string, unknown> = { id: CERTIFICATE, status: 'active', issued_on: new Date(NOW - 60000).toISOString(),
    expires_on: new Date(NOW + 86400000).toISOString(), fingerprint_sha256: FINGERPRINT,
    certificate: 'PUBLIC-CERT-NOT-EXPORTED', csr: 'PUBLIC-CSR-NOT-EXPORTED', common_name: 'private-person@example.invalid', private_key: 'PRIVATE-KEY-NOT-EXPORTED' };
  const state = { certificate, hostnames: [after, 'unrelated.example.test'], zoneAccount: intent.discovery.accountId, zoneId: intent.discovery.zoneId,
    associationPage: undefined as { page: number; total_pages: number } | undefined, httpStatus: 200, redirect: false, expireAtAssociation: false };
  const calls: { url: string; init: RequestInit }[] = [];
  const dispatch = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init }); expect(init.method).toBe('GET');
    const path = new URL(url).pathname;
    if (path === `/client/v4/zones/${intent.discovery.zoneId}`) return Response.json({ success: true, result: { id: state.zoneId, account: { id: state.zoneAccount }, name: 'example.test' } });
    if (path === `/client/v4/zones/${intent.discovery.zoneId}/client_certificates/${CERTIFICATE}`) {
      if (state.redirect) return new Response(null, { status: 302, headers: { location: 'https://other.invalid/private' } });
      if (state.httpStatus !== 200) return new Response('PRIVATE-ERROR-CANARY', { status: state.httpStatus });
      return Response.json({ success: true, result: state.certificate });
    }
    if (path === `/client/v4/zones/${intent.discovery.zoneId}/certificate_authorities/hostname_associations`) {
      if (state.expireAtAssociation) clock.mockReturnValue(NOW + 86400001);
      return Response.json({ success: true, result: { hostnames: state.hostnames }, ...(state.associationPage ? { result_info: state.associationPage } : {}) });
    }
    if (path.endsWith('/rulesets/phases/http_request_firewall_custom/entrypoint')) return Response.json({ success: true, result: { id: 'e'.repeat(32), rules: [] } });
    throw new Error('Unplanned certificate boundary');
  });
  const provider = defaultOptionalProvider(plan, FIXTURE_CREDENTIALS, dispatch);
  const inspect = (signal = new AbortController().signal) => provider.inspect(plan, selection, signal);
  return { root, plan, before, after, selection, state, calls, dispatch, provider, inspect };
}
describe('default managed API Shield certificate prerequisites, offline transport only', () => {
  it('joins real zone-client and managed-CA hostname contracts using reader-only GETs', async () => {
    const f = await fixture(); const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests forbidden'));
    const state = await f.inspect();
    expect(state.certificate).toEqual({ id: CERTIFICATE, fingerprint: FINGERPRINT, hostname: f.after, ready: true });
    expect(state.resources).toEqual([]); expect(f.calls).toHaveLength(4);
    expect(f.calls.map(call => new URL(call.url).pathname)).toEqual([
      `/client/v4/zones/${f.plan.intent.discovery.zoneId}`,
      `/client/v4/zones/${f.plan.intent.discovery.zoneId}/client_certificates/${CERTIFICATE}`,
      `/client/v4/zones/${f.plan.intent.discovery.zoneId}/certificate_authorities/hostname_associations`,
      `/client/v4/zones/${f.plan.intent.discovery.zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`,
    ]);
    for (const call of f.calls) {
      expect(call.init.method).toBe('GET'); expect(call.init.redirect).toBe('error');
      expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${FIXTURE_CREDENTIALS.reader}`);
      expect(new URL(call.url).searchParams.has('mtls_certificate_id')).toBe(false);
      expect(call.url).not.toContain('/accounts/');
    }
    expect(JSON.stringify(state)).not.toMatch(/PRIVATE|PUBLIC-CERT|PUBLIC-CSR|private-person|unrelated/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows the actual read-only planning extension without creating a certificate or rule', async () => {
    const f = await fixture();
    const selections = OptionalSelectionsSchema.parse([f.selection]);
    const setup = await planOptionalProductSetup(f.plan, selections, f.provider, {}, new AbortController().signal, NOW);
    expect(setup.operations[0]?.selection).toMatchObject({ certificateSource: 'zone-managed', certificateId: CERTIFICATE });
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('normalizes documented SHA-256 spellings without taking the fingerprint from the selection', async () => {
    const f = await fixture(); f.state.certificate.fingerprint_sha256 = Array(32).fill('FF').join(':');
    expect((await f.inspect()).certificate?.fingerprint).toBe(FINGERPRINT);
    f.state.certificate.fingerprint_sha256 = '0'.repeat(64);
    await expect(f.inspect()).rejects.toThrow('fingerprint');
  });
  it('requires an explicit managed source instead of confusing a client ID with an uploaded CA ID', async () => {
    const f = await fixture(); delete f.selection.certificateSource;
    await expect(f.inspect()).rejects.toThrow('Explicit zone-managed');
    expect(f.calls).toHaveLength(1);
    expect(OptionalSelectionsSchema.safeParse([{ ...f.selection, certificateSource: 'account-ca' }]).success).toBe(false);
  });
  it.each(['id', 'fingerprint', 'revoked', 'pending', 'expired', 'future', 'missing', 'name-only'] as const)('rejects %s certificate facts before any write', async fault => {
    const f = await fixture();
    if (fault === 'id') f.state.certificate.id = '0'.repeat(32);
    if (fault === 'fingerprint') f.state.certificate.fingerprint_sha256 = '0'.repeat(64);
    if (fault === 'revoked') f.state.certificate.status = 'revoked';
    if (fault === 'pending') f.state.certificate.status = 'pending_revocation';
    if (fault === 'expired') f.state.certificate.expires_on = new Date(NOW).toISOString();
    if (fault === 'future') f.state.certificate.issued_on = new Date(NOW + 1).toISOString();
    if (fault === 'missing') delete f.state.certificate.fingerprint_sha256;
    if (fault === 'name-only') f.state.certificate = { id: CERTIFICATE, name: 'certificate:lab-api', status: 'active' };
    await expect(f.inspect()).rejects.toThrow(); expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each(['absent', 'before', 'duplicate', 'wildcard', 'cap', 'paged'] as const)('rejects %s hostname association without updating it', async fault => {
    const f = await fixture();
    if (fault === 'absent') f.state.hostnames = ['unrelated.example.test'];
    if (fault === 'before') f.state.hostnames.push(f.before);
    if (fault === 'duplicate') f.state.hostnames.push(f.after);
    if (fault === 'wildcard') f.state.hostnames.push('*.example.test');
    if (fault === 'cap') f.state.hostnames = [f.after, ...Array.from({ length: 99 }, (_, index) => `other-${index}.example.test`)];
    if (fault === 'paged') f.state.associationPage = { page: 1, total_pages: 2 };
    await expect(f.inspect()).rejects.toThrow(); expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it.each(['account', 'zone'] as const)('rejects foreign %s ownership before reading certificate details', async fault => {
    const f = await fixture();
    if (fault === 'account') f.state.zoneAccount = '0'.repeat(32); else f.state.zoneId = '0'.repeat(32);
    await expect(f.inspect()).rejects.toThrow('scope'); expect(f.calls).toHaveLength(1);
  });
  it.each([401, 403, 404])('fails a %i certificate read closed without writes or entitlement guesses', async status => {
    const f = await fixture(); f.state.httpStatus = status;
    await expect(f.inspect()).rejects.toThrow('unavailable'); expect(f.calls).toHaveLength(2);
    expect(f.calls.every(call => call.init.method === 'GET')).toBe(true);
  });
  it('does not follow a redirect, reuse an expired read, or dispatch after cancellation', async () => {
    const f = await fixture(); f.state.redirect = true;
    await expect(f.inspect()).rejects.toThrow('unavailable'); expect(f.calls).toHaveLength(2);
    f.state.redirect = false; f.state.expireAtAssociation = true;
    await expect(f.inspect()).rejects.toThrow('expired');
    const stopped = await fixture(); const controller = new AbortController(); controller.abort();
    await expect(stopped.inspect(controller.signal)).rejects.toThrow(); expect(stopped.calls).toHaveLength(0);
  });
});
