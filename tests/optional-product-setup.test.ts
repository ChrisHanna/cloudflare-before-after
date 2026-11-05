import { describe, it, expect } from 'vitest';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { OptionalProductFileJournal } from '../packages/demo-core/src/optional-product-setup-store.js';
import { join } from 'node:path';
import { deploymentIntent } from './fixtures/deployment.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { createDeploymentPlan, digestValue } from '../packages/demo-core/src/deployment-plan.js';
import {
  planOptionalProductSetup, applyOptionalProductSetup, readConfirmedOptionalResources, createOptionalProductProvider, optionalProductDesired, executeOptionalProductSetupStep,
  type OptionalProductWireRequest, type OptionalProductRecord, type OptionalProductSelection, type OptionalProductApplyOptions,
} from '../packages/demo-core/src/optional-product-setup.js';
const NOW = Date.parse('2026-11-04T10:00:00.000Z');
const MODULES = ['api-shield', 'access', 'waiting-room'] as const;
const CERT = 'c'.repeat(32); const TOKEN = 'd'.repeat(32); const RULESET = 'e'.repeat(32);
const ROOM_EXECUTION = { queueContract: 'cloudflare-json-v1' as const, expectedTransitionMs: 15000,
  perNavigationRequests: 2, refreshes: 1, queueSelector: '[data-queue]', storefrontSelector: '[data-storefront]' };
