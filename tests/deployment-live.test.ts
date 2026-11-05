import { botConfigurationReason } from '../packages/demo-core/src/bot-policy.js';
import { desiredRateLimit, inspectRateLimit } from '../packages/demo-core/src/rate-policy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import { LiveSetupExecutor, derivedServiceSecrets } from '../packages/demo-core/src/deployment-live.js';
import { freezeSource, verifyFrozenSource } from '../packages/demo-core/src/deployment-source.js';
import { prepareTerraformPlans } from '../packages/demo-core/src/terraform-plan.js';
import { createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { applyReviewedPlan } from '../packages/demo-core/src/deployment-apply.js';
import { DeploymentStore } from '../packages/demo-core/src/deployment-store.js';
import { SYNTHETIC_IMAGE_BASE64 } from '../packages/demo-core/src/infrastructure.js';
import type { DeploymentTools } from '../packages/demo-core/src/deployment-tools.js';
import { deploymentIntent, FIXTURE_CREDENTIALS, minimalSourceTree, rawTerraformPlan } from './fixtures/deployment.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
import { desiredCustomWaf, inspectCustomWaf, type CustomWafRuleset } from '../packages/demo-core/src/custom-waf.js';
import { TEST_SECRET, TEST_SITEKEY } from '../packages/contracts/src/turnstile-test.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function rootFixture() {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'live-executor-fixture-')); roots.push(root); minimalSourceTree(root); return root;
}
const envelope = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status === 200, result, errors: [] }), { status, headers: { 'content-type': 'application/json' } });
describe('deployment-live (all provider calls injected; no live qualification)', () => {
  it('freezes deploy sources and rejects modified snapshots', () => {
    const root = rootFixture(); const intent = deploymentIntent(root); const frozen = freezeSource(root, intent.discovery.evidenceDirectory);
    expect(verifyFrozenSource(root, intent.discovery.evidenceDirectory, frozen.digest)).toBe(frozen.path);
    writeFileSync(join(root, 'apps/storefront-worker/src/deployed.ts'), 'export default { changed: true };');
    expect(readFileSync(join(frozen.path, 'apps/storefront-worker/src/deployed.ts'), 'utf8')).not.toContain('changed');
    writeFileSync(join(frozen.path, 'apps/storefront-worker/src/deployed.ts'), 'tampered');
    expect(() => verifyFrozenSource(root, intent.discovery.evidenceDirectory, frozen.digest)).toThrow('integrity');
  });
  it('rejects foreign existing DNS and database names without any mutation', async () => {
    const root = rootFixture(); const intent = deploymentIntent(root); let writes = 0;
    for (const foreign of ['dns', 'database']) {
      const dispatch = vi.fn(async (value: string, init: RequestInit) => {
        if (init.method !== 'GET') writes++;
        const path = new URL(value).pathname;
        if (path.endsWith('/d1/database')) return envelope(foreign === 'database' ? [{ uuid: 'foreign', name: `${intent.discovery.labId}-before-storefront` }] : []);
        if (path.endsWith('/r2/buckets')) return envelope({ buckets: [] });
        if (path.endsWith('/images/v1/variants')) return envelope({ variants: {} });
        if (path.endsWith('/dns_records')) return envelope([{ id: 'foreign', name: 'before.example.test', type: 'A' }]);
        return envelope([]);
      });
      const api = new DeploymentApi(root, intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, dispatch);
      await expect(api.assertNoForeignCollisions()).rejects.toThrow(foreign === 'database' ? 'D1' : 'DNS'); api.close();
    }
    expect(writes).toBe(0);
  });
  it.each(['null', 'omitted', 'empty'] as const)('accepts successful setup read envelopes with %s errors while retaining collision checks', async errorShape => {
    const root = rootFixture(); const intent = deploymentIntent(root); const calls: string[] = [];
    const dispatch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.method).toBe('GET'); calls.push(new URL(url).pathname);
      const result = url.includes('/r2/buckets') ? { buckets: [] } : url.endsWith('/images/v1/variants') ? { variants: {} } : [];
      return Response.json({ success: true, result, ...(errorShape === 'omitted' ? {} : { errors: errorShape === 'null' ? null : [] }) });
    });
    const api = new DeploymentApi(root, intent, FIXTURE_CREDENTIALS.reader, FIXTURE_CREDENTIALS.deployer, dispatch);
    try { await expect(api.assertNoForeignCollisions()).resolves.toBeUndefined(); expect(calls).toHaveLength(8); }
    finally { api.close(); }
  });
  it.each(['core', 'core-waf', 'waf-signatures', 'rate-limit', 'bot', 'shared-api', 'unowned-variant', 'retained-core', 'public-readonly', 'public-wrong-output', 'turnstile-test'] as const)('enforces concrete %s setup gates; no recheck plan is applied', async selected => {
    const publicMode = selected === 'public-readonly' || selected === 'public-wrong-output';
    const retainedCore = selected === 'retained-core' || publicMode;
    const profile = selected === 'shared-api' ? 'core-waf' : selected === 'unowned-variant' || selected === 'retained-core' || selected === 'public-readonly' || selected === 'public-wrong-output' || selected === 'turnstile-test' ? 'core' : selected;
    const credentials = { ...FIXTURE_CREDENTIALS };
    const root = rootFixture(); const now = Date.now(); const intent = deploymentIntent(root, now); intent.discovery.labId = 'workshop-test'; intent.profile = profile;
    if (selected === 'turnstile-test') intent.turnstile = { mode: 'test' };
    if (selected === 'shared-api') {
      intent.discovery.credentials.apiTokenMode = 'shared';
      intent.discovery.credentials.reader = intent.discovery.credentials.deployer = 'env:LAB_API_TOKEN';
      credentials.deployer = credentials.reader;
    }
    const inventory = infrastructureFixture().inventory;
    if (publicMode) {
      intent.discovery.imageVariant = { source: 'existing-public-readonly', id: 'public', options: { fit: 'cover', width: 320, height: 240, metadata: 'keep' }, neverRequireSignedURLs: true };
      if (selected === 'public-readonly') { inventory.image_variant = 'public'; inventory.image_variant_source = 'existing-public-readonly'; }
    }
    const retainedPath = join(intent.discovery.evidenceDirectory, 'deployment/work', intent.discovery.labId, 'core/terraform.tfstate');
    let retainedBytes: string | undefined;
    if (retainedCore) {
      mkdirSync(join(retainedPath, '..'), { recursive: true });
      retainedBytes = JSON.stringify({ version: 4, terraform_version: '1.17.1', serial: 6, lineage: '12345678-9abc-0def-1234-56789abcdef0', outputs: {}, resources: [
        { mode: 'managed', type: 'cloudflare_d1_database', name: 'storefront', provider: 'provider["registry.terraform.io/cloudflare/cloudflare"]', instances: (['before', 'after'] as const).map(role => ({ index_key: role, schema_version: 500, attributes: { account_id: inventory.account_id, id: inventory.environments[role].database_id, name: inventory.environments[role].database_name }, sensitive_attributes: [] })) },
        { mode: 'managed', type: 'cloudflare_r2_bucket', name: 'storefront', provider: 'provider["registry.terraform.io/cloudflare/cloudflare"]', instances: (['before', 'after'] as const).map(role => ({ index_key: role, schema_version: 500, attributes: { account_id: inventory.account_id, id: inventory.environments[role].bucket_name, name: inventory.environments[role].bucket_name }, sensitive_attributes: [] })) },
      ], check_results: null });
      writeFileSync(retainedPath, retainedBytes);
    }
    const files = new Map<string, unknown>(); const applied: string[] = []; const calls: string[] = []; const stdin: string[] = []; const deployed = new Map<string, any>();
    const tools: DeploymentTools = {
      verifyVersions: vi.fn(async () => {}), close: vi.fn(async () => {}),
      terraform: vi.fn(async (args: readonly string[], cwd: string) => {
        calls.push(`tf:${args[0]}`); const kind = cwd.endsWith('/core') ? 'terraform-core' : 'terraform-routing';
        if (args[0] === 'init') return 'initialized';
        if (args[0] === 'plan') {
          const path = args.find(a => a.startsWith('-out='))!.slice(5); writeFileSync(path, `fixture-binary-${kind}`);
          const raw = rawTerraformPlan(intent, kind);
          if (retainedCore && kind === 'terraform-core') for (const change of raw.resource_changes) {
            if (change.address === 'cloudflare_image_variant.catalog') continue;
            const role = change.address.endsWith('["before"]') ? 'before' : 'after';
            change.change.actions = ['no-op']; change.change.after.id = change.address.startsWith('cloudflare_d1_database') ? inventory.environments[role].database_id : inventory.environments[role].bucket_name;
            change.change.before = { ...change.change.after };
          }
          files.set(path, raw); return 'planned';
        }
        if (args[0] === 'show') return JSON.stringify(files.get(args[2]!));
        if (args[0] === 'output') return JSON.stringify(inventory);
        throw new Error('Unexpected tool call');
      }),
      applyTerraform: vi.fn(async (path: string) => { expect(path).not.toContain('.recheck'); applied.push(path); }),
      wrangler: vi.fn(async (args: readonly string[], _cwd: string, _signal: AbortSignal, input?: string) => {
        calls.push(`wrangler:${args.slice(0, 3).join(':')}`);
        expect(args).not.toContain('--yes');
        const file = args[args.indexOf('--config') + 1]!; const config = JSON.parse(readFileSync(file, 'utf8'));
        expect(config.workers_dev).toBe(false); expect(config.main).toContain('/deployment/source/');
        if (args[0] === 'deploy') deployed.set(config.vars.ROLE ?? 'telemetry', config);
        if (publicMode && config.vars.ROLE) {
          expect(JSON.parse(config.vars.IMAGE_ASSET_JSON)).toMatchObject({ variant: 'public', id: inventory.environments[config.vars.ROLE as 'before' | 'after'].image_id });
          expect(JSON.parse(config.vars.IMAGE_VARIANT_SELECTION_JSON)).toEqual(intent.discovery.imageVariant);
        }
        if (input) stdin.push(input); return 'completed fixture operation';
      }),
    };
    const botSettings = { auto_update_model: true, bm_cookie_enabled: true, enable_js: false, suppress_session_score: false, using_latest_model: true };
    const imageMetadata = new Map<string, unknown>(); let httpWrites = 0;
    let policy: CustomWafRuleset | null = null; let ratePolicy: any = null;
    const dispatch = vi.fn(async (value: string, init: RequestInit) => {
      const u = new URL(value); const path = u.pathname;
      if (u.origin === 'https://api.cloudflare.com') {
        if (path.includes('/images/v1/variants')) expect(init.method).toBe('GET');
        if (path.endsWith('/bot_management')) return envelope(botSettings);
        if (path.endsWith('/rulesets/phases/http_ratelimit/entrypoint')) return envelope(ratePolicy, ratePolicy ? 200 : 404);
        if (path.endsWith('/rulesets/phases/http_request_firewall_custom/entrypoint')) return envelope(policy, policy ? 200 : 404);
        if (path.endsWith('/rulesets') && init.method === 'POST') {
          httpWrites++; const body = JSON.parse(init.body as string);
          if (body.phase === 'http_ratelimit') { ratePolicy = { id: 'c'.repeat(32), kind: body.kind, phase: body.phase, version: '1', rules: [{ id: 'f'.repeat(32), ...body.rules[0] }] }; return envelope(ratePolicy); }
          expect(['core-waf', 'waf-signatures', 'rate-limit', 'bot']).toContain(profile); expect(body.rules).toHaveLength(1);
          policy = { id: 'b'.repeat(32), kind: body.kind, phase: body.phase, version: '1', rules: [{ id: 'd'.repeat(32), ...body.rules[0] }] };
          return envelope(policy);
        }
        if (path.endsWith('/rules') && init.method === 'POST' && policy) {
          httpWrites++; const body = JSON.parse(init.body as string); policy = { ...policy, version: String(Number(policy.version) + 1), rules: [...policy.rules, { id: ['e', 'f'][policy.rules.length - 1]!.repeat(32), ...body }] }; return envelope(policy);
        }
        if (path.endsWith('/d1/database')) return envelope(retainedCore ? Object.values(inventory.environments).map(e => ({ uuid: e.database_id, name: e.database_name })) : []);
        if (path.endsWith('/r2/buckets')) return envelope({ buckets: retainedCore ? Object.values(inventory.environments).map(e => ({ name: e.bucket_name })) : [] });
        if (path.endsWith('/images/v1/variants')) return envelope({ variants: publicMode ? { public: { id: 'public', options: intent.discovery.imageVariant!.options, neverRequireSignedURLs: intent.discovery.imageVariant!.neverRequireSignedURLs } } : selected === 'unowned-variant' ? { [inventory.image_variant]: { id: inventory.image_variant, options: { fit: 'contain', width: 64, height: 64, metadata: 'none' }, neverRequireSignedURLs: false } } : {} });
        if (publicMode && path.endsWith('/images/v1/variants/public')) return envelope({ id: 'public', options: intent.discovery.imageVariant!.options, neverRequireSignedURLs: intent.discovery.imageVariant!.neverRequireSignedURLs });
        if (path.endsWith('/workers/scripts') || path.endsWith('/workers/domains') || path.endsWith('/dns_records')) return envelope([]);
        if (path.endsWith('/images/v1') && init.method === 'POST') {
          httpWrites++; const form = init.body as FormData; const id = form.get('id') as string;
          const meta = JSON.parse(form.get('metadata') as string); imageMetadata.set(id, meta);
          expect(Buffer.from(await (form.get('file') as Blob).arrayBuffer()).toString('base64')).toBe(SYNTHETIC_IMAGE_BASE64);
          return envelope({ id, meta, variants: [`https://imagedelivery.net/fixture-account/${id}/${inventory.image_variant}`] });
        }
        if (path.includes('/images/v1/')) { const id = path.split('/').at(-1)!; return imageMetadata.has(id) ? envelope({ id, meta: imageMetadata.get(id), variants: [`https://imagedelivery.net/fixture-account/${id}/${inventory.image_variant}`] }) : envelope(null, 404); }
        if (path.includes('/d1/database/')) { const id = path.split('/').at(-1); const found = Object.values(inventory.environments).find(e => e.database_id === id)!; return envelope({ uuid: id, name: found.database_name }); }
      }
      if (u.origin === 'https://imagedelivery.net') { expect(init.headers).toEqual({ accept: 'image/png' }); return new Response(Buffer.from(SYNTHETIC_IMAGE_BASE64, 'base64'), { headers: { 'content-type': 'image/png' } }); }
      if (path === '/internal/seed') { httpWrites++; const role = u.hostname.startsWith('before.') ? 'before' : 'after'; expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${derivedServiceSecrets(FIXTURE_CREDENTIALS.setup, intent.discovery.labId, role).SETUP_SECRET}`); return new Response(JSON.stringify({ seeded: true, role, detailDigest: 'a'.repeat(64) })); }
      if (path === '/catalog') { const role = u.hostname.startsWith('before.') ? 'before' : 'after'; return new Response('Synthetic storefront fixture', { headers: { 'x-lab-role': role, 'x-lab-release': intent.releaseDigest, 'x-lab-services': 'd1,r2,images-reference,container-completed' } }); }
      throw new Error(`Unregistered fixture endpoint: ${path}`);
    });
    const capability = await discoverCapabilities(intent.discovery, profile, { mode: 'live', inspect: async key => ({ state: 'available', source: 'fixture-injected-production-branch', reasons: key === 'bot-management' ? [botConfigurationReason(botSettings)] : [] }) });
    const source = freezeSource(root, intent.discovery.evidenceDirectory);
    const artifacts = await prepareTerraformPlans(root, intent, tools, undefined, source.path);
    const api = new DeploymentApi(root, intent, credentials.reader, credentials.deployer, dispatch);
    const modules = profile === 'bot' ? ['waf-custom', 'bot'] as const : profile === 'waf-signatures' ? ['waf-custom', 'waf-sqli', 'waf-xss'] as const : ['core-waf', 'rate-limit'].includes(profile) ? ['waf-custom'] as const : [];
    const productStates = await Promise.all(modules.map(async module => (await inspectCustomWaf(api.customWaf(undefined, module), desiredCustomWaf(intent.discovery.labId, intent.discovery.environments[1].origin, module))).state));
    if (profile === 'rate-limit') productStates.push((await inspectRateLimit(api.rateLimit(), desiredRateLimit(intent.discovery.labId, intent.discovery.environments[1].origin))).state);
    api.close();
    const plan = createDeploymentPlan(intent, capability, source.digest, root, Date.now(), ['core', 'waf-custom', 'waf-sqli', 'waf-xss', 'rate-limit', 'bot'], artifacts, productStates);
    expect(plan.blockers).toEqual([]);
    const store = new DeploymentStore(root, intent.discovery.evidenceDirectory); const saved = store.save(plan);
    store.approve(saved.planPath, `APPROVE ${saved.digest}`, true);
    const result = await applyReviewedPlan(store, saved.planPath, { intent, capability, sourceDigest: source.digest, credentials, createExecutor: async () => new LiveSetupExecutor(root, plan, credentials, { tools, dispatch }) });
    if (selected === 'unowned-variant') {
      expect(result.status).toBe('failed'); expect(result.completedSteps).toEqual([]); expect(result.resources).toEqual([]);
      expect(applied).toEqual([]); expect(httpWrites).toBe(0); expect(stdin).toEqual([]); expect(calls.some(c => c.startsWith('wrangler:'))).toBe(false);
      return;
    }
    if (selected === 'public-wrong-output') {
      expect(result.status).toBe('failed'); expect(result.completedSteps).toEqual([]);
      expect(result.resources).toEqual([expect.objectContaining({ kind: 'terraform-apply', id: 'workshop-test-terraform-core', certainty: 'confirmed' })]);
      expect(applied).toHaveLength(1); expect(httpWrites).toBe(0); expect(stdin).toEqual([]);
      expect(readFileSync(retainedPath, 'utf8')).toBe(retainedBytes); return;
    }
    expect(result.status).toBe('succeeded');
    if (retainedCore) {
      expect(readFileSync(retainedPath, 'utf8')).toBe(retainedBytes);
      const changes = artifacts.find(a => a.kind === 'terraform-core')!.changes;
      expect(changes.filter(c => c.actions[0] === 'no-op')).toHaveLength(4); expect(changes.filter(c => c.actions[0] === 'create')).toHaveLength(publicMode ? 0 : 1);
    }
    if (publicMode) {
      expect(plan.steps.flatMap(step => step.resources)).not.toContain('public');
      expect(result.resources.some(r => r.kind === 'images-variant')).toBe(false);
      expect(dispatch.mock.calls.filter(([url]) => url.includes('/images/v1/variants')).every(([, init]) => init.method === 'GET')).toBe(true);
    }
    expect(result.resources.some(r => r.kind === 'd1-database' && r.id === inventory.environments.before.database_id && r.certainty === 'confirmed')).toBe(true);
    expect(applied).toHaveLength(2); expect(httpWrites).toBe(profile === 'waf-signatures' ? 7 : ['rate-limit', 'bot'].includes(profile) ? 6 : profile === 'core-waf' ? 5 : 4); expect(stdin).toHaveLength(3);
    expect(calls.filter(c => c.startsWith('wrangler:deploy'))).toHaveLength(3); expect(calls.filter(c => c.startsWith('wrangler:d1:migrations'))).toHaveLength(2);
    expect(stdin.join('')).not.toContain(FIXTURE_CREDENTIALS.setup); expect(stdin.join('')).not.toContain(FIXTURE_CREDENTIALS.deployer); expect(stdin.join('')).toContain(FIXTURE_CREDENTIALS.runner);
    const runtime = join(intent.discovery.evidenceDirectory, 'deployment/runtime', plan.id);
    const generated = JSON.parse(readFileSync(join(runtime, 'runtime-config.json'), 'utf8'));
    if (selected === 'turnstile-test') {
      expect(JSON.parse(deployed.get('after').vars.TURNSTILE_CONFIG_JSON)).toEqual({ mode: 'test', sitekey: TEST_SITEKEY, hostname: new URL(intent.discovery.environments[1].origin).hostname, action: 'register' });
      expect(JSON.parse(deployed.get('before').vars.TURNSTILE_CONFIG_JSON)).toMatchObject({ mode: 'disabled', sitekey: null });
      expect(JSON.parse(stdin[0]!).TURNSTILE_SECRET).toBeUndefined(); expect(JSON.parse(stdin[1]!).TURNSTILE_SECRET).toBe(TEST_SECRET);
      expect(generated.demonstrations.turnstile.expectedAfter).toMatchObject({ mode: 'test', sitekey: TEST_SITEKEY });
    } else { expect(deployed.get('after').vars.TURNSTILE_CONFIG_JSON).toBeUndefined(); expect(generated.demonstrations).toBeUndefined(); }
    if (publicMode) {
      expect(generated.imageVariant).toEqual(intent.discovery.imageVariant);
      expect(generated.inventory.some((item: any) => item.id === 'public')).toBe(false);
      for (const role of ['before', 'after'] as const) expect(generated.environments.find((e: any) => e.role === role)).toMatchObject({ imageIds: [inventory.environments[role].image_id], d1Id: inventory.environments[role].database_id, r2Bucket: inventory.environments[role].bucket_name });
    }
    expect(generated.inventory.filter((item: any) => item.type === 'policy')).toHaveLength(modules.length + (profile === 'rate-limit' ? 1 : 0));
    const persisted = readdirSync(runtime).map(file => readFileSync(join(runtime, file), 'utf8')).join('');
    for (const secret of Object.values(FIXTURE_CREDENTIALS)) expect(persisted).not.toContain(secret);
    expect(JSON.parse(readFileSync(join(runtime, 'deployment.json'), 'utf8')).claims).toEqual({ coreDeployed: true, interviewVerified: false, workshopVerified: false });
  });
});
