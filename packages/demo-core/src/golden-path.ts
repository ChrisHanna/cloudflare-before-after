import { z } from 'zod';
import { existsSync, lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { performance } from 'node:perf_hooks';
import { runLabCli, type LabCliDependencies } from './lab-cli.js';
import { runDemoCli, type DemoCliDependencies } from './demo-cli.js';
import { ApplyRecordSchema, DeploymentStore } from './deployment-store.js';
import { SnapshotSchema } from './capabilities.js';
import { DoctorSchema } from './doctor.js';
import { ReportSchema, ReportStore } from './reports.js';
import { validateLabConfig, validateTarget, validateEvidenceDirectory } from './config.js';
import { BudgetLedger } from './budget.js';
import { boundedBytes } from './deployment-http.js';
import { resolveDemoCredentials } from './demo-cli.js';
import { GuardedClient, type Dispatch } from './transport.js';
import { ImageAssetSchema } from '../../../apps/storefront-worker/src/assets.js';
import { collectTrustedImage } from './trusted-collectors-image.js';
import { SYNTHETIC_IMAGE_DIGEST } from './infrastructure.js';
import { digestValue, IntentSchema, type DeploymentPlan } from './deployment-plan.js';
import { loadRuntimeConfig } from './runtime-config.js';
import type { LabConfig } from './config.js';
import { startControlServer } from '../../../apps/control-server/src/server.js';

export const GOLDEN_STAGES = ['checkout', 'plan', 'apply', 'doctor', 'command-center', 'comparison', 'export', 'repeatability'] as const;
export interface GoldenPathOptions {
  projectRoot: string; checkoutRoot: string; mode: 'fixture' | 'live';
  lab: Omit<LabCliDependencies, 'projectRoot'>;
  demo: Omit<DemoCliDependencies, 'projectRoot' | 'mode'>;
  liveOptIn?: boolean;
  /** Approval uses runLabCli's exact-plan interactive confirmation, never a boolean approval. */
  requestApproval?: boolean;
  /** Bound output scans to known synthetic canaries; never return their values. */
  canaries?: readonly string[];
  /** Launch only an installed, runner-owned browser. Never download a binary. */
  launchBrowser?: () => Promise<Browser>;
  /** Resume only the actual saved plan returned by an approval pause. */
  resumePlanPath?: string;
  /** Transport-backed seed/inventory observations, not caller success flags. */
  convergence?: (config: LabConfig, plan: DeploymentPlan) => Promise<unknown>;
}
export const GoldenConvergenceSchema = z.strictObject({
  mode: z.enum(['fixture', 'live']), labId: z.string(), accountId: z.string(), zoneId: z.string(),
  observedAt: z.iso.datetime(),
  resources: z.array(z.strictObject({ role: z.enum(['before', 'after']), type: z.enum(['worker', 'container', 'd1', 'r2', 'image']), id: z.string().min(1) })).min(10).max(100),
  seeds: z.array(z.strictObject({ role: z.enum(['before', 'after']), catalogCount: z.number().int().positive(), objectCount: z.number().int().positive(), catalogDigest: z.string().regex(/^[a-f0-9]{64}$/), objectDigest: z.string().regex(/^[a-f0-9]{64}$/), imageDigest: z.string().regex(/^[a-f0-9]{64}$/) })).length(2),
});
/** Unknown counts cannot be promoted from declared bindings or seed replies. */
export function validateGoldenConvergence(input: unknown, config: LabConfig, mode: 'fixture' | 'live', since: number) {
  const value = GoldenConvergenceSchema.parse(input);
  if (value.mode !== mode || value.labId !== config.labId || value.accountId !== config.accountId || value.zoneId !== config.zoneId || Date.parse(value.observedAt) < since || Date.parse(value.observedAt) > Date.now()) throw new Error('Foreign or stale convergence observation');
  const keys = value.resources.map(r => `${r.role}:${r.type}:${r.id}`);
  const expected = config.inventory.filter(r => ['worker', 'container', 'd1', 'r2', 'image'].includes(r.type)).map(r => `${r.role}:${r.type}:${r.id}`);
  if (new Set(keys).size !== keys.length || digestValue([...keys].sort()) !== digestValue(expected.sort()) || new Set(value.seeds.map(s => s.role)).size !== 2) throw new Error('Resource ownership or seed roles differ');
  const [before, after] = [...value.seeds].sort((a, b) => a.role.localeCompare(b.role));
  if (digestValue({ ...before, role: null }) !== digestValue({ ...after, role: null })) throw new Error('Seed content differs across environments');
  return { resources: [...value.resources].sort((a, b) => `${a.role}:${a.type}:${a.id}`.localeCompare(`${b.role}:${b.type}:${b.id}`)), seeds: [...value.seeds].sort((a, b) => a.role.localeCompare(b.role)) };
}
// Application-owned boundary for call 5 to implement. This is NOT a claimed
// Cloudflare provider API. Until that route exists the real reader fails closed.
export const GoldenSeedInventorySchema = z.strictObject({
  schemaVersion: z.literal(1), source: z.literal('owned-seed-inventory/v1'),
  runId: z.uuid(), requestId: z.uuid(), role: z.enum(['before', 'after']),
  labId: z.string(), releaseDigest: z.string().regex(/^[a-f0-9]{64}$/), observedAt: z.iso.datetime(),
  databaseId: z.string(), bucketName: z.string(),
  catalogCount: z.number().int().positive().max(10000), objectCount: z.number().int().positive().max(10000),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/), objectDigest: z.string().regex(/^[a-f0-9]{64}$/),
  image: ImageAssetSchema,
});
/** Reads fresh counts at an authenticated Worker boundary, independent binding
 * readback, owned image metadata and real decoded image bytes. No success flags,
 * arbitrary URLs, caller counters, seed POSTs or replayed reports are accepted.
 */
