import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { setCookie } from 'hono/cookie';
import { z } from 'zod';
import { imageVariantDeclaration } from '../../../packages/demo-core/src/image-variant-view.js';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, IMPLEMENTED_SCENARIOS } from '../../../scenarios/catalog.js';
import { runDemoCli, parseDemoArgs, type DemoCliDependencies } from '../../../packages/demo-core/src/demo-cli.js';
import { loadRuntimeConfig } from '../../../packages/demo-core/src/runtime-config.js';
import { validateLabConfig, validateEvidenceDirectory, type LabConfig } from '../../../packages/demo-core/src/config.js';
import { ObservationSchema, ScenarioId } from '../../../packages/contracts/src/schemas.js';
import { ArtifactSchema, ReportSchema, ReportStore, type Artifact } from '../../../packages/demo-core/src/reports.js';
import { DoctorSchema, type DoctorReport } from '../../../packages/demo-core/src/doctor.js';
import { digestValue } from '../../../packages/demo-core/src/deployment-plan.js';
import { policyViews } from '../../../packages/demo-core/src/policy-view.js';
import { evidenceView } from '../../../packages/demo-core/src/evidence-view.js';
import { readJournalRuns } from '../../../packages/demo-core/src/journal-reader.js';
import { WaitingRoomViewSchema, BrowserPreviewSchema, InterviewViewSchema, ScopedReadinessSchema, type InterviewView } from '../../command-center/src/workshop-views.js';
import type { WaitingRoomResult } from '../../../packages/demo-core/src/waiting-room.js';
import type { BrowserPreview, BrowserFrame, BrowserFrameScope } from '../../../packages/demo-core/src/browser-transport.js';
import type { OwnedRoomControl } from '../../../packages/demo-core/src/workshop-runner.js';
import { AdmittedNavigationSchema, BrowserFrameScopeSchema, validateBrowserFrame } from '../../../packages/contracts/src/waiting-room.js';
import { INTERVIEW_STAGES } from '../../../packages/demo-core/src/interview-timeline.js';
import { ReadinessReportSchema, ReadinessRecordStore, readinessHasCurrentAudit, type ReadinessReport } from '../../../packages/demo-core/src/readiness-report-core.js';
import { EventFeed } from './events.js';
import { cookieValue, PresenterAuth, type PresenterSession } from './auth.js';
const Phase = z.enum(['planned', 'starting', 'preflight', 'baseline', 'protected', 'correlate', 'report', 'cleanup', 'finished']);
const Command = z.enum(['doctor', ...ScenarioId.options, 'interview', 'all', 'rehearsal']);
export const CommandRequestSchema = z.strictObject({ command: Command, scope: z.enum(['catalog', 'core-waf']).optional(), limits: z.strictObject({ requests: z.number().int().positive().max(300).optional(), concurrency: z.number().int().positive().max(4).optional(), maxRuntimeSeconds: z.number().int().positive().max(900).optional(), sessions: z.number().int().positive().max(8).optional() }).optional() });
const RunRequest = CommandRequestSchema.extend({ idempotencyKey: z.uuid(), liveOptIn: z.literal(true) });
type CommandRequest = z.infer<typeof CommandRequestSchema>;
const Capture = z.object({ report: ReportSchema, artifacts: z.array(ArtifactSchema).max(500) });
const SafeResult = z.union([
  z.object({ kind: z.literal('aggregate'), result: z.object({ schemaVersion: z.literal(1), command: z.enum(['all', 'rehearsal']), mode: z.enum(['live', 'fixture']), doctor: DoctorSchema.nullable(), items: z.array(z.object({ scenarioId: ScenarioId, outcome: z.enum(['verified', 'failed', 'inconclusive', 'unavailable', 'skipped']), capture: Capture.nullable(), reason: z.string().max(4096).nullable(), cleanup: z.enum(['complete', 'incomplete', 'not-needed']) })).length(11), sequenceCompleted: z.boolean(), allRequiredVerified: z.boolean(), cleanRehearsal: z.boolean(), requestsUsed: z.number().int().min(0).max(300), durationMs: z.number().nonnegative(), exitCode: z.number().int(), blockers: z.array(z.string().max(4096)).max(100) }) }),
  z.object({ kind: z.literal('interview'), result: z.object({ mode: z.enum(['live', 'fixture']), stages: z.array(z.object({ id: z.string().max(32), startedMs: z.number().nonnegative(), finishedMs: z.number().nonnegative(), outcome: z.enum(['verified', 'failed', 'inconclusive', 'unavailable', 'skipped']), capture: Capture.nullable(), missingProof: z.array(z.string().max(4096)).max(100), fallbackLabel: z.literal('SAVED EVIDENCE').nullable() })).length(5), requestsUsed: z.number().int().min(0).max(100), durationMs: z.number().nonnegative(), sequenceCompleted: z.boolean(), interviewVerified: z.boolean(), exitCode: z.number().int() }) }),
  z.object({ kind: z.literal('result'), report: ReportSchema, journalComplete: z.boolean() }),
  z.object({ kind: z.literal('doctor'), report: DoctorSchema }),
  z.object({ kind: z.literal('result'), outcome: z.enum(['unavailable', 'inconclusive', 'failed', 'skipped']), command: z.string().optional(), reason: z.string().max(256).optional(), verified: z.boolean().optional() }),
  z.object({ kind: z.literal('planned'), command: z.string(), scope: z.enum(['catalog', 'core-waf']), targets: z.array(z.object({ role: z.enum(['before', 'after']), origin: z.url() })).max(2), limits: z.object({ requests: z.number(), concurrency: z.number(), maxRuntimeMs: z.number(), sessions: z.number(), cleanupRequests: z.number(), cleanupMs: z.number() }), executable: z.boolean(), availability: z.string().max(256), networkCalls: z.literal(0), verified: z.literal(false) }),
]);
interface Job {
  id: string; key: string; payloadDigest: string; command: CommandRequest;
  presenter: PresenterSession; frames: Map<string, BrowserFrame>; roomControl: OwnedRoomControl | null;
  roomOwner: string | null; navigationActive: boolean;
  status: 'running' | 'finished' | 'failed' | 'cancelled'; phase: z.infer<typeof Phase>;
  actualRunId: string | null; createdAt: string; finishedAt: string | null; exitCode: number | null;
  controller: AbortController; stop: (() => void) | null; result: z.infer<typeof SafeResult> | null; error: string | null;
  observations: z.infer<typeof ObservationSchema>[]; artifacts: Map<string, Artifact>; truncated: boolean;
  waitingRoom: WaitingRoomResult | null; previews: Map<string, BrowserPreview>; interview: InterviewView | null; advance: (() => void) | null;
  feed: EventFeed; task: Promise<void>;
}
export interface ControlAppOptions {
  origin: string; projectRoot: string; demo?: Omit<DemoCliDependencies, 'projectRoot' | 'signal' | 'onStarted' | 'onPhase' | 'onObservation' | 'onEvidence'>;
  execute?: typeof runDemoCli; now?: () => number;
  onPendingApproval?: (code: string) => void;
  readiness?: () => ReadinessReport | null;
}
function argv(command: CommandRequest, dry = false): string[] {
  const args = [command.command, '--json'];
  if (dry) args.push('--dry-run');
  if (command.scope !== undefined) args.push('--scope', command.scope);
  for (const [field, flag] of [['requests', '--requests'], ['concurrency', '--concurrency'], ['maxRuntimeSeconds', '--max-runtime'], ['sessions', '--sessions']] as const) if (command.limits?.[field] !== undefined) args.push(flag, String(command.limits[field]));
  parseDemoArgs(args); return args;
}
export function createControlApp(options: ControlAppOptions) {
  const url = new URL(options.origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Control server requires an exact loopback HTTP origin');
  const origin = url.origin; const host = url.host; const now = options.now ?? Date.now;
  const cookieName = `lab_session_${url.port || '80'}`; const pendingName = `lab_pending_${url.port || '80'}`;
  const auth = new PresenterAuth(now); const jobs = new Map<string, Job>(); const keys = new Map<string, string>();
  let active: string | null = null; let readiness: DoctorReport | null = null; let closed = false;
  const app = new Hono<{ Variables: { presenter: PresenterSession } }>();
  const config = (): LabConfig => validateLabConfig((options.demo?.loadConfig ?? (path => loadRuntimeConfig(options.projectRoot, path)))(), options.projectRoot);
  const presentationPolicy = () => {
    let frames: string[] = []; try { frames = config().environments.map(e => new URL(e.origin).origin); } catch {}
    return `default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self' ${frames.join(' ')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  };
  const acceptFrame = (job: Job, value: BrowserFrame) => {
    const scope = BrowserFrameScopeSchema.parse({ ownerId: value.ownerId, runId: value.runId, sessionId: value.sessionId, releaseDigest: value.releaseDigest });
    const session = job.waitingRoom?.sessions.find(s => s.sessionId === scope.sessionId && s.state !== 'closed');
    if (scope.runId !== job.actualRunId || !session) throw new Error('Unowned frame');
    const frame = validateBrowserFrame(value, scope, options.demo?.mode ?? 'live', now());
    if (config().environments.find(e => e.role === session.role)?.releaseDigest !== scope.releaseDigest || job.roomOwner !== null && job.roomOwner !== scope.ownerId) throw new Error('Changed browser owner or release');
    job.roomOwner = scope.ownerId; job.frames.set(scope.sessionId, frame);
    return frame;
  };
  const publicJob = (job: Job, detailed = true) => {
    let evidence = null; let policies: ReturnType<typeof policyViews> = [];
    if (detailed) try { const report = job.result?.kind === 'result' && 'report' in job.result ? job.result.report : null; policies = policyViews(config(), job.actualRunId ? { runId: job.actualRunId, artifacts: [...job.artifacts.values()], historical: false, readbackComplete: job.status === 'running' || !!report?.result.observedConfigDigest } : undefined, now()); } catch {}
    if (detailed && job.actualRunId && ScenarioId.safeParse(job.command.command).success) try {
      const loaded = config(); const report = job.result?.kind === 'result' && 'report' in job.result ? job.result.report : null;
      evidence = evidenceView({ runId: job.actualRunId, scenarioId: ScenarioId.parse(job.command.command), mode: report?.mode ?? options.demo?.mode ?? 'live', startedAt: report?.result.startedAt ?? job.createdAt, endedAt: report?.result.finishedAt ?? new Date(now()).toISOString(), releaseDigest: report?.result.releaseDigest ?? loaded.environments[0].releaseDigest, hosts: { before: new URL(loaded.environments[0].origin).hostname, after: new URL(loaded.environments[1].origin).hostname }, running: job.status === 'running', truncated: job.truncated }, job.observations, [...job.artifacts.values()], now());
    } catch { /* Missing scope stays unknown, not zero. */ }
    for (const [id, frame] of job.frames) {
      const session = job.waitingRoom?.sessions.find(s => s.sessionId === id);
      if (Date.parse(frame.expiresAt) <= now() || job.status !== 'running' || !session || session.state === 'closed' || session.transitions.some(t => Date.parse(t.observedAt) > Date.parse(frame.observedAt))) job.frames.delete(id);
    }
    let frameScopes: BrowserFrameScope[] = [];
    if (job.status === 'running' && job.roomControl) try {
      const scopes = z.array(BrowserFrameScopeSchema).max(8).parse(job.roomControl.scopes());
      if (new Set(scopes.map(s => s.sessionId)).size !== scopes.length || new Set(scopes.map(s => s.ownerId)).size > 1 || scopes.some(s => s.runId !== job.actualRunId || job.roomOwner !== null && s.ownerId !== job.roomOwner || !job.waitingRoom?.sessions.some(session => session.sessionId === s.sessionId && session.state !== 'closed'))) throw new Error('Foreign owned scopes');
      frameScopes = scopes;
    } catch { job.truncated = true; }
    return { frameScopes, navigationPaths: job.roomControl ? ['/launch', '/catalog'] : [], waitingRoom: job.waitingRoom, interview: job.interview, ownership: 'control' as const, readOnly: false, historical: false, ...(detailed ? { evidence, policies } : {}), id: job.id, command: job.command.command, status: job.status, phase: job.phase, actualRunId: job.actualRunId, createdAt: job.createdAt, finishedAt: job.finishedAt, exitCode: job.exitCode, error: job.error, eventSequence: job.feed.sequence, truncated: job.truncated, ...(detailed ? { result: job.result, observations: job.observations, artifacts: [...job.artifacts.values()] } : {}), reportId: job.result?.kind === 'result' && 'report' in job.result ? job.result.report.result.runId : null };
  };
  const external = (id?: string) => readJournalRuns(options.projectRoot, config(), new Set([...jobs.values()].flatMap(job => job.actualRunId ? [job.actualRunId] : [])), id, now());
  const securityError = (reason: string, status = 403) => new Response(JSON.stringify({ error: reason }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  app.use('*', async (c, next) => {
    if (closed) return securityError('Control server closed', 503);
    if (c.req.header('host') !== host || new URL(c.req.url).origin !== origin) return securityError('Unexpected control origin');
    const requestOrigin = c.req.header('origin'); const site = c.req.header('sec-fetch-site');
    if ((requestOrigin !== undefined && requestOrigin !== origin) || (site && !['same-origin', 'none'].includes(site))) return securityError('Cross-origin control request rejected');
    if (!['GET', 'HEAD'].includes(c.req.method) && requestOrigin !== origin) return securityError('Explicit matching Origin required');
    c.header('cache-control', 'no-store'); c.header('x-content-type-options', 'nosniff'); c.header('referrer-policy', 'no-referrer');
    c.header('content-security-policy', presentationPolicy());
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 8192, onError: c => c.json({ error: 'Control request exceeds size cap' }, 413) }));
  const sessionCookie = (c: Parameters<typeof setCookie>[0], cookie: string) => setCookie(c, cookieName, cookie, { httpOnly: true, sameSite: 'Strict', path: '/', maxAge: 900 });
  app.post('/api/bootstrap/redeem', async c => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
    try { const input = z.strictObject({ token: z.string().regex(/^[a-f0-9]{64}$/) }).parse(await c.req.json()); const result = auth.redeem(input.token); sessionCookie(c, result.cookie); return c.json({ authenticated: true }); }
    catch { return c.json({ error: 'Invalid, expired or consumed local bootstrap' }, 401); }
  });
  app.post('/api/bootstrap/request', async c => {
    if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
    try {
      z.strictObject({}).parse(await c.req.json()); const request = auth.request();
      setCookie(c, pendingName, request.cookie, { httpOnly: true, sameSite: 'Strict', path: '/api/bootstrap', maxAge: 60 });
      options.onPendingApproval?.(request.code); return c.json({ code: request.code, expiresAt: request.expiresAt, pending: true });
    } catch { return c.json({ error: 'Local sign-in capacity or request unavailable' }, 429); }
  });
  app.get('/api/bootstrap/status', c => {
    try {
      const result = auth.poll(cookieValue(c.req.header('cookie') ?? '', pendingName));
      if (result.pending) return c.json({ pending: true, code: result.code });
      sessionCookie(c, result.cookie); setCookie(c, pendingName, '', { httpOnly: true, sameSite: 'Strict', path: '/api/bootstrap', maxAge: 0 });
      return c.json({ pending: false, authenticated: true });
    } catch { return c.json({ error: 'Pending browser proof missing or expired' }, 401); }
  });
  app.use('/api/*', async (c, next) => {
    const session = auth.session(cookieValue(c.req.header('cookie') ?? '', cookieName));
    if (!session) return c.json({ error: 'Presenter authentication required' }, 401);
    c.set('presenter', session);
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      if (!auth.csrf(session, c.req.header('x-csrf-token') ?? '')) return c.json({ error: 'Valid CSRF proof required' }, 403);
      if (!c.req.header('content-type')?.startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
    }
    await next();
  });
  app.get('/api/session', c => c.json({ authenticated: true, csrfToken: c.get('presenter').csrf, expiresAt: c.get('presenter').expiresAt }));
  app.get('/api/catalog', c => {
    let targets: { role: string; origin: string; releaseDigest: string }[] = []; let configured = false; let policies: ReturnType<typeof policyViews> = [];
    let imageVariant: ReturnType<typeof imageVariantDeclaration> | null = null; let cloudflare: { accountId: string; zoneId: string; labId: string; workers: { role: string; name: string }[] } | null = null;
    try { const loaded = config(); imageVariant = imageVariantDeclaration(loaded); targets = loaded.environments.map(e => ({ role: e.role, origin: e.origin, releaseDigest: e.releaseDigest })); cloudflare = { accountId: loaded.accountId, zoneId: loaded.zoneId, labId: loaded.labId, workers: loaded.environments.map(e => ({ role: e.role, name: e.workerName })) }; configured = true; policies = policyViews(loaded, undefined, now()); } catch {}
    return c.json({ policies, imageVariant, cloudflare, schemaVersion: 1, mode: options.demo?.mode ?? 'live', configured, targets, scenarios: CATALOG.map(manifest => ({ ...manifest, implemented: (IMPLEMENTED_SCENARIOS as readonly string[]).includes(manifest.id) })), aggregates: { interview: true, all: true, rehearsal: true } });
  });
  const ActivityRows = z.object({ data: z.object({ viewer: z.object({ zones: z.array(z.object({ httpRequestsAdaptive: z.array(z.object({ datetime: z.string().max(40), clientRequestPath: z.string().max(256), edgeResponseStatus: z.number(), originResponseStatus: z.number(), securityAction: z.string().max(64).nullable().optional(), rayName: z.string().max(32).nullable().optional() })).max(100) })).max(1) }) }).nullable() });
  // Read-only Cloudflare request log for the two lab hostnames; the reader token stays in this server.
  app.get('/api/activity', async c => {
    let loaded: LabConfig; try { loaded = config(); } catch { return c.json({ available: false, reason: 'Lab not configured', events: [] }); }
    if ((options.demo?.mode ?? 'live') !== 'live') return c.json({ available: false, reason: 'Fixture mode has no Cloudflare logs', events: [] });
    const ref = loaded.credentials.reader; const token = ref?.startsWith('env:') ? process.env[ref.slice(4)] : undefined;
    if (!token || !/^[a-f0-9]{32}$/.test(loaded.zoneId)) return c.json({ available: false, reason: 'Reader token is not available to the local server', events: [] });
    const end = new Date(now()); const start = new Date(end.getTime() - 30 * 60000);
    try {
      const perRole = await Promise.all(loaded.environments.map(async env => {
        const host = new URL(env.origin).hostname; if (!/^[a-z0-9.-]{1,253}$/.test(host)) throw new Error('Invalid host');
        const query = `query { viewer { zones(filter: { zoneTag: "${loaded.zoneId}" }) { httpRequestsAdaptive(limit: 60, filter: { datetime_geq: "${start.toISOString()}", datetime_leq: "${end.toISOString()}", clientRequestHTTPHost: "${host}" }, orderBy: [datetime_DESC]) { datetime clientRequestPath edgeResponseStatus originResponseStatus securityAction rayName } } } }`;
        const response = await fetch(`${loaded.apiOrigin}/client/v4/graphql`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error('Cloudflare log read failed');
        const rows = ActivityRows.parse(await response.json()).data?.viewer.zones[0]?.httpRequestsAdaptive ?? [];
        return rows.filter(r => !r.clientRequestPath.startsWith('/internal/') && !r.clientRequestPath.startsWith('/assets/')).slice(0, 25).map(r => {
          const action = r.securityAction && r.securityAction !== 'unknown' ? r.securityAction : null;
          return { role: env.role, time: r.datetime, path: r.clientRequestPath, status: r.edgeResponseStatus, action, reachedOrigin: r.originResponseStatus > 0, rayId: r.rayName ?? null };
        });
      }));
      return c.json({ available: true, observedAt: end.toISOString(), windowMinutes: 30, events: perRole.flat() });
    } catch { return c.json({ available: false, reason: 'Cloudflare request log is unavailable right now', events: [] }); }
  });
  app.get('/api/readiness', c => {
    let scoped: z.infer<typeof ScopedReadinessSchema> | null = null;
    try {
      let report = options.readiness?.();
      if (!report) {
        const loaded = config(); const directory = join(loaded.evidenceDirectory, 'readiness'); validateEvidenceDirectory(directory, options.projectRoot);
        if (existsSync(directory)) {
          const names = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
          if (names.length <= 100) {
            const store = new ReadinessRecordStore(options.projectRoot, loaded.evidenceDirectory);
            for (const name of names) { try { const candidate = store.load(name.slice(0, -5)).report; if (candidate.mode === (options.demo?.mode ?? 'live') && (!report || candidate.observedAt > report.observedAt)) report = candidate; } catch {} }
          }
        }
      }
      if (report) {
        const r = ReadinessReportSchema.parse(report); const loaded = config();
        const audited = readinessHasCurrentAudit(report);
        const matches = r.releaseDigest === loaded.environments[0].releaseDigest && loaded.environments.every(e => r.hostnames.includes(new URL(e.origin).hostname));
        scoped = ScopedReadinessSchema.parse({ mode: r.mode, observedAt: r.observedAt, historical: r.historical || !matches, includedModules: r.includedModules, excludedModules: r.excludedModules.map(m => ({ id: m.scenarioId, reason: m.reason })), claims: Object.fromEntries(Object.entries(r.claims).map(([k, v]) => [k, v.verified && matches && (k === 'coreDeployed' || k === 'fallbackAvailable' || audited)])), blockers: Object.entries(r.claims).flatMap(([claim, v]) => v.blockers.map(reason => ({ claim, reason }))) });
        if (!audited) for (const claim of ['deploymentVerified', 'interviewVerified', 'workshopVerified'] as const) if (r.claims[claim].verified) {
          scoped.historical = true; scoped.blockers.push({ claim, reason: 'Current independently scoped execution audit is missing' });
        }
      }
    } catch { /* Invalid or unrelated readiness remains unknown. */ }
    const latest = [...jobs.values()].reverse().find(job => job.command.command === 'waf-custom' && job.actualRunId);
    let policyReadinessBlocked = false;
    if (latest) try { policyReadinessBlocked = policyViews(config(), { runId: latest.actualRunId!, artifacts: [...latest.artifacts.values()], historical: false, readbackComplete: latest.status === 'running' || !!(latest.result?.kind === 'result' && 'report' in latest.result && latest.result.report.result.observedConfigDigest) }, now()).find(p => p.scenarioId === 'waf-custom')!.readinessBlocked; } catch { policyReadinessBlocked = true; }
    if (readiness) return c.json({ scoped, policyReadinessBlocked, report: readiness, freshness: now() - Date.parse(readiness.observedAt) > 60000 || now() < Date.parse(readiness.observedAt) ? 'stale' : 'last-checked', currentPreflightReady: !policyReadinessBlocked && readiness.preflightReady && now() >= Date.parse(readiness.observedAt) && now() - Date.parse(readiness.observedAt) <= 60000, automaticallyRefreshed: false });
    let cached: DoctorReport | null = null;
    try {
      const loaded = config(); const directory = join(loaded.evidenceDirectory, 'doctor'); validateEvidenceDirectory(directory, options.projectRoot);
      if (existsSync(directory)) {
        const names = readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name));
        if (names.length <= 100) for (const name of names) {
          const path = join(directory, name); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256000) continue;
          const parsed = DoctorSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
          if (parsed.success && parsed.data.accountId === loaded.accountId && parsed.data.zoneId === loaded.zoneId && parsed.data.labId === loaded.labId && parsed.data.mode === (options.demo?.mode ?? 'live') && (!cached || cached.observedAt < parsed.data.observedAt)) cached = parsed.data;
        }
      }
    } catch {}
    return c.json({ scoped, report: cached, freshness: cached ? 'historical' : 'unavailable', currentPreflightReady: false, automaticallyRefreshed: false });
  });
  app.post('/api/plans', async c => {
    try { const command = CommandRequestSchema.parse(await c.req.json()); const result = await (options.execute ?? runDemoCli)(argv(command, true), { ...options.demo, projectRoot: options.projectRoot }); const data = SafeResult.safeParse(JSON.parse(result.output)); return c.json({ exitCode: result.exitCode, plan: data.success ? data.data : null, error: data.success ? null : 'Local plan is invalid or unavailable' }); }
    catch { return c.json({ error: 'Invalid local plan request' }, 400); }
  });
  app.post('/api/runs', async c => {
    let input: z.infer<typeof RunRequest>;
    try { input = RunRequest.parse(await c.req.json()); argv(CommandRequestSchema.parse({ command: input.command, ...(input.scope ? { scope: input.scope } : {}), ...(input.limits ? { limits: input.limits } : {}) })); }
    catch { return c.json({ error: 'Invalid catalog command, limits or explicit opt-in' }, 400); }
    const command = CommandRequestSchema.parse({ command: input.command, ...(input.scope ? { scope: input.scope } : {}), ...(input.limits ? { limits: input.limits } : {}) });
    const digest = digestValue(command); const existing = keys.get(input.idempotencyKey);
    if (existing) { const job = jobs.get(existing)!; return job.payloadDigest === digest ? c.json({ run: publicJob(job) }, 202) : c.json({ error: 'Idempotency key belongs to a different command' }, 409); }
    if (active) return c.json({ error: 'This server already owns an active run' }, 409);
    if (jobs.size >= 32 || keys.size >= 128) return c.json({ error: 'Bounded run history is full; restart only after runs finish' }, 429);
    const id = randomUUID(); const controller = new AbortController();
    const job: Job = { presenter: c.get('presenter'), frames: new Map(), roomControl: null, roomOwner: null, navigationActive: false, id, key: input.idempotencyKey, payloadDigest: digest, command, status: 'running', phase: 'planned', actualRunId: null, createdAt: new Date(now()).toISOString(), finishedAt: null, exitCode: null, controller, stop: null, result: null, error: null, observations: [], artifacts: new Map(), truncated: false, waitingRoom: null, previews: new Map(), interview: null, advance: null, feed: null as unknown as EventFeed, task: Promise.resolve() };
    job.feed = new EventFeed(() => publicJob(job, false)); jobs.set(id, job); keys.set(input.idempotencyKey, id); active = id;
    job.feed.publish('phase', { phase: 'planned' });
    const emit = (type: string, data: unknown) => { try { job.feed.publish(type, data); } catch { job.truncated = true; } };
    job.task = Promise.resolve().then(async () => {
      try {
        const result = await (options.execute ?? runDemoCli)(argv(command), {
          ...options.demo, projectRoot: options.projectRoot, signal: controller.signal,
          onWaitingRoom: value => { job.waitingRoom = WaitingRoomViewSchema.parse(value); emit('snapshot', publicJob(job, false)); },
          onRoomControl: control => { job.roomControl = control; if (!control) job.frames.clear(); },
          onFrame: value => { acceptFrame(job, value); emit('snapshot', publicJob(job, false)); },
          onPreview: value => { const preview = BrowserPreviewSchema.parse(value); if (!job.waitingRoom?.sessions.some(s => s.sessionId === preview.sessionId)) throw new Error('Unowned preview'); job.previews.set(preview.sessionId, preview); },
          onInterviewControl: control => { job.advance = control.advance; const stop = job.stop; job.stop = () => { control.stop(); stop?.(); }; },
          onInterviewStage: view => { const index = INTERVIEW_STAGES.findIndex(s => s.id === view.id); job.interview = InterviewViewSchema.parse({ mode: options.demo?.mode ?? 'live', observedAt: new Date(now()).toISOString(), stageIndex: index, elapsedMs: view.elapsedMs ?? view.startMs, requestsUsed: view.requestsUsed ?? 0, state: 'running', stageOutcome: 'pending', purpose: view.purpose, action: view.action, talkingPoints: [view.customerNotes.problem, view.customerNotes.solution, view.customerNotes.limitations], question: view.question, missingProof: [], fallback: null }); emit('snapshot', publicJob(job, false)); },
          onStarted: info => { job.actualRunId = z.uuid().parse(info.runId); job.stop = info.stop; emit('started', { actualRunId: job.actualRunId }); },
          onPhase: phase => { job.phase = Phase.parse(phase); emit('phase', { phase }); },
          onObservation: value => { const observation = ObservationSchema.parse(value); job.observations.push(observation); if (job.observations.length > 100) { job.observations.shift(); job.truncated = true; } emit('observation', observation); },
          onEvidence: value => { const artifact = ArtifactSchema.parse(value); job.artifacts.set(artifact.id, artifact); if (job.artifacts.size > 200) { job.artifacts.delete(job.artifacts.keys().next().value!); job.truncated = true; } emit('evidence', artifact); },
        });
        job.exitCode = z.number().int().min(0).max(255).parse(result.exitCode);
        const parsed = SafeResult.safeParse(JSON.parse(result.output)); job.result = parsed.success ? parsed.data : null;
        if (job.result?.kind === 'doctor') readiness = job.result.report;
        if (!parsed.success) { job.error = 'Command could not complete; no unverified output was published'; if (job.exitCode < 2) job.exitCode = 3; }
        job.status = controller.signal.aborted || result.exitCode === 130 ? 'cancelled' : job.exitCode >= 2 ? 'failed' : 'finished'; job.phase = 'finished';
      } catch { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.error = 'Control execution failed; no success or saved evidence is claimed'; job.exitCode = controller.signal.aborted ? 130 : 3; }
      finally { if (job.interview) { job.interview.state = controller.signal.aborted ? 'stopped' : 'finished'; if (job.result?.kind === 'interview') { const final = job.result.result.stages.at(-1); job.interview.requestsUsed = job.result.result.requestsUsed; job.interview.elapsedMs = Math.min(900000, job.result.result.durationMs); job.interview.stageOutcome = final?.outcome ?? 'inconclusive'; job.interview.missingProof = final?.missingProof ?? []; } } job.advance = null; job.roomControl = null; job.frames.clear(); job.finishedAt = new Date(now()).toISOString(); active = null; emit('result', publicJob(job, false)); job.feed.close(); }
    });
    return c.json({ run: publicJob(job) }, 202);
  });
  app.get('/api/journal-runs', c => {
    try { return c.json(external()); } catch { return c.json({ runs: [], truncated: true }); }
  });
  app.get('/api/journal-runs/:id', c => {
    try { const run = external(z.uuid().parse(c.req.param('id'))).runs[0]; return run ? c.json({ run: { ...run, policies: policyViews(config(), { runId: run.id, artifacts: run.artifacts ?? [], historical: run.historical, readbackComplete: !run.historical || !!run.result?.report.result.observedConfigDigest }, now()) } }) : c.json({ error: 'Read-only journal capture unavailable' }, 404); }
    catch { return c.json({ error: 'Read-only journal capture unavailable' }, 404); }
  });
  app.get('/api/journal-runs/:id/evidence/:artifactId', c => {
    try { const id = z.uuid().parse(c.req.param('id')); const artifactId = z.uuid().parse(c.req.param('artifactId')); const artifact = external(id).runs[0]?.artifacts?.find(a => a.id === artifactId); return artifact ? c.json({ artifact }) : c.json({ error: 'Evidence unavailable' }, 404); }
    catch { return c.json({ error: 'Evidence unavailable' }, 404); }
  });
  app.get('/api/runs/:id/evidence/:artifactId', c => {
    const artifact = jobs.get(c.req.param('id'))?.artifacts.get(c.req.param('artifactId')); return artifact ? c.json({ artifact }) : c.json({ error: 'Owned evidence unavailable' }, 404);
  });
  app.get('/api/runs', c => c.json({ activeRunId: active, runs: [...jobs.values()].map(job => publicJob(job, false)) }));
  app.get('/api/runs/:id', c => { const job = jobs.get(c.req.param('id')); return job ? c.json({ run: publicJob(job) }) : c.json({ error: 'Run is not owned by this control server' }, 404); });
  app.post('/api/runs/:id/stop', async c => {
    try { z.strictObject({}).parse(await c.req.json()); } catch { return c.json({ error: 'Empty control body required' }, 400); }
    const job = jobs.get(c.req.param('id')); if (!job) return c.json({ error: 'Run is not owned by this control server' }, 404);
    if (job.status !== 'running') return c.json({ stopped: false, run: publicJob(job) });
    job.controller.abort(); job.stop?.(); return c.json({ stopped: true, run: publicJob(job) });
  });
  app.post('/api/runs/:id/advance', async c => {
    try { z.strictObject({}).parse(await c.req.json()); } catch { return c.json({ error: 'Empty control body required' }, 400); }
    const job = jobs.get(c.req.param('id'));
    if (!job) return c.json({ error: 'Run is not owned by this control server' }, 404);
    if (job.command.command !== 'interview' || job.status !== 'running' || !job.advance) return c.json({ error: 'No active owned interview stage' }, 409);
    job.advance(); return c.json({ accepted: true });
  });
  app.get('/api/runs/:id/events', c => {
    const job = jobs.get(c.req.param('id')); if (!job) return c.json({ error: 'Run is not owned by this control server' }, 404);
    const raw = c.req.header('last-event-id') ?? c.req.query('after') ?? '0';
    if (!/^\d{1,8}$/.test(raw)) return c.json({ error: 'Invalid replay position' }, 400);
    try {
      const lifetime = Math.max(1, c.get('presenter').expiresAt - now()); const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(lifetime)]);
      return new Response(job.feed.stream(Number(raw), signal), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff' } });
    } catch { return c.json({ error: 'Replay position or bounded subscriber capacity unavailable' }, 409); }
  });
  app.post('/api/runs/:id/sessions/:sessionId/navigation', async c => {
    const job = jobs.get(c.req.param('id'));
    if (!job || job.presenter !== c.get('presenter')) return c.json({ error: 'Owned presenter run required' }, 404);
    if (job.navigationActive) return c.json({ error: 'Owned shopper action already active' }, 409);
    job.navigationActive = true;
    try {
      const input = AdmittedNavigationSchema.parse(await c.req.json());
      publicJob(job, false);
      const frame = job.frames.get(c.req.param('sessionId'));
      if (job.status !== 'running' || !job.roomControl || !frame || input.scope.sessionId !== c.req.param('sessionId') || input.scope.runId !== job.actualRunId) throw new Error('Inactive or foreign session');
      validateBrowserFrame(frame, input.scope, options.demo?.mode ?? 'live', now());
      const session = job.waitingRoom?.sessions.find(s => s.sessionId === input.scope.sessionId);
      if (session?.state !== 'admitted' || session.role !== 'after' || !['/launch', '/catalog'].includes(input.path)) throw new Error('Undeclared or unadmitted shopper route');
      job.frames.delete(input.scope.sessionId);
      await job.roomControl.navigate(input.scope, input.path, AbortSignal.any([job.controller.signal, c.req.raw.signal]));
      return c.json({ waitingRoom: WaitingRoomViewSchema.parse(job.waitingRoom) });
    } catch { return c.json({ error: 'Owned admitted navigation unavailable' }, 409); }
    finally { job.navigationActive = false; }
  });
  app.post('/api/runs/:id/sessions/:sessionId/capture', async c => {
    const job = jobs.get(c.req.param('id'));
    if (!job || job.presenter !== c.get('presenter')) return c.json({ error: 'Owned presenter run required' }, 404);
    try {
      const scope = BrowserFrameScopeSchema.parse(await c.req.json());
      if (job.status !== 'running' || !job.roomControl || job.navigationActive || scope.runId !== job.actualRunId || scope.sessionId !== c.req.param('sessionId') || !job.waitingRoom?.sessions.some(s => s.sessionId === scope.sessionId && ['queued', 'admitted'].includes(s.state))) throw new Error('Inactive or foreign capture');
      const frame = await job.roomControl.capture(scope);
      if (job.status !== 'running' || job.controller.signal.aborted) throw new Error('Run ended during capture');
      return c.json(acceptFrame(job, frame));
    } catch { return c.json({ error: 'Current owned capture unavailable' }, 409); }
  });
  app.get('/api/runs/:id/sessions/:sessionId/frame', c => {
    const job = jobs.get(c.req.param('id'));
    if (job) publicJob(job, false);
    const frame = job?.frames.get(c.req.param('sessionId'));
    try {
      if (!job || job.presenter !== c.get('presenter') || job.status !== 'running' || job.navigationActive || !frame || !job.waitingRoom?.sessions.some(s => s.sessionId === frame.sessionId && s.state !== 'closed')) throw new Error('Inactive session');
      const scope = BrowserFrameScopeSchema.parse(JSON.parse(c.req.query('scope') ?? 'null'));
      if (scope.runId !== job.actualRunId) throw new Error('Foreign run');
      return c.json(validateBrowserFrame(frame, scope, options.demo?.mode ?? 'live', now()));
    } catch { if (job && frame && Date.parse(frame.expiresAt) <= now()) job.frames.delete(frame.sessionId); return c.json({ error: 'Owned current frame unavailable' }, 404); }
  });
  app.get('/api/runs/:id/sessions/:sessionId/preview', c => {
    const job = jobs.get(c.req.param('id')); const preview = job?.previews.get(c.req.param('sessionId'));
    if (!job || !preview || !job.waitingRoom?.sessions.some(s => s.sessionId === preview.sessionId)) return c.json({ error: 'Owned cached preview unavailable' }, 404);
    return c.json(BrowserPreviewSchema.parse(preview));
  });
  app.get('/api/reports/:id', c => {
    try { const id = z.uuid().parse(c.req.param('id')); const loaded = config(); const store = new ReportStore(options.projectRoot, loaded.evidenceDirectory); return c.json({ report: store.load(id), artifacts: store.loadArtifacts(id) }); }
    catch { return c.json({ error: 'Verified report artifacts are unavailable' }, 404); }
  });
  app.get('/api/reports/:id/html', c => {
    try { const id = z.uuid().parse(c.req.param('id')); const loaded = config(); const html = new ReportStore(options.projectRoot, loaded.evidenceDirectory).loadHtml(id); c.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'"); return c.html(html); }
    catch { return c.json({ error: 'Verified report HTML unavailable' }, 404); }
  });
  app.notFound(c => c.json({ error: 'Control route not found' }, 404));
  app.onError((_error, c) => c.json({ error: 'Control request could not complete' }, 500));
  return {
    app, origin, cookieName, pendingCookieName: pendingName, presentationPolicy,
    issueBootstrap: () => auth.issueBootstrap(), approvePending: (code: string) => auth.approve(code),
    async close() {
      closed = true; for (const job of jobs.values()) if (job.status === 'running') { job.controller.abort(); job.stop?.(); }
      for (const job of jobs.values()) job.feed.close(); auth.clear();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([Promise.allSettled([...jobs.values()].map(job => job.task)), new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); })]); }
      finally { if (timer) clearTimeout(timer); }
    },
  };
}
