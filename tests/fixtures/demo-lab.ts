import { randomUUID } from 'node:crypto';
import { deployedRuntimeConfig } from '../../packages/demo-core/src/runtime-config.js';
import { desiredCustomWaf } from '../../packages/demo-core/src/custom-waf.js';
import { SYNTHETIC_IMAGE_BASE64, SYNTHETIC_IMAGE_DIGEST } from '../../packages/demo-core/src/infrastructure.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './deployment.js';
import { infrastructureFixture } from './infrastructure.js';
import { desiredRateLimit } from '../../packages/demo-core/src/rate-policy.js';
import { PolicyModule, WafModule } from '../../packages/demo-core/src/product-state.js';
import type { Receipt } from '../../packages/contracts/src/schemas.js';
export function demoLabFixture(root: string, fault?: 'binding' | 'policy' | 'telemetry' | 'route' | 'image', now: () => number = Date.now, botMode: 'missing' | 'entitled' | 'unchanged' | 'score-hidden' = 'missing') {
  const inventory = infrastructureFixture().inventory; const intent = deploymentIntent(root); intent.discovery.labId = inventory.lab_id;
  const config = deployedRuntimeConfig(intent, inventory, 'c'.repeat(32));
  const rules = WafModule.options.map((module, index) => ({ desired: desiredCustomWaf(config.labId, config.environments[1].origin, module), id: ['c', 'd', 'e', 'b'][index]!.repeat(32) }));
  const rate = desiredRateLimit(config.labId, config.environments[1].origin); let rateCount = 0; let rateStart = 0; let blockedUntil = 0;
  const credentials = { reader: FIXTURE_CREDENTIALS.reader, collector: FIXTURE_CREDENTIALS.collector, runner: FIXTURE_CREDENTIALS.runner };
  const canary = 'fixture-unexpected-private-binding-canary';
  const receipts: Receipt[] = []; let event: any = null; let targetCount = 0;
  const calls: { url: string; method: string }[] = [];
  const asset = (role: 'before' | 'after') => ({ id: config.environments.find(e => e.role === role)!.imageIds[0]!, role, labId: config.labId, immutable: true, deliveryOrigin: 'https://imagedelivery.net', accountHash: 'fixture-account', variant: inventory.image_variant, expectedDigest: SYNTHETIC_IMAGE_DIGEST });
  const ns = (role: 'before' | 'after') => (role === 'before' ? 'b' : 'd').repeat(32);
  const plain = (name: string, text: string) => ({ name, type: 'plain_text', text });
  const secret = (name: string) => ({ name, type: 'secret_text', text: canary });
  const bindings = (role: 'before' | 'after') => {
    const env = config.environments.find(e => e.role === role)!;
    return { bindings: [plain('LAB_ID', config.labId), plain('ROLE', role), plain('ORIGIN', env.origin), plain('RELEASE_DIGEST', env.releaseDigest), plain('IMAGE_ASSET_JSON', JSON.stringify(asset(role))), plain('UNEXPECTED_PRIVATE_TEXT', canary), { name: 'DB', type: 'd1', id: fault === 'binding' && role === 'before' ? randomUUID() : env.d1Id }, { name: 'OBJECTS', type: 'r2_bucket', bucket_name: env.r2Bucket }, { name: 'ORIGINS', type: 'durable_object_namespace', namespace_id: ns(role) }, ...['RUN_SECRET', 'INTERNAL_SECRET', 'REGISTRY_SECRET', 'INGEST_ROOT_SECRET', 'SETUP_SECRET'].map(secret)] };
  };
  const telemetrySettings = { bindings: [plain('LAB_ID', config.labId), plain('ORIGIN', config.telemetryOrigin), plain('RELEASE_DIGEST', config.environments[0].releaseDigest), ...config.environments.map(e => ({ name: `DB_${e.role.toUpperCase()}`, type: 'd1', id: e.d1Id })), ...['COLLECTOR_SECRET', 'INGEST_ROOT_SECRET_BEFORE', 'INGEST_ROOT_SECRET_AFTER', 'REGISTRY_SECRET_BEFORE', 'REGISTRY_SECRET_AFTER'].map(secret)] };
  const envelope = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { 'content-type': 'application/json' } });
  const dispatch = async (value: string, init: RequestInit): Promise<Response> => {
    calls.push({ url: value, method: init.method ?? 'GET' }); const u = new URL(value); const path = u.pathname;
    if (u.origin === config.apiOrigin) {
      if (path === `/client/v4/accounts/${config.accountId}`) return envelope({ id: config.accountId });
      if (path === `/client/v4/zones/${config.zoneId}`) return envelope({ id: config.zoneId, status: 'active', account: { id: config.accountId } });
      if (path.endsWith('/bot_management')) return envelope(botMode === 'missing' ? { fight_mode: false } : { auto_update_model: true, bm_cookie_enabled: true, enable_js: false, suppress_session_score: false, using_latest_model: true });
      if (path.endsWith('/workers/domains')) return envelope([...config.environments.map(e => ({ hostname: new URL(e.origin).hostname, service: fault === 'route' && e.role === 'after' ? 'foreign-worker' : e.workerName })), { hostname: new URL(config.telemetryOrigin).hostname, service: `${config.labId}-telemetry` }]);
      if (path.endsWith(`/workers/scripts/${config.labId}-telemetry/settings`)) return envelope(telemetrySettings);
      if (path.includes('/workers/scripts/')) { const env = config.environments.find(e => path.endsWith(`/${e.workerName}/settings`)); if (env) return envelope(bindings(env.role)); }
      if (path.includes('/d1/database/')) { const env = config.environments.find(e => path.endsWith(`/${e.d1Id}`)); if (env) return envelope({ uuid: env.d1Id, name: `${config.labId}-${env.role}-storefront` }); }
      if (path.includes('/r2/buckets/')) { const env = config.environments.find(e => path.endsWith(`/${e.r2Bucket}`)); if (env) return envelope({ name: env.r2Bucket }); }
      if (path.includes('/images/v1/')) { const env = config.environments.find(e => path.endsWith(`/${e.imageIds[0]}`)); if (env) return envelope({ id: env.imageIds[0], meta: { owner: `${config.labId}:${env.role}:immutable-catalog`, sourceDigest: SYNTHETIC_IMAGE_DIGEST } }); }
      if (path.endsWith('/containers/applications')) { const env = config.environments.find(e => e.containerBinding === u.searchParams.get('name')); if (env) return envelope([{ id: `${env.role}-app`, name: env.containerBinding, durable_objects: { namespace_id: ns(env.role) } }]); }
      if (path.includes('/http_ratelimit/entrypoint')) return envelope({ id: 'b'.repeat(32), name: 'Fixture owned rate rules', phase: 'http_ratelimit', kind: 'zone', version: '1', rules: [{ id: 'f'.repeat(32), ref: rate.ref, description: rate.description, action: rate.action, expression: rate.expression, enabled: true, ratelimit: rate.ratelimit }] });
      if (path.endsWith('/entrypoint')) return envelope({ id: 'a'.repeat(32), name: 'Fixture owned custom rules', phase: 'http_request_firewall_custom', kind: 'zone', version: '1', rules: rules.map(rule => ({ id: rule.id, ref: rule.desired.ref, action: 'block', enabled: true, description: rule.desired.description, expression: fault === 'policy' && rule.desired.module === 'waf-custom' ? '(http.host eq "before.example.test")' : rule.desired.expression })) });
      if (path.endsWith('/graphql')) {
        const ray = /rayName: "([a-f0-9]{16})"/i.exec(JSON.parse(init.body as string).query)?.[1];
        return new Response(JSON.stringify({ data: { viewer: { zones: [{ firewallEventsAdaptive: event?.rayName === ray ? [event] : [] }] } } }), { headers: { 'content-type': 'application/json' } });
      }
      throw new Error('Unregistered fixture API request');
    }
    if (u.origin === config.telemetryOrigin) {
      const role = u.searchParams.get('role') as 'before' | 'after'; const selected = receipts.filter(r => r.targetRole === role && r.runId === u.searchParams.get('runId'));
      const healthy = fault !== 'telemetry';
      return new Response(JSON.stringify({ schemaVersion: 1, targetRole: role, runId: u.searchParams.get('runId'), scenarioId: u.searchParams.get('scenarioId'), originCount: healthy ? selected.length : null, receipts: selected, coverage: { healthy, complete: healthy, windowStart: u.searchParams.get('start'), watermark: new Date(now()).toISOString(), producerSequence: selected.length, gaps: healthy ? [] : ['Fixture incomplete producer coverage'] } }), { headers: { 'content-type': 'application/json' } });
    }
    if (u.origin === 'https://imagedelivery.net') return new Response(fault === 'image' ? null : Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64'), { status: fault === 'image' ? 404 : 200, headers: { 'content-type': 'image/png' } });
    const env = config.environments.find(e => e.origin === u.origin); if (!env) throw new Error('Unapproved fixture hostname');
    if (path === '/internal/checkpoint') return new Response('{"healthy":true}', { headers: { 'content-type': 'application/json' } });
    if (!['/catalog', '/api'].includes(path)) throw new Error('Unexpected fixture application path');
    const headers = new Headers(init.headers); const runId = headers.get('x-demo-run-id')!; const requestId = headers.get('x-demo-request-id')!;
    if (headers.get('x-demo-run-token') !== credentials.runner) throw new Error('Wrong fixture run credential');
    const ray = (++targetCount).toString(16).padStart(16, '0'); const time = new Date(now()).toISOString();
    const module = PolicyModule.parse(headers.get('x-demo-scenario')); const selectedRule = module === 'rate-limit' ? { desired: rate, id: 'f'.repeat(32) } : rules.find(rule => rule.desired.module === module)!;
    let blocked = env.role === 'after' && headers.get('x-demo-test') === selectedRule.desired.marker;
    if (module === 'bot') blocked &&= botMode !== 'missing' && botMode !== 'unchanged';
    if (module === 'rate-limit' && blocked) { if (now() >= rateStart + rate.ratelimit.period * 1000) { rateStart = now(); rateCount = 0; } blocked = now() < blockedUntil || ++rateCount > rate.ratelimit.requests_per_period; if (blocked) blockedUntil = now() + rate.ratelimit.mitigation_timeout * 1000; }
    if (!blocked) receipts.push({ schemaVersion: 1, id: randomUUID(), runId, requestId, scenarioId: module, targetRole: env.role, producerId: `${env.role}-fixture`, sequence: receipts.filter(r => r.runId === runId && r.targetRole === env.role).length + 1, observedAt: time, rayId: ray, releaseDigest: env.releaseDigest, stage: 'entry' });
    if (blocked) event = { datetime: time, rayName: ray, action: 'block', source: module === 'rate-limit' ? 'ratelimit' : 'firewallrules', ruleId: selectedRule.id, clientRequestHTTPHost: new URL(env.origin).hostname, ...(module === 'bot' && botMode !== 'score-hidden' ? { botScore: 5 } : {}) };
    return new Response(blocked ? 'Synthetic edge observation' : 'Synthetic storefront', { status: blocked ? module === 'rate-limit' ? 429 : 403 : 200, headers: { 'content-type': 'text/html', 'cf-ray': `${ray}-DFW`, 'x-lab-role': env.role, 'x-lab-release': env.releaseDigest, 'x-lab-services': 'd1,r2,images-reference,container-completed' } });
  };
  return { config, intent, inventory, credentials, dispatch, calls, canary, targets: () => targetCount };
}