export async function collectGoldenConvergence(config: LabConfig, mode: 'fixture' | 'live', credentials: ReturnType<typeof resolveDemoCredentials>, dispatch: Dispatch = fetch) {
  const ledger = new BudgetLedger({ limits: { requests: 30, concurrency: 2, sessions: 2, maxRuntimeMs: 60000, cleanupRequests: 0, cleanupMs: 0 } });
  const since = Date.now(); const runId = randomUUID();
  const owned = new Set(config.inventory.map(r => `${r.type}:${r.role}:${r.id}`));
  const client = new GuardedClient(config, ledger, { observedOwnedResources: owned, dispatch });
  const resources: z.infer<typeof GoldenConvergenceSchema>['resources'] = [];
  const seeds: z.infer<typeof GoldenConvergenceSchema>['seeds'] = [];
  const providerRead = async <S extends z.ZodType>(path: string, schema: S) => {
    const response = await client.requestJson({ kind: 'cloudflare', url: `${config.apiOrigin}/client/v4${path}`, headers: { authorization: `Bearer ${credentials.reader}` }, retries: 0 }, z.object({ success: z.literal(true), result: schema }), ledger.signal);
    if (response.status !== 200) throw new Error('Golden path requires independent binding and image readback');
    return schema.parse(Reflect.get(response.data, 'result'));
  };
  try {
    for (const env of config.environments) {
      const requestId = randomUUID();
      const read = await client.requestJson({ kind: env.role, url: `${env.origin}/internal/seed-inventory`, headers: { 'x-demo-run-id': runId, 'x-demo-request-id': requestId, 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': credentials.runner }, retries: 0 }, GoldenSeedInventorySchema, ledger.signal);
      const v = read.data;
      if (read.status !== 200 || v.runId !== runId || v.requestId !== requestId || v.role !== env.role || v.labId !== config.labId || v.releaseDigest !== env.releaseDigest || v.databaseId !== env.d1Id || v.bucketName !== env.r2Bucket || Date.parse(v.observedAt) < since || Date.parse(v.observedAt) > Date.now() || v.image.role !== env.role || v.image.labId !== config.labId || !env.imageIds.includes(v.image.id)) throw new Error('Golden path requires fresh scope-bound seed inventory');
      const settings = await providerRead(`/accounts/${config.accountId}/workers/scripts/${env.workerName}/settings`, z.object({ bindings: z.array(z.object({ name: z.string(), type: z.string(), id: z.string().optional(), database_id: z.string().optional(), bucket_name: z.string().optional(), namespace_id: z.string().optional() })).max(100) }));
      const binding = (name: string, type: string) => settings.bindings.filter(b => b.name === name && b.type === type);
      const db = binding('DB', 'd1'); const bucket = binding('OBJECTS', 'r2_bucket'); const origin = binding('ORIGINS', 'durable_object_namespace');
      if (db.length !== 1 || (db[0]!.database_id ?? db[0]!.id) !== env.d1Id || bucket.length !== 1 || bucket[0]!.bucket_name !== env.r2Bucket || origin.length !== 1 || !origin[0]!.namespace_id) throw new Error('Golden path requires matching live service bindings');
      const image = await providerRead(`/accounts/${config.accountId}/images/v1/${v.image.id}`, z.object({ id: z.string(), meta: z.object({ owner: z.string(), sourceDigest: z.string() }) }));
      if (image.id !== v.image.id || image.meta.owner !== `${config.labId}:${env.role}:immutable-catalog` || image.meta.sourceDigest !== SYNTHETIC_IMAGE_DIGEST) throw new Error('Golden path requires owned image metadata');
      const decoded = await collectTrustedImage({ config, ledger, mode, credentials, observedOwnedResources: owned, dispatch }, { role: env.role, runId, requestId, scenarioId: 'waf-custom', releaseDigest: env.releaseDigest, resourceId: v.image.id, deliveryAccount: v.image.accountHash, variant: v.image.variant }, ledger.signal);
      if (decoded.state !== 'observed' || !decoded.value || decoded.value.encodedDigest !== v.image.expectedDigest) throw new Error('Golden path requires owned decoded image evidence');
      for (const [type, id] of [['worker', env.workerName], ['container', env.containerBinding], ['d1', env.d1Id], ['r2', env.r2Bucket], ['image', image.id]] as const) resources.push({ role: env.role, type, id });
      seeds.push({ role: env.role, catalogCount: v.catalogCount, objectCount: v.objectCount, catalogDigest: v.catalogDigest, objectDigest: v.objectDigest, imageDigest: decoded.value.encodedDigest });
    }
    return GoldenConvergenceSchema.parse({ mode, labId: config.labId, accountId: config.accountId, zoneId: config.zoneId, observedAt: new Date().toISOString(), resources, seeds });
  } finally { ledger.stop('Convergence reads finished'); }
}
export interface GoldenPathResult {
  schemaVersion: 1; mode: 'fixture' | 'live';
  status: 'passed' | 'failed' | 'awaiting-approval' | 'unavailable';
  liveReadiness: false; stoppingStep: typeof GOLDEN_STAGES[number] | null;
  stages: { id: typeof GOLDEN_STAGES[number]; passed: boolean; detail: string }[];
  commands: { surface: 'lab' | 'demo' | 'local'; args: string[]; exitCode: number | null }[];
  planPath: string | null; runIds: string[]; durationMs: number; gaps: string[];
  checkpointPath: string | null;
}
/** Exercises real planners, approval/apply, CLI, journal API and report store.
 * Fixture providers replace only external services, not these production paths.
 * Live mode uses the default production readers/executor after explicit opt-in.
 * Unknown convergence or incomplete proof stops its exact stage, never passes.
 */
export async function runGoldenPath(o: GoldenPathOptions): Promise<GoldenPathResult> {
  const start = performance.now();
  const result: GoldenPathResult = { schemaVersion: 1, mode: o.mode, status: 'failed', liveReadiness: false, stoppingStep: 'checkout', stages: [], commands: [], planPath: null, runIds: [], durationMs: 0, gaps: [], checkpointPath: null };
  const startedAt = Date.now(); const checkpointId = randomUUID();
  let checkpointDirectory: string | undefined; let checkpointSequence = 0;
  const checkpoint = () => {
    if (!checkpointDirectory) return;
    mkdirSync(checkpointDirectory, { recursive: true, mode: 0o700 });
    const path = join(checkpointDirectory, `${++checkpointSequence}.json`);
    result.checkpointPath = path;
    writeFileSync(path, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
  };
  let config: LabConfig;
  let demo = { ...o.demo };
  let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let vite: ViteDevServer | undefined; let browser: Browser | undefined;
  let context: BrowserContext | undefined; let page: Page | undefined;
  let displayLedger: BudgetLedger | undefined;
  let stage: GoldenPathResult['stoppingStep'] = 'checkout';
  let setupAudit: (() => void) | undefined;
  const finish = () => { result.durationMs = performance.now() - start; return result; };
  const pass = (detail: string) => { result.stages.push({ id: stage!, passed: true, detail }); checkpoint(); };
  const scan = (text: string) => { if (o.canaries?.some(value => value && text.includes(value))) throw new Error('Secret canary reached output'); };
  const command = async (surface: 'lab' | 'demo', args: string[], expected = [0]) => {
    const response = surface === 'lab' ? await runLabCli(args, { ...o.lab, projectRoot: o.projectRoot }) : await runDemoCli(args, { ...demo, projectRoot: o.projectRoot, mode: o.mode });
    result.commands.push({ surface, args, exitCode: response.exitCode }); scan(response.output);
    setupAudit?.();
    if (!expected.includes(response.exitCode)) throw new Error(`Required command ${surface} ${args[0]} returned ${response.exitCode}`);
    return JSON.parse(response.output) as unknown;
  };
  try {
    z.enum(['fixture', 'live']).parse(o.mode);
    if (o.mode === 'live' && !o.liveOptIn) {
      result.status = 'unavailable'; result.gaps = ['Explicit live opt-in is missing']; return finish();
    }
    if (!isAbsolute(o.projectRoot) || !isAbsolute(o.checkoutRoot)) throw new Error('Absolute checkout roots required');
    const pkg = z.object({ packageManager: z.string(), engines: z.object({ node: z.string() }), scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(o.checkoutRoot, 'package.json'), 'utf8')));
    if (!pkg.packageManager.startsWith('pnpm@') || Number(process.versions.node.split('.')[0]) < 22 || !readFileSync(join(o.checkoutRoot, 'pnpm-lock.yaml'), 'utf8').includes('lockfileVersion:')) throw new Error('Checkout tool contract is invalid');
    const intent = o.mode === 'live' ? IntentSchema.parse((o.lab.loadConfig ?? (path => JSON.parse(readFileSync(path, 'utf8'))))(join(o.projectRoot, '.lab/intent.json'))) : null;
    if (intent && (!intent.discovery.liveOptIn || !intent.discovery.ownedLab || intent.profile !== 'core-waf')) throw new Error('Owned core-waf lab opt-in required');
    if (intent && o.lab.provider) {
      const provider = o.lab.provider(intent.discovery, 'user');
      try { if (provider.provider.mode !== 'live') { result.status = 'unavailable'; result.gaps = ['Fixture providers cannot qualify live execution']; return finish(); } }
      finally { provider.close(); }
    }
    const evidenceDirectory = intent?.discovery.evidenceDirectory ?? validateLabConfig(o.demo.loadConfig?.(), o.projectRoot).evidenceDirectory;
    for (const directory of ['runs', 'journal', 'readiness', 'deployment']) {
      const path = join(evidenceDirectory, directory);
      if (directory === 'deployment' && o.resumePlanPath) continue;
      if (existsSync(path) && readdirSync(path).length) throw new Error('Golden path requires fresh evidence and setup state');
    }
    if (existsSync(join(o.projectRoot, '.lab/runtime.json'))) throw new Error('Preexisting runtime configuration cannot satisfy a fresh run');
    validateEvidenceDirectory(evidenceDirectory, o.projectRoot);
    checkpointDirectory = join(evidenceDirectory, 'golden-path', checkpointId);
    if (o.mode === 'live') {
      // Explicit live activation only. No package runner and no downloads.
      // A failure is an installation failure, not a fixture pass.
      const home = join(checkpointDirectory, 'tool-home'); mkdirSync(home, { recursive: true, mode: 0o700 });
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: home, KIROCREW_SCRATCH: home, CI: 'true', NO_COLOR: '1', COREPACK_ENABLE_NETWORK: '0', npm_config_offline: 'true' };
      if (process.env.PNPM_STORE_DIR) env.npm_config_store_dir = process.env.PNPM_STORE_DIR;
      for (const [tool, args] of [['pnpm', ['install', '--offline', '--frozen-lockfile']], [process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']], [process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']], [process.execPath, ['node_modules/vite/bin/vite.js', 'build', 'apps/command-center']]] as const) {
        try {
          scan(String(execFileSync(tool, [...args], { cwd: o.checkoutRoot, env, timeout: 120000, maxBuffer: 65536, stdio: 'pipe' })));
          result.commands.push({ surface: 'local', args: [tool, ...args], exitCode: 0 });
        } catch (error) {
          const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : null;
          result.commands.push({ surface: 'local', args: [tool, ...args], exitCode: status });
          throw new Error('Golden path requires successful frozen installation and builds');
        }
      }
    }
    pass(o.mode === 'live' ? 'Frozen offline installation, build and fresh local configuration passed' : 'Fresh evidence directory, pinned checkout and local configuration validated; no install performed');
    stage = result.stoppingStep = 'plan';
    const capability = SnapshotSchema.parse(await command('lab', ['capabilities', '--profile', 'core-waf', '--json']));
    if (capability.mode !== o.mode || !capability.deployable) throw new Error('Capability scope or mode is unproven');
    const store = new DeploymentStore(o.projectRoot, evidenceDirectory);
    const resumed = o.resumePlanPath ? store.load(o.resumePlanPath) : null;
    const planned = z.object({ planPath: z.string().refine(isAbsolute), digest: z.string(), approvalState: z.literal('not-approved') }).parse(resumed ? { planPath: o.resumePlanPath, digest: resumed.digest, approvalState: 'not-approved' } : await command('lab', ['plan', '--profile', 'core-waf', '--json']));
    result.planPath = planned.planPath;
    const saved = store.load(planned.planPath);
    if (saved.digest !== planned.digest || saved.plan.mode !== o.mode || saved.plan.intent.profile !== 'core-waf' || saved.plan.blockers.length) throw new Error('Plan provenance mismatch');
    pass('Actual emitted planPath loaded and checked; optional exclusions retained');
    stage = result.stoppingStep = 'apply';
    if (!o.requestApproval) { result.status = 'awaiting-approval'; result.gaps.push('Exact saved-plan approval is required; no executor was created'); checkpoint(); return finish(); }
    await command('lab', ['approve', '--plan', planned.planPath, '--json']);
    const applied = z.object({ record: z.object({ status: z.literal('succeeded'), completedSteps: z.array(z.string()) }) }).parse(await command('lab', ['apply', '--plan', planned.planPath, '--json']));
    if (digestValue(applied.record.completedSteps) !== digestValue(saved.plan.steps.map(step => step.id))) throw new Error('Not every approved step completed');
    const attempts = () => {
      const files = readdirSync(store.directory).filter(file => file.endsWith('.attempt.json')).sort();
      if (files.length > 100) throw new Error('Setup audit exceeds its bound');
      return digestValue(files.map(file => {
        const path = join(store.directory, file); const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1048576) throw new Error('Invalid bounded setup audit');
        return { file, record: ApplyRecordSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) };
      }));
    };
    const setupDigest = attempts();
    setupAudit = () => { if (attempts() !== setupDigest) throw new Error('Setup execution changed after deployment'); };
    config = o.mode === 'live' ? loadRuntimeConfig(o.projectRoot, join(evidenceDirectory, 'deployment/runtime', saved.plan.id, 'runtime-config.json')) : validateLabConfig(o.demo.loadConfig?.(), o.projectRoot);
    if (config.labId !== saved.plan.intent.discovery.labId || config.accountId !== saved.plan.intent.discovery.accountId || config.zoneId !== saved.plan.intent.discovery.zoneId || config.environments.some(e => e.releaseDigest !== saved.plan.intent.releaseDigest || !saved.plan.intent.discovery.environments.some(t => t.role === e.role && t.origin === e.origin))) throw new Error('Applied runtime scope differs from approved plan');
    demo = { ...o.demo, loadConfig: () => config };
    pass('Exact approved plan applied through bounded setup execution');
    stage = result.stoppingStep = 'doctor';
    const scoped = z.object({ report: DoctorSchema }).parse(await command('demo', ['doctor', '--scope', 'core-waf', '--json'])).report;
    const catalog = z.object({ report: DoctorSchema }).parse(await command('demo', ['doctor', '--json'], [0, 1])).report;
    if (!scoped.preflightReady || scoped.scope !== 'core-waf' || scoped.mode !== o.mode || catalog.catalog.length !== 11 || catalog.catalog.some(c => c.state !== 'available') && catalog.preflightReady) throw new Error('Doctor hid missing prerequisites');
    pass('Scoped doctor passes; default doctor retains all eleven capability states');
    stage = result.stoppingStep = 'command-center';
    server = await startControlServer({ projectRoot: o.projectRoot, port: 0, demo: { ...demo, mode: o.mode } });
    const auth = await fetch(`${server.origin}/api/bootstrap/redeem`, { method: 'POST', headers: { origin: server.origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: server.control.issueBootstrap() }) });
    if (auth.status !== 200) throw new Error('Loopback authentication failed');
    const cookie = auth.headers.getSetCookie()[0]!.split(';')[0]!;
    const get = async (path: string) => { const response = await fetch(`${server!.origin}${path}`, { headers: { cookie, origin: server!.origin } }); if (!response.ok) throw new Error('Control read failed'); const text = await response.text(); scan(text); return JSON.parse(text); };
    const view = await get('/api/catalog');
    if (view.targets.length !== 2 || view.policies.length !== 11 || !view.targets.every((t: { origin: string; releaseDigest: string }) => config.environments.some(e => e.origin === t.origin && e.releaseDigest === t.releaseDigest))) throw new Error('Paired command-center configuration differs');
    vite = await createServer({ root: resolve(o.checkoutRoot, 'apps/command-center'), configFile: false,
      cacheDir: join(o.projectRoot, '.lab/golden-vite-cache'), logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: server.origin, changeOrigin: true, headers: { origin: server.origin } } } } });
    await vite.listen(); const address = vite.httpServer!.address();
    if (!address || typeof address === 'string') throw new Error('Loopback browser address missing');
    const presentationOrigin = `http://127.0.0.1:${address.port}`;
    browser = await (o.launchBrowser ?? (() => chromium.launch({ headless: true })))();
    context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: presentationOrigin, httpOnly: true, sameSite: 'Strict' }]);
    // UI refreshes cannot probe targets. Only explicit owned paired-tab loads
    // enter this separately bounded display scope. Local cookies never forward.
    const display = displayLedger = new BudgetLedger({ limits: { requests: 30, concurrency: 2, sessions: 2, maxRuntimeMs: 60000, cleanupRequests: 0, cleanupMs: 0 } });
    const displayRun = randomUUID();
    await context.route('**/*', async route => {
      if (new URL(route.request().url()).origin === presentationOrigin) { await route.continue(); return; }
      if (o.mode !== 'live') { await route.abort(); return; }
      let release: (() => void) | undefined;
      try {
        const url = new URL(route.request().url());
        const env = config.environments.find(e => e.origin === url.origin);
        validateTarget(config, url.href, env?.role ?? 'image');
        if (route.request().method() !== 'GET' || env && !['/', '/catalog'].includes(url.pathname)) throw new Error('Unapproved display request');
        release = await display.acquire();
        const headers = env ? { 'x-demo-run-id': displayRun, 'x-demo-request-id': randomUUID(), 'x-demo-scenario': 'waf-custom', 'x-demo-run-token': (demo.credentials ?? resolveDemoCredentials)(config).runner } : {};
        const response = await (demo.dispatch ?? fetch)(url.href, { method: 'GET', redirect: 'error', headers, signal: display.signal });
        const body = await boundedBytes(response, 1048576, display.signal);
        const safe: Record<string, string> = {};
        for (const name of ['content-type', 'content-security-policy', 'x-frame-options']) { const value = response.headers.get(name); if (value) safe[name] = value; }
        await route.fulfill({ status: response.status, headers: safe, body: Buffer.from(body) });
      } catch { await route.abort().catch(() => {}); }
      finally { release?.(); }
    });
    page = await context.newPage(); page.setDefaultTimeout(5000);
    await page.goto(presentationOrigin);
    await page.getByRole('combobox', { name: 'Recent runs', exact: true }).waitFor();
    for (const env of config.environments) {
      const panel = page.getByRole('article', { name: `${env.role === 'before' ? 'Before' : 'After'} storefront`, exact: true });
      await panel.getByText(env.origin, { exact: true }).waitFor();
      if (!(await panel.innerText()).includes(env.releaseDigest)) throw new Error('Browser release label differs');
    }
    scan(await page.locator('body').innerText());
    if (o.mode === 'live') {
      await page.getByLabel('Allow manual storefront view traffic', { exact: true }).check();
      await page.getByRole('button', { name: 'Use paired tabs', exact: true }).click();
      for (const role of ['Before', 'After']) {
        display.openSession();
        const popup = page.waitForEvent('popup');
        await page.getByRole('link', { name: `Open ${role} in tab ↗`, exact: true }).click();
        const storefront = await popup;
        try {
          await storefront.locator('main[data-storefront]').waitFor({ timeout: 5000 });
          await storefront.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
          if (!await storefront.locator('img').count()) throw new Error('Deployed image missing');
          scan(await storefront.locator('body').innerText());
        } finally { await storefront.close(); }
      }
    }
    display.stop('Paired view check complete');
    pass('Actual React page shows the configured pair; live mode loads bounded deployed paired tabs');
    stage = result.stoppingStep = 'comparison';
    const first = z.object({ report: ReportSchema }).parse(await command('demo', ['waf-custom', '--json'])).report;
    if (first.mode !== o.mode || first.result.outcome !== 'verified' || first.result.observedConfigDigest === null) throw new Error('Fresh custom-WAF proof is incomplete');
    if (Date.parse(first.result.startedAt) < startedAt || Date.parse(first.result.finishedAt) > Date.now()) throw new Error('Old or future report cannot satisfy this run');
    result.runIds.push(first.result.runId);
    const journal = await get('/api/journal-runs');
    if (!journal.runs.some((run: { actualRunId: string; readOnly: boolean }) => run.actualRunId === first.result.runId && run.readOnly)) throw new Error('Command center did not discover read-only CLI run');
    await page.getByRole('button', { name: 'Refresh local view', exact: true }).click();
    const recent = page.getByRole('combobox', { name: 'Recent runs', exact: true });
    await recent.locator(`option[value="${first.result.runId}"]`).waitFor({ state: 'attached' });
    await recent.selectOption(first.result.runId);
    await page.getByText('CLI-owned · read-only. Stop rights remain with its owner.', { exact: true }).waitFor();
    await page.getByRole('table', { name: 'Scripted HTTP observations', exact: true }).waitFor();
    if (!(await page.getByRole('button', { name: 'Stop run', exact: true }).isDisabled())) throw new Error('Browser took CLI stop rights');
    pass('Real CLI proof and read-only journal discovery share a fresh run ID');
    stage = result.stoppingStep = 'export';
    const reports = new ReportStore(o.projectRoot, config.evidenceDirectory);
    if (digestValue(reports.load(first.result.runId)) !== digestValue(first)) throw new Error('Saved JSON differs from CLI output');
    const html = reports.loadHtml(first.result.runId); scan(html);
    if (!html.includes(first.result.runId) || !html.includes('verified')) throw new Error('Readable report differs');
    const artifacts = reports.loadArtifacts(first.result.runId); scan(JSON.stringify(artifacts));
    if (artifacts.some(a => a.mode !== o.mode || a.runId !== first.result.runId || a.observedAt < first.result.startedAt || a.observedAt > first.result.finishedAt)) throw new Error('Old or foreign artifact cannot satisfy current proof');
    const discovered = (await get(`/api/journal-runs/${first.result.runId}`)).run;
    if (digestValue(discovered.result.report) !== digestValue(first) || digestValue(discovered.artifacts) !== digestValue(artifacts)) throw new Error('Journal and immutable report evidence differ');
    for (const role of ['before', 'after'] as const) {
      const evidence = discovered.evidence.roles.find((row: { role: string }) => row.role === role);
      if (!evidence) throw new Error('Paired browser evidence missing');
      const panel = page.getByRole('article', { name: `${role === 'before' ? 'Before' : 'After'} evidence counts`, exact: true });
      for (const [label, expected] of [['Requests', evidence.requests], ['Origin received', evidence.originReceived], ['Origin absent', evidence.originAbsent], ['Origin unknown', evidence.originUnknown], ['Edge events', evidence.edgeEvents], ['Rule IDs', evidence.rules]] as const) {
        if ((await panel.locator(`[data-count="${label}"]`).innerText()) !== String(expected ?? 'Unknown')) throw new Error('Browser and collected counts differ');
      }
      for (const action of evidence.actions) {
        const row = panel.getByRole('row').filter({ hasText: action.ruleId ?? 'Unknown' });
        if (await row.count() !== 1 || !(await row.innerText()).includes(action.product) || !(await row.innerText()).includes(action.action)) throw new Error('Browser edge action or rule differs');
      }
    }
    const inspection = await page.getByRole('region', { name: 'Policy inspection', exact: true }).getByRole('link', { name: 'Inspect in Cloudflare ↗', exact: true }).getAttribute('href');
    const inspectionUrl = new URL(inspection ?? '');
    if (inspectionUrl.origin !== 'https://dash.cloudflare.com' || inspectionUrl.username || inspectionUrl.password || inspectionUrl.pathname !== '/' || inspectionUrl.searchParams.size !== 1 || inspectionUrl.searchParams.get('to') !== '/:account/:zone/security/security-rules' || inspectionUrl.hash) throw new Error('Policy inspection link is unsafe');
    scan(await page.locator('body').innerText());
    if (!artifacts.some(a => a.source === 'cloudflare') || !artifacts.some(a => a.source === 'origin')) throw new Error('Linked proof artifacts missing');
    pass('Immutable JSON/HTML and artifact digests agree; seeded canaries absent');
    stage = result.stoppingStep = 'repeatability';
    const priorEvidence = digestValue({ report: reports.load(first.result.runId), html: reports.loadHtml(first.result.runId), artifacts: reports.loadArtifacts(first.result.runId) });
    const convergenceStart = Date.now();
    // Live proof always comes through the real bounded default readers. A
    // callback or serialized assertion can only supply explicitly fixture data.
    const collect = () => o.mode === 'fixture' && o.convergence ? o.convergence(config, saved.plan) : collectGoldenConvergence(config, o.mode, (demo.credentials ?? resolveDemoCredentials)(config), demo.dispatch ?? fetch);
    const beforeConvergence = validateGoldenConvergence(await collect(), config, o.mode, convergenceStart);
    const second = z.object({ report: ReportSchema }).parse(await command('demo', ['waf-custom', '--json'])).report;
    if (second.mode !== o.mode || second.result.outcome !== 'verified' || second.result.runId === first.result.runId || second.result.observedConfigDigest !== first.result.observedConfigDigest || second.result.releaseDigest !== first.result.releaseDigest || second.result.cleanup === 'incomplete') throw new Error('Fresh repeated proof differs or cleanup is unfinished');
    if (Date.parse(second.result.startedAt) < Date.parse(first.result.finishedAt) || Date.parse(second.result.finishedAt) > Date.now()) throw new Error('Old or future repeated run cannot satisfy proof');
    result.runIds.push(second.result.runId); reports.load(second.result.runId); reports.loadArtifacts(second.result.runId); reports.load(first.result.runId);
    const again = z.object({ planPath: z.string() }).parse(await command('lab', ['plan', '--profile', 'core-waf', '--json']));
    const repeated = store.load(again.planPath).plan;
    if (digestValue(repeated.steps) !== digestValue(saved.plan.steps) || repeated.intentDigest !== saved.plan.intentDigest) throw new Error('Unchanged planning accumulated operations');
    if (priorEvidence !== digestValue({ report: reports.load(first.result.runId), html: reports.loadHtml(first.result.runId), artifacts: reports.loadArtifacts(first.result.runId) })) throw new Error('Prior immutable evidence changed');
    const afterConvergence = validateGoldenConvergence(await collect(), config, o.mode, convergenceStart);
    if (digestValue(beforeConvergence) !== digestValue(afterConvergence)) throw new Error('Resource or seed inventory grew or changed');
    const unchangedArtifacts = repeated.preparedArtifacts.length === 2 && repeated.preparedArtifacts.every(a => a.changes.every(c => c.actions.every(action => action === 'no-op' || action === 'read')));
    if (o.mode === 'live' && (!beforeConvergence || !unchangedArtifacts)) throw new Error('Live resource/seed convergence and unchanged read-only setup plan are unproven');
    pass('Two fresh runs, stable fixture inventory and seed counts, intact prior reports');
    result.status = 'passed'; result.stoppingStep = null;
    result.gaps = o.mode === 'fixture' ? ['FIXTURE only: no frozen install, real resource convergence, deployed storefront views or deployed readiness was proved'] : ['Scoped golden path only; no interview/workshop readiness or external-console no-repair attestation'];
  } catch (error) {
    const safeReasons = new Set(['Golden path requires fresh evidence and setup state', 'Golden path requires successful frozen installation and builds', 'Golden path requires independent resource and seed observations', 'Owned core-waf lab opt-in required', 'Preexisting runtime configuration cannot satisfy a fresh run', 'Live resource/seed convergence and unchanged read-only setup plan are unproven', 'Resource or seed inventory grew or changed', 'Prior immutable evidence changed', 'Old or future report cannot satisfy this run', 'Old or foreign artifact cannot satisfy current proof', 'Browser and collected counts differ', 'Browser edge action or rule differs', 'Policy inspection link is unsafe', 'Setup execution changed after deployment', 'Fresh custom-WAF proof is incomplete']);
    const known = error instanceof Error && (safeReasons.has(error.message) || /^Required command (lab|demo) (capabilities|plan|approve|apply|doctor|waf-custom) returned [0-3]$/.test(error.message)) ? error.message : 'Required stage assertion failed; inspect bounded stage inputs and command exit codes';
    result.status = 'failed'; result.stages.push({ id: stage!, passed: false, detail: known });
    result.gaps.push(`Unmet golden-path stage: ${stage}`);
  } finally {
    // A close failure must not prevent release of the other owned resources.
    displayLedger?.stop('Golden path finished');
    const closed = await Promise.allSettled([context?.close(), browser?.close(), vite?.close(), server?.close()]);
    if (closed.some(value => value.status === 'rejected')) {
      result.status = 'failed'; result.stoppingStep ??= stage;
      result.gaps.push('Owned golden-path cleanup is incomplete');
    }
  }
  finish();
  try { checkpoint(); } catch { result.status = 'failed'; result.gaps.push('Checkpoint could not be saved'); }
  return result;
}
