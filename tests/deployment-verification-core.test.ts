import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { collectDeploymentVerification, evaluateDeployment, deploymentFingerprint, type DeploymentProbeOptions } from '../packages/demo-core/src/deployment-verification-core.js';
import { labConfig } from './fixtures/lab.js';
import { deploymentFixture, captureFor, time, end, digest } from './workshop-core-fixtures.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function evaluate(f = deploymentFixture(), mode: 'live' | 'fixture' = 'fixture') {
  return evaluateDeployment({ mode, expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, observedAt: end, startedAt: time, beforeObservedAt: time, afterObservedAt: end });
}
function collection() {
  const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH!, 'deployment-core-')); roots.push(root);
  const f = deploymentFixture(); f.config = labConfig(root); f.config.liveOptIn = true;
  const receipts = new Map<string, { runId: string; requestId: string }>(); const calls: string[] = [];
  const options: DeploymentProbeOptions = { projectRoot: root, config: f.config, mode: 'fixture', expected: f.state,
    credentials: { runner: 'fixture-runner-credential-at-least-24', collector: 'fixture-collector-credential-at-least-24' },
    observedOwnedResources: new Set(f.config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), plannedRequests: 8,
    now: () => Date.parse(time), inspect: async (client, signal) => {
      const response = await client.request({ kind: 'cloudflare', url: `${f.config.apiOrigin}/client/v4/accounts/${f.config.accountId}`, headers: { authorization: 'Bearer fixture-reader-at-least-24-characters' } }, signal);
      if (response.status !== 200) throw new Error('Unreadable'); return { state: f.state, observedAt: time };
    }, dispatch: async (url, init) => {
      calls.push(url); const u = new URL(url); const env = f.config.environments.find(e => e.origin === u.origin);
      if (u.origin === f.config.apiOrigin) return Response.json({ id: f.config.accountId });
      if (env && u.pathname === '/catalog') {
        const headers = new Headers(init.headers); receipts.set(env.role, { runId: headers.get('x-demo-run-id')!, requestId: headers.get('x-demo-request-id')! });
        return new Response('Synthetic shop', { headers: { 'x-lab-role': env.role, 'x-lab-release': env.releaseDigest } });
      }
      if (env && u.pathname === '/internal/checkpoint') return Response.json({ healthy: true });
      if (u.origin === f.config.telemetryOrigin) {
        const role = u.searchParams.get('role')!; const r = receipts.get(role)!; const e = f.config.environments.find(e => e.role === role)!;
        return Response.json({ schemaVersion: 1, targetRole: role, runId: r.runId, scenarioId: 'waf-custom', originCount: 1, receipts: [{ schemaVersion: 1, id: crypto.randomUUID(), ...r, scenarioId: 'waf-custom', targetRole: role, producerId: `${role}-container`, sequence: 1, observedAt: time, rayId: null, releaseDigest: e.releaseDigest, stage: 'entry' }], coverage: { healthy: true, complete: true, windowStart: time, watermark: time, producerSequence: 1, gaps: [] } });
      }
      throw new Error('Unexpected fixture request');
    } };
  return { f, options, calls };
}
describe('deployment-verification core', () => {
  it('requires real operations, image decode and receipts beyond Worker health', () => {
    const f = deploymentFixture(); expect(evaluate(f).checks.every(c => c.passed)).toBe(true); expect(evaluate(f).deploymentVerified).toBe(false);
    for (const p of f.probes) p.operations = [];
    expect(evaluate(f).blockers).toContain('before-images-decode'); expect(evaluate(f).blockers).toContain('after-d1-write-read');
  });
  it('normalizes fingerprints without using secret fields or input order', () => {
    const f = deploymentFixture(); const other = structuredClone(f.state); other.bindings.before.images.reverse();
    expect(deploymentFingerprint(other)).toBe(deploymentFingerprint(f.state));
    expect(() => deploymentFingerprint({ ...f.state, token: 'private' } as never)).toThrow();
    other.containerDigest = 'f'.repeat(64); expect(deploymentFingerprint(other)).not.toBe(deploymentFingerprint(f.state));
  });
  it.each(['d1', 'r2', 'container'] as const)('blocks a missing %s binding', service => {
    const f = deploymentFixture(); f.state.bindings.after[service] = null;
    expect(evaluate(f).blockers).toContain('after-bindings');
  });
  it.each(['tls', 'role', 'release', 'receipt', 'worker-only', 'image', 'isolation', 'coverage', 'future', 'content'] as const)('blocks %s faults', fault => {
    const f = deploymentFixture(); const p = f.probes[1]!;
    if (fault === 'tls') p.tlsValid = false;
    if (fault === 'role') p.hostname = 'before.example.test';
    if (fault === 'release') p.releaseDigest = 'f'.repeat(64);
    if (fault === 'receipt' || fault === 'worker-only') p.receipts = [];
    if (fault === 'image') p.operations.find(o => o.service === 'images')!.success = false;
    if (fault === 'isolation') p.operations = p.operations.filter(o => o.operation !== 'isolation');
    if (fault === 'coverage') p.coverage.healthy = false;
    if (fault === 'future') p.finishedAt = '2026-11-05T00:00:00.000Z';
    if (fault === 'content') p.operations.find(o => o.service === 'd1' && o.operation === 'read')!.contentDigest = 'f'.repeat(64);
    expect(evaluate(f).blockers.length).toBeGreaterThan(0);
  });
  it('checks enabled policy scope, priority, behavior and read permissions', () => {
    const f = deploymentFixture(); const c = captureFor('waf-custom');
    f.state.policies.push({ scenarioId: 'waf-custom', id: 'custom-rule', hostname: 'after.example.test', path: '/catalog', action: 'block', enabled: true, priority: 1, baselineExcluded: true, functionalDigest: digest });
    f.state.evidencePermissions.push('waf-custom');
    const input = { mode: 'fixture' as const, expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: end, policyCaptures: [c] };
    expect(evaluateDeployment(input).blockers).toEqual([]);
    const wrong = structuredClone(f.state); wrong.policies[0]!.priority = 2;
    expect(evaluateDeployment({ ...input, after: wrong }).blockers).toContain('matching-functional-state');
    expect(evaluateDeployment({ ...input, policyCaptures: [] }).blockers).toContain('waf-custom-behavior');
    f.state.policies[0]!.hostname = 'before.example.test'; expect(evaluateDeployment(input).blockers).toContain('waf-custom-scope');
    f.state.policies[0]!.hostname = 'after.example.test'; f.state.evidencePermissions = []; expect(evaluateDeployment(input).blockers).toContain('waf-custom-scope');
  });
  it('marks drift and unreadable state historical with no repair executor', () => {
    const f = deploymentFixture();
    const r = evaluateDeployment({ mode: 'fixture', expected: f.state, before: f.state, after: null, config: f.config, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: time, afterObservedAt: null });
    expect(r.historical).toBe(true); expect(r.deploymentVerified).toBe(false);
    const stale = evaluateDeployment({ mode: 'fixture', expected: f.state, before: f.state, after: f.state, config: f.config, probes: f.probes, startedAt: time, observedAt: end, beforeObservedAt: '2026-11-03T00:00:00.000Z', afterObservedAt: end });
    expect(stale.blockers).toContain('fresh-readback-times'); expect(stale.historical).toBe(true);
  });
  it.each(['late-before', 'overlap-before', 'early-after', 'overlap-after', 'inverted'] as const)('rejects full-state %s wrappers that do not bracket the probe window', fault => {
    const f = deploymentFixture(); const middle = '2026-11-04T00:00:30.000Z';
    const beforeObservedAt = fault === 'late-before' || fault === 'inverted' ? end : fault === 'overlap-before' ? middle : time;
    const afterObservedAt = fault === 'early-after' || fault === 'inverted' ? time : fault === 'overlap-after' ? middle : end;
    const result = evaluateDeployment({ mode: 'fixture', config: f.config, expected: f.state, before: f.state, after: f.state, probes: f.probes,
      startedAt: time, observedAt: end, beforeObservedAt, afterObservedAt });
    expect(result.deploymentVerified).toBe(false); expect(result.historical).toBe(true);
    expect(result.blockers).toContain('readback-brackets-probes');
  });
  it('collects actual bounded GET probes and scoped receipt reads through GuardedClient', async () => {
    const { options, calls } = collection(); const r = await collectDeploymentVerification(options);
    expect(calls).toHaveLength(8); expect(r.requestsUsed).toBe(8); expect(r.probes).toHaveLength(2); expect(r.blockers).toContain('before-images-decode'); expect(r.deploymentVerified).toBe(false);
    expect(JSON.stringify(r)).not.toContain(options.credentials.runner); expect(JSON.stringify(r)).not.toContain(options.credentials.collector);
  });
  it('blocks infrastructure writes through the supplied inspection client', async () => {
    const { options, calls } = collection();
    options.inspect = async (client, signal) => client.request({ kind: 'cloudflare', url: `${options.config.apiOrigin}/client/v4/accounts/${options.config.accountId}`, method: 'POST', body: '{}' }, signal);
    const r = await collectDeploymentVerification(options);
    expect(calls.every(url => !url.startsWith(options.config.apiOrigin))).toBe(true);
    expect(r.beforeFingerprint).toBeNull(); expect(r.afterFingerprint).toBeNull(); expect(r.deploymentVerified).toBe(false);
  });
  it('rejects missing live opt-in, insufficient plans and fixture transport before traffic', async () => {
    const { options, calls } = collection(); options.config.liveOptIn = false;
    await expect(collectDeploymentVerification(options)).rejects.toThrow('opt-in'); expect(calls).toHaveLength(0);
    options.config.liveOptIn = true; options.plannedRequests = 7; await expect(collectDeploymentVerification(options)).rejects.toThrow('Plan omits'); expect(calls).toHaveLength(0);
    delete options.dispatch; await expect(collectDeploymentVerification(options)).rejects.toThrow('injected dispatch');
  });
  it('stops cancelled probes and preserves failed readback as unknown', async () => {
    const { options, calls } = collection(); const abort = new AbortController(); abort.abort();
    await expect(collectDeploymentVerification({ ...options, signal: abort.signal })).rejects.toThrow(); expect(calls).toHaveLength(0);
    const dispatch = options.dispatch!; options.dispatch = async (url, init) => { const r = await dispatch(url, init); if (calls.length === 2) abortDuring.abort(); return r; };
    const abortDuring = new AbortController(); const r = await collectDeploymentVerification({ ...options, signal: abortDuring.signal });
    expect(r.deploymentVerified).toBe(false); expect(r.blockers).toContain('Deployment verification cancelled'); expect(calls.length).toBeLessThan(8);
  });
});