async function fixture(modules: readonly typeof MODULES[number][] = MODULES, existingRuleset = true) {
  if (!process.env['KIROCREW_SCRATCH']) throw new Error('Fresh worker scratch required');
  const root = mkdtempSync(join(process.env['KIROCREW_SCRATCH'], 'ops-'));
  const intent = deploymentIntent(root, NOW); intent.profile = 'workshop';
  const capability = await discoverCapabilities(intent.discovery, 'workshop', { mode: 'fixture', inspect: async () => ({ state: 'available', source: 'fixture', reasons: [] }) }, undefined, new Date(NOW).toISOString());
  const plan = createDeploymentPlan(intent, capability, 'a'.repeat(64), root, NOW, ['core', ...capability.includedModules]);
  expect(plan.blockers).toEqual([]);
  const afterHost = new URL(intent.discovery.environments[1]!.origin).hostname;
  const selections: OptionalProductSelection[] = [
    { module: 'api-shield', certificateId: CERT, certificateRef: 'certificate:lab-api', fingerprint: 'f'.repeat(64) },
    { module: 'access', serviceTokenId: TOKEN },
    { module: 'waiting-room', settings: { hostname: afterHost, path: '/launch', total_active_users: 200, new_users_per_minute: 200, session_duration: 1, queue_all: false, suspended: false } },
  ].filter(s => modules.includes(s.module as typeof MODULES[number])) as OptionalProductSelection[];
  const calls: OptionalProductWireRequest[] = []; const writes: OptionalProductWireRequest[] = [];
  const resources: Record<string, Record<string, unknown>[]> = { 'api-shield': [], access: [], 'waiting-room': [] };
  let zoneAccount = intent.discovery.accountId; let zoneName = 'example.test'; let partialPage = false; let failed = false; let failWrite = 0;
  let abortOnWrite: AbortController | null = null; let wrongReadback = false;
  const provider = createOptionalProductProvider('fixture', {
    inspectCertificate: async () => ({ id: CERT, fingerprint: 'f'.repeat(64), hostname: afterHost, ready: true }),
    exchange: async (request, _signal) => {
      calls.push(structuredClone(request));
      const wrap = (result: unknown) => ({ success: true, result, result_info: { total_pages: partialPage ? 2 : 1, page: 1 } });
      if (request.method === 'GET') {
        if (request.path === `/zones/${intent.discovery.zoneId}`) return wrap({ id: intent.discovery.zoneId, account: { id: zoneAccount }, name: zoneName });
        if (request.path.includes('/service_tokens/')) return wrap({ id: TOKEN, client_secret: 'SECRET-MUST-NOT-BE-SAVED' });
        if (request.path.includes('/policies?')) return wrap(resources['access']![0]?.['policies']);
        if (request.path.includes('/rulesets/')) return wrap({ id: existingRuleset || resources['api-shield']!.length ? RULESET : null, rules: resources['api-shield'] });
        if (request.path.includes('/access/apps?')) return wrap(resources['access']);
        if (request.path.includes('/waiting_rooms?')) return wrap(resources['waiting-room']);
        throw new Error('Unexpected read');
      }
      writes.push(structuredClone(request));
      const module = request.path.includes('/rulesets') ? 'api-shield' : request.path.includes('/access/apps') ? 'access' : 'waiting-room';
      const body = request.body as Record<string, unknown>;
      const payload = (Array.isArray(body['rules']) ? body['rules'][0] : body) as Record<string, unknown>;
      const id = String(MODULES.indexOf(module) + 1).repeat(32);
      resources[module]!.push({ ...structuredClone(payload), id, name: String(payload['name'] ?? payload['description']),
        ...(module === 'access' ? { aud: '9'.repeat(64), private_data: 'PRIVATE-NOT-SERIALIZE', policies: (payload['policies'] as Record<string, unknown>[]).map(policy => ({ ...policy, id: '8'.repeat(32) })) } : {}), ...(wrongReadback ? { enabled: false, host: 'wrong.example.test', domain: 'wrong.example.test/admin' } : {}) });
      abortOnWrite?.abort();
      if (failWrite === writes.length || failed) throw new Error('SECRET-UNCERTAIN-WRITE');
      return wrap(module === 'api-shield' ? { id: RULESET, rules: resources[module] } : resources[module]![0]);
    },
  });
  const controller = new AbortController(); const records = new Map<string, OptionalProductRecord>();
  const setup = await planOptionalProductSetup(plan, selections, provider, {}, controller.signal, NOW);
  const options: OptionalProductApplyOptions = { plan, setup, provider,
    approval: { planDigest: digestValue(setup), centralPlanDigest: digestValue(plan), approvedAt: new Date(NOW).toISOString() },
    journal: {
      get: async key => structuredClone(records.get(key) ?? null),
      begin: async record => { if (records.has(record.key)) throw new Error('Exclusive attempt consumed'); records.set(record.key, structuredClone(record)); },
      save: async record => { records.set(record.key, structuredClone(record)); },
    },
    context: { plan, signal: controller.signal, perform: async (_kind, _id, action) => action(), observeResource: () => {} },
    revalidate: async () => plan, now: () => NOW,
  };
  return { plan, setup, selections, options, provider, records, resources, calls, writes, controller,
    wrongAccount: () => { zoneAccount = '0'.repeat(32); }, wrongZone: () => { zoneName = 'foreign.test'; },
    incomplete: () => { partialPage = true; }, fail: (nth = 1) => { failWrite = nth; },
    failAll: () => { failed = true; }, abortWrite: () => { abortOnWrite = controller; }, wrongReadback: () => { wrongReadback = true; } };
}
describe('reviewed optional product setup (OFFLINE injected provider I/O)', () => {
  it('binds declared room execution to exact approval and projects it without sending it to the provider', async () => {
    const f = await fixture(); const selections = f.selections.map(selection => selection.module === 'api-shield'
      ? { ...selection, certificateSource: 'zone-managed' as const }
      : selection.module === 'waiting-room' ? { ...selection, execution: ROOM_EXECUTION } : selection);
    const setup = await planOptionalProductSetup(f.plan, selections, f.provider, {}, f.controller.signal, NOW);
    expect(digestValue(setup)).not.toBe(digestValue(f.setup));
    const options = { ...f.options, setup, approval: { ...f.options.approval!, planDigest: digestValue(setup) } };
    await expect(applyOptionalProductSetup(options)).resolves.toMatchObject({ status: 'succeeded' });
    const resources = await readConfirmedOptionalResources(options);
    expect(resources.find(resource => resource.module === 'waiting-room')).toMatchObject({ execution: ROOM_EXECUTION });
    expect(resources.find(resource => resource.module === 'api-shield')).toMatchObject({ certificateSource: 'zone-managed' });
    expect(JSON.stringify(f.writes[2])).not.toMatch(/expectedTransitionMs|queueSelector|queueContract|perNavigationRequests/);
    expect(f.writes).toHaveLength(3);
  });
  it('rejects changed room execution under the old approval before any write', async () => {
    const f = await fixture(); const setup = structuredClone(f.setup);
    const room = setup.operations.find(operation => operation.module === 'waiting-room')!;
    if (room.selection.module !== 'waiting-room') throw new Error('Room operation missing');
    room.selection.execution = ROOM_EXECUTION;
    await expect(applyOptionalProductSetup({ ...f.options, setup })).rejects.toThrow('approval');
    expect(f.writes).toHaveLength(0);
  });
  it('rejects impossible room execution before reading any product scope', async () => {
    const f = await fixture(); const reads = f.calls.length;
    const selections = f.selections.map(selection => selection.module === 'waiting-room' ? { ...selection, execution: { ...ROOM_EXECUTION, refreshes: 8, perNavigationRequests: 10 } } : selection);
    await expect(planOptionalProductSetup(f.plan, selections, f.provider, {}, f.controller.signal, NOW)).rejects.toThrow('request cap');
    expect(f.calls).toHaveLength(reads); expect(f.writes).toHaveLength(0);
  });
  it('publishes only freshly read confirmed runtime IDs without creating or leaking credentials', async () => {
    const f = await fixture(); await applyOptionalProductSetup(f.options);
    const writes = f.writes.length; const resources = await readConfirmedOptionalResources(f.options);
    expect(resources.map(resource => resource.module)).toEqual([...MODULES]); expect(f.writes).toHaveLength(writes);
    expect(resources.every(resource => resource.accountId === f.plan.intent.discovery.accountId && resource.zoneId === f.plan.intent.discovery.zoneId && resource.origin === f.plan.intent.discovery.environments[1].origin && resource.releaseDigest === f.plan.intent.releaseDigest)).toBe(true);
    expect(resources.find(resource => resource.module === 'access')).toMatchObject({ resourceId: '2'.repeat(32), policyId: '8'.repeat(32), audience: '9'.repeat(64), serviceTokenId: TOKEN });
    expect(resources.find(resource => resource.module === 'api-shield')).toMatchObject({ resourceId: '1'.repeat(32), certificateId: CERT, certificateRef: 'certificate:lab-api' });
    expect(JSON.stringify(resources)).not.toMatch(/SECRET|PRIVATE-NOT-SERIALIZE|client_secret|private_data/);
    expect(resources.every(resource => resource.centralPlanDigest === digestValue(f.plan) && resource.optionalPlanDigest === digestValue(f.setup) && resource.mode === 'fixture')).toBe(true);
  });
  it.each(['missing', 'possible', 'digest', 'foreign-id', 'approval', 'drift', 'plan'] as const)('rejects %s runtime confirmation without repair writes', async fault => {
    const f = await fixture(); await applyOptionalProductSetup(f.options); const writes = f.writes.length;
    const record = [...f.records.values()][0]!;
    if (fault === 'missing') f.records.delete(record.key);
    if (fault === 'possible') record.state = 'possible';
    if (fault === 'digest') record.afterDigest = '0'.repeat(64);
    if (fault === 'foreign-id') record.resourceIds = ['7'.repeat(32)];
    if (fault === 'approval') f.options.approval = null;
    if (fault === 'drift') f.resources['waiting-room']![0]!['session_duration'] = 2;
    if (fault === 'plan') f.options.revalidate = async () => ({ ...f.plan, sourceDigest: 'b'.repeat(64) });
    await expect(readConfirmedOptionalResources(f.options)).rejects.toThrow(); expect(f.writes).toHaveLength(writes);
  });
  it('rejects runtime publication before setup instead of creating missing resources', async () => {
    const f = await fixture(); await expect(readConfirmedOptionalResources(f.options)).rejects.toThrow('confirmation');
    expect(f.writes).toHaveLength(0);
  });
  it('rejects a readback that outlives exact-plan approval', async () => {
    const f = await fixture(); await applyOptionalProductSetup(f.options); let time = NOW;
    const inspect = f.provider.inspect.bind(f.provider);
    f.options.now = () => time;
    f.options.provider = { ...f.provider, inspect: async (...args) => { const result = await inspect(...args); time = NOW + 16 * 60000; return result; } };
    await expect(readConfirmedOptionalResources(f.options)).rejects.toThrow('expired'); expect(f.writes).toHaveLength(3);
  });
  it('encodes three real REST operations, reads back, and never invokes Wrangler', async () => {
    const f = await fixture(); const result = await applyOptionalProductSetup(f.options);
    expect(result.status).toBe('succeeded'); expect(f.writes).toHaveLength(3);
    expect(f.writes[0]).toMatchObject({ method: 'POST', path: `/zones/${f.plan.intent.discovery.zoneId}/rulesets/${RULESET}/rules`, body: { action: 'block', enabled: true } });
    const rule = f.writes[0]!; if (rule.method !== 'POST') throw new Error('No rule write');
    const expression = (rule.body as { expression: string }).expression;
    expect(expression).toContain('cf.tls_client_auth.cert_verified'); expect(expression).toContain('cert_revoked'); expect(expression).toContain('cert_fingerprint_sha256');
    expect(expression).toContain(new URL(f.plan.intent.discovery.environments[1]!.origin).hostname);
    expect(expression).not.toContain(new URL(f.plan.intent.discovery.environments[0]!.origin).hostname);
    expect(f.writes[1]).toMatchObject({ path: `/accounts/${f.plan.intent.discovery.accountId}/access/apps`, body: { type: 'self_hosted', policies: [{ decision: 'non_identity', include: [{ service_token: { token_id: TOKEN } }] }] } });
    expect(f.writes[2]).toMatchObject({ path: `/zones/${f.plan.intent.discovery.zoneId}/waiting_rooms`, body: { host: new URL(f.plan.intent.discovery.environments[1]!.origin).hostname, path: '/launch', total_active_users: 200, session_duration: 1, queue_all: false } });
    expect(result.records.every(r => r.state === 'confirmed')).toBe(true);
    expect(JSON.stringify([...f.records.values()])).not.toContain('SECRET');
  });
  it('dispatches only the current central product-policy step', async () => {
    const f = await fixture();
    const step = f.plan.steps.find(s => s.kind === 'product-policy' && s.module === 'access')!;
    await executeOptionalProductSetupStep(step, f.options); expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.path).toContain('/access/apps');
    await executeOptionalProductSetupStep(f.plan.steps.find(s => s.module === 'waiting-room')!, f.options);
    expect(f.writes).toHaveLength(2); expect(f.writes[1]!.path).toContain('/waiting_rooms');
    await expect(executeOptionalProductSetupStep({ ...step, resources: ['foreign'] }, f.options)).rejects.toThrow('Undeclared');
    expect(f.writes).toHaveLength(2);
  });
  it('rejects optional inventories with missing page metadata before writes', async () => {
    const f = await fixture(['access']); let writes = 0;
    const provider = createOptionalProductProvider('fixture', {
      inspectCertificate: async () => { throw new Error('Unplanned certificate read'); },
      exchange: async request => {
        if (request.method !== 'GET') { writes++; throw new Error('Unexpected write'); }
        if (request.path === `/zones/${f.plan.intent.discovery.zoneId}`) return { success: true, result: { id: f.plan.intent.discovery.zoneId, account: { id: f.plan.intent.discovery.accountId }, name: 'example.test' } };
        if (request.path.includes('/service_tokens/')) return { success: true, result: { id: TOKEN } };
        return { success: true, result: [] };
      },
    });
    await expect(planOptionalProductSetup(f.plan, f.selections, provider, {}, f.controller.signal, NOW)).rejects.toThrow('Missing bounded product pages');
    expect(writes).toBe(0);
  });
  it('creates a zone ruleset only when its reviewed entrypoint was absent', async () => {
    const f = await fixture(['api-shield'], false); expect((await applyOptionalProductSetup(f.options)).status).toBe('succeeded');
    expect(f.writes[0]).toMatchObject({ path: `/zones/${f.plan.intent.discovery.zoneId}/rulesets`, body: { kind: 'zone', phase: 'http_request_firewall_custom', rules: [{ action: 'block' }] } });
  });
  it.each(['absent', 'stale', 'wrong-digest', 'wrong-account', 'wrong-zone', 'unknown-cost', 'source-drift', 'excluded', 'readback-drift', 'incomplete'])('%s causes zero provider writes', async fault => {
    const f = await fixture();
    if (fault === 'absent') f.options.approval = null;
    if (fault === 'stale') f.options.now = () => NOW + 900001;
    if (fault === 'wrong-digest') f.options.approval!.planDigest = '0'.repeat(64);
    if (fault === 'wrong-account') f.wrongAccount();
    if (fault === 'wrong-zone') f.wrongZone();
    if (fault === 'unknown-cost') f.plan.intent.costs.lines[0]!.thisMonthCents = null;
    if (fault === 'source-drift') f.options.revalidate = async () => ({ ...f.plan, sourceDigest: 'b'.repeat(64) });
    if (fault === 'excluded') f.plan.excludedModules.push({ id: 'api-shield', reasons: ['Not selected'] });
    if (fault === 'readback-drift') f.resources['waiting-room']!.push({ id: '9'.repeat(32), name: 'foreign', host: 'elsewhere.example.test' });
    if (fault === 'incomplete') f.incomplete();
    await expect(applyOptionalProductSetup(f.options)).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it('rejects wrong Waiting Room host and unsupported capacity before planning', async () => {
    const f = await fixture(['waiting-room']); const selection = f.selections[0]!;
    if (selection.module !== 'waiting-room') throw new Error('Wrong module');
    selection.settings.hostname = 'wrong.example.test';
    await expect(planOptionalProductSetup(f.plan, [selection], f.provider, {}, f.controller.signal, NOW)).rejects.toThrow('hostname');
    selection.settings.hostname = new URL(f.plan.intent.discovery.environments[1]!.origin).hostname; selection.settings.total_active_users = 1;
    await expect(planOptionalProductSetup(f.plan, [selection], f.provider, {}, f.controller.signal, NOW)).rejects.toThrow(); expect(f.writes).toEqual([]);
  });
  it('reuses confirmed records only after actual matching readback', async () => {
    const f = await fixture(); await applyOptionalProductSetup(f.options);
    expect((await applyOptionalProductSetup(f.options)).status).toBe('succeeded'); expect(f.writes).toHaveLength(3);
    f.resources['access']![0]!['domain'] = 'wrong.example.test/admin';
    await expect(applyOptionalProductSetup(f.options)).rejects.toThrow('drift'); expect(f.writes).toHaveLength(3);
  });
  it('preserves partial resources and requires a fresh recovery plan, never duplicate writes', async () => {
    const f = await fixture(); f.fail(2); const result = await applyOptionalProductSetup(f.options);
    expect(result.status).toBe('partial'); expect(result.records.map(r => r.state)).toEqual(['confirmed', 'possible']); expect(f.writes).toHaveLength(2);
    await expect(applyOptionalProductSetup(f.options)).rejects.toThrow('recovery'); expect(f.writes).toHaveLength(2);
    // Recovery may adopt only the observed identity retained by the operator's recovery inventory.
    const access = f.selections[1]!; const app = f.resources['access']![0]!;
    const recovery = await planOptionalProductSetup(f.plan, [access], f.provider, { access: [String(app['id'])] }, new AbortController().signal, NOW + 1);
    const recoveryOptions = { ...f.options, setup: recovery, now: () => NOW + 1, approval: { planDigest: digestValue(recovery), centralPlanDigest: digestValue(f.plan), approvedAt: new Date(NOW + 1).toISOString() } };
    expect((await applyOptionalProductSetup(recoveryOptions)).status).toBe('succeeded'); expect(f.writes).toHaveLength(2);
  });
  it('records an interrupted in-flight write as possible and never retries', async () => {
    const f = await fixture(['waiting-room']); f.abortWrite();
    const result = await applyOptionalProductSetup(f.options); expect(result.status).toBe('partial'); expect(result.records[0]!.state).toBe('possible');
    expect(f.writes).toHaveLength(1); await expect(applyOptionalProductSetup(f.options)).rejects.toThrow(); expect(f.writes).toHaveLength(1);
  });
  it('does not claim success from a successful create without functional readback', async () => {
    const f = await fixture(['waiting-room']); f.wrongReadback();
    expect((await applyOptionalProductSetup(f.options)).status).toBe('partial'); expect([...f.records.values()][0]!.state).toBe('possible');
  });
  it('refuses name-only ownership and foreign overlap', async () => {
    const f = await fixture(['access']);
    f.resources['access']!.push({ ...optionalProductDesired(f.plan, f.selections[0]!), id: '8'.repeat(32) });
    await expect(applyOptionalProductSetup(f.options)).rejects.toThrow('owned-resource'); expect(f.writes).toEqual([]);
    await expect(planOptionalProductSetup(f.plan, f.selections, f.provider, {}, f.controller.signal, NOW)).rejects.toThrow('owned-resource');
  });
  it('checks approval again immediately before dispatch', async () => {
    const f = await fixture(['waiting-room']); const begin = f.options.journal.begin;
    f.options.journal.begin = async record => { await begin(record); f.options.approval = null; };
    expect((await applyOptionalProductSetup(f.options)).status).toBe('partial'); expect(f.writes).toEqual([]);
  });
  it('rejects overlapping foreign products on either storefront', async () => {
    for (const module of ['access', 'waiting-room'] as const) {
      const f = await fixture([module]); const beforeHost = new URL(f.plan.intent.discovery.environments[0]!.origin).hostname;
      f.resources[module]!.push({ id: '7'.repeat(32), name: 'foreign', domain: `${beforeHost}/admin`, host: beforeHost });
      await expect(applyOptionalProductSetup(f.options)).rejects.toThrow('Overlapping'); expect(f.writes).toEqual([]);
    }
  });
  it('rechecks freshness after slow reads before any dispatch', async () => {
    const f = await fixture(['waiting-room']); const inspect = f.provider.inspect;
    let reads = 0; let time = NOW; f.options.now = () => time;
    f.provider.inspect = async (...args) => { const result = await inspect(...args); if (++reads === 3) time = NOW + 900001; return result; };
    expect((await applyOptionalProductSetup(f.options)).status).toBe('partial'); expect(f.writes).toEqual([]);
  });
  it('persists exclusive intent across journal instances and never changes confirmed records', async () => {
    const f = await fixture(['waiting-room']); const root = mkdtempSync(join(process.env['KIROCREW_SCRATCH']!, 'journal-'));
    const evidence = join(root, '.evidence');
    const journal = new OptionalProductFileJournal(root, evidence);
    const operationId = f.setup.operations[0]!.id; const planDigest = digestValue(f.setup);
    const record: OptionalProductRecord = { key: `${planDigest}:${operationId}`, planDigest, operationId, state: 'possible', resourceIds: [], afterDigest: null };
    await journal.begin(record);
    const reopened = new OptionalProductFileJournal(root, evidence);
    expect(await reopened.get(record.key)).toEqual(record); await expect(reopened.begin(record)).rejects.toThrow();
    const confirmed: OptionalProductRecord = { ...record, state: 'confirmed', resourceIds: ['1'.repeat(32)], afterDigest: 'a'.repeat(64) };
    await reopened.save(confirmed); expect(await journal.get(record.key)).toEqual(confirmed);
    await expect(journal.save({ ...confirmed, resourceIds: ['2'.repeat(32)] })).rejects.toThrow('immutable');
    await expect(journal.get('../foreign')).rejects.toThrow();
    const otherId = '2'.repeat(64); const otherKey = `${planDigest}:${otherId}`;
    const foreign = join(root, 'not-a-journal'); writeFileSync(foreign, JSON.stringify(record));
    symlinkSync(foreign, join(journal.directory, `${otherKey.replace(':', '-')}.json`));
    await expect(journal.get(otherKey)).rejects.toThrow('Journal read failed');
  });
  it('runs setup with the actual durable journal and reopens without duplicate writes', async () => {
    const f = await fixture(['waiting-room']);
    f.options.journal = new OptionalProductFileJournal(f.plan.intent.discovery.evidenceDirectory.replace(/\/.evidence$/, ''), f.plan.intent.discovery.evidenceDirectory);
    expect((await applyOptionalProductSetup(f.options)).status).toBe('succeeded');
    expect((await applyOptionalProductSetup(f.options)).status).toBe('succeeded'); expect(f.writes).toHaveLength(1);
  });
  it('keeps core-only plans free from optional operations', async () => {
    const f = await fixture([]); f.plan.includedModules = ['core']; f.plan.capability.includedModules = ['core'];
    f.plan.capabilityDigest = (await import('../packages/demo-core/src/capabilities.js')).capabilityDigest(f.plan.capability);
    const setup = await planOptionalProductSetup(f.plan, [], f.provider, {}, f.controller.signal, NOW);
    expect(setup.operations).toEqual([]); expect(f.writes).toEqual([]);
  });
});
