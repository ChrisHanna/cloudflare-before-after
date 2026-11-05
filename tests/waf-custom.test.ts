import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runWafCustom } from '../packages/demo-core/src/waf-custom.js';
import { desiredCustomWaf } from '../packages/demo-core/src/custom-waf.js';
import { ReportStore } from '../packages/demo-core/src/reports.js';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import { labConfig } from './fixtures/lab.js';
import { FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Case = 'verified' | 'no-trigger' | 'origin-403' | 'unhealthy' | 'missing-events' | 'wrong-host' | 'missing-rule' | 'final-unavailable' | 'transient-events';
function fixture(variant: Case = 'verified') {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'waf-custom-')); roots.push(root);
  const config = labConfig(root); config.liveOptIn = true;
  const desired = desiredCustomWaf(config.labId, config.environments[1].origin);
  const receipts: Receipt[] = []; let event: any = null; let requests = 0; let configurationReads = 0; let eventReads = 0;
  const targets: { role: string; signature: string | null; path: string; requestId: string }[] = [];
  const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, result, errors: [] }), { status });
  const dispatch = vi.fn(async (value: string, init: RequestInit) => {
    const u = new URL(value);
    if (u.origin === 'https://api.cloudflare.com') {
      if (u.pathname.endsWith('/entrypoint')) {
        configurationReads++;
        if (variant === 'final-unavailable' && configurationReads > 1) return envelope(null, 403);
        return envelope({ id: 'a'.repeat(32), name: 'fixture-custom-rules', kind: 'zone', phase: 'http_request_firewall_custom', version: '1', rules: variant === 'missing-rule' ? [] : [{ id: 'c'.repeat(32), ref: desired.ref, action: 'block', enabled: true, description: desired.description, expression: variant === 'wrong-host' ? '(http.host eq "before.example.test")' : desired.expression }] });
      }
      if (u.pathname.endsWith('/graphql')) {
        eventReads++;
        if (variant === 'transient-events' && eventReads === 1) return new Response('{"errors":[{"message":"temporarily unavailable"}]}', { status: 403 });
        return new Response(JSON.stringify({ data: { viewer: { zones: [{ firewallEventsAdaptive: event && variant !== 'missing-events' ? [event] : [] }] } } }));
      }
      throw new Error('Unapproved fixture API path');
    }
    if (u.origin === config.telemetryOrigin) {
      const role = u.searchParams.get('role') as 'before' | 'after'; const start = u.searchParams.get('start')!;
      const selected = receipts.filter(r => r.targetRole === role && r.runId === u.searchParams.get('runId'));
      const healthy = variant !== 'unhealthy';
      return new Response(JSON.stringify({ schemaVersion: 1, targetRole: role, runId: u.searchParams.get('runId'), scenarioId: 'waf-custom', originCount: healthy ? selected.filter(r => r.stage === 'entry').length : null, receipts: selected, coverage: { healthy, complete: healthy, windowStart: start, watermark: new Date().toISOString(), producerSequence: selected.length, gaps: healthy ? [] : ['Missing producer coverage'] } }));
    }
    const role = config.environments.find(e => e.origin === u.origin)?.role;
    if (!role) throw new Error('Unapproved fixture hostname');
    if (u.pathname === '/internal/checkpoint') return new Response('{"healthy":true}');
    const headers = new Headers(init.headers); const runId = headers.get('x-demo-run-id')!; const requestId = headers.get('x-demo-request-id')!;
    expect(headers.get('x-demo-run-token')).toBe(FIXTURE_CREDENTIALS.runner);
    const signature = headers.get('x-demo-test'); targets.push({ role, signature, path: u.pathname, requestId });
    const rayId = (++requests).toString(16).padStart(16, '0'); const observedAt = new Date().toISOString();
    const shouldBlock = role === 'after' && signature !== null && variant !== 'no-trigger';
    if (!shouldBlock || variant === 'origin-403') receipts.push({ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: 'waf-custom', targetRole: role, producerId: `${role}-fixture`, sequence: receipts.filter(r => r.targetRole === role).length + 1, observedAt, rayId, releaseDigest: config.environments[0].releaseDigest, stage: 'entry' });
    if (shouldBlock && variant !== 'origin-403') event = { datetime: observedAt, rayName: rayId, action: 'block', source: 'firewallrules', ruleId: 'c'.repeat(32), clientRequestHTTPHost: desired.hostname };
    return new Response(shouldBlock ? 'Synthetic edge observation' : 'Synthetic storefront', { status: shouldBlock ? 403 : 200, headers: { 'cf-ray': `${rayId}-DFW` } });
  });
  const run = (extra: Partial<Parameters<typeof runWafCustom>[0]> = {}) => runWafCustom({ projectRoot: root, config, observedOwnedResources: new Set(config.inventory.map(i => `${i.type}:${i.role}:${i.id}`)), mode: 'fixture', credentials: { reader: FIXTURE_CREDENTIALS.reader, collector: FIXTURE_CREDENTIALS.collector, runner: FIXTURE_CREDENTIALS.runner }, dispatch, limits: { requests: variant === 'transient-events' ? 30 : 13 }, ...extra });
  return { root, config, desired, targets, dispatch, run, counters: () => ({ configurationReads, eventReads }) };
}
describe('waf-custom bounded comparison (fixture evidence only)', () => {
  it('joins real adapter HTTP, exact custom rule, event and complete origin facts before fixture verification', async () => {
    const f = fixture(); const phases: string[] = []; const result = await f.run({ onPhase: phase => { phases.push(phase); } });
    expect(result.decision).toMatchObject({ outcome: 'verified', mode: 'fixture', missingProof: [], contradictions: [] });
    expect(result.report.mode).toBe('fixture'); expect(result.report.result.requestsUsed).toBe(11); expect(result.report.result.cleanup).toBe('complete');
    expect(f.targets).toHaveLength(4); expect(f.targets.filter(t => t.signature).map(t => t.signature)).toEqual([f.desired.marker, f.desired.marker]);
    expect(f.targets.every(t => t.path === '/catalog')).toBe(true); expect(new Set(f.targets.map(t => t.requestId)).size).toBe(4);
    expect(phases).toEqual(['preflight', 'baseline', 'protected', 'correlate', 'report', 'finished']);
    const store = new ReportStore(f.root, f.config.evidenceDirectory); const path = store.save(result.report, result.artifacts);
    expect(store.load(result.report.result.runId)).toEqual(result.report);
    const html = readFileSync(join(path, 'report.html'), 'utf8'); expect(html).toContain('Request evidence'); expect(html).toContain('Not received'); expect(html).toContain('Custom WAF rules'); expect(html).toContain('FIXTURE');
    const serialized = JSON.stringify(result); for (const secret of Object.values(FIXTURE_CREDENTIALS)) expect(serialized).not.toContain(secret);
  });
  it('fails known origin arrivals and refuses status-only, missing-log and absent-event proof', async () => {
    for (const variant of ['no-trigger', 'origin-403', 'unhealthy', 'missing-events'] as const) {
      const result = await fixture(variant).run();
      expect(result.report.result.outcome).toBe(variant === 'no-trigger' || variant === 'origin-403' ? 'failed' : 'inconclusive');
      expect(result.report.result.requestsUsed).toBeLessThanOrEqual(13);
    }
  });
  it('rejects wrong-host policy or missing rules before sending scenario traffic', async () => {
    const wrong = fixture('wrong-host'); const result = await wrong.run(); expect(result.decision.outcome).toBe('failed'); expect(wrong.targets).toEqual([]);
    const missing = fixture('missing-rule'); expect((await missing.run()).decision.outcome).toBe('unavailable'); expect(missing.targets).toEqual([]);
  });
  it('treats a failed final read as missing proof rather than known configuration drift', async () => {
    const result = await fixture('final-unavailable').run(); expect(result.decision.outcome).toBe('inconclusive'); expect(result.report.result.observedConfigDigest).toBeNull();
  });
  it('can recover bounded delayed evidence without retaining obsolete missing-proof flags', async () => {
    const f = fixture('transient-events'); const result = await f.run();
    expect(result.decision.outcome).toBe('verified'); expect(result.decision.missingProof).toEqual([]); expect(f.counters().eventReads).toBe(2); expect(result.report.result.requestsUsed).toBe(16);
  });
  it('cancels before traffic and rejects plans that cannot fit minimum proof', async () => {
    const f = fixture(); const result = await f.run({ onStarted: info => info.stop() }); expect(result.decision.outcome).toBe('inconclusive'); expect(f.targets).toEqual([]);
    await expect(f.run({ limits: { requests: 4 } })).rejects.toThrow('fit'); expect(f.targets).toEqual([]);
    // Releasing the cancelled run lease allows the next bounded run.
    expect((await f.run()).decision.outcome).toBe('verified');
  });
});
