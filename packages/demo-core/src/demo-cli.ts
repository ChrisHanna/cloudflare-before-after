import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG, IMPLEMENTED_SCENARIOS, scenario } from '../../../scenarios/catalog.js';
import { ScenarioId } from '../../contracts/src/schemas.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { limitsFor, validatePlan, type Limits } from './budget.js';
import { loadRuntimeConfig } from './runtime-config.js';
import { validateEvidenceDirectory, validateLabConfig, type LabConfig } from './config.js';
import { runDoctor, doctorMinimumRequests, DemoCredentialsSchema, DoctorSchema, type DoctorReport, type DoctorOptions, type DemoCredentials } from './doctor.js';
import { observeRuntimeOwnership, OWNERSHIP_MIN_REQUESTS } from './ownership.js';
import { PolicyModule } from './product-state.js';
import { runWafCustom, type WafCustomOptions } from './waf-custom.js';
import { ReportStore, RunJournal, type Artifact } from './reports.js';
import type { Dispatch, GuardedClient } from './transport.js';
import { runWorkshopScenario, workshopMinimum, workshopWaitingRoomPlan, analyticsFromCapture, type WorkshopRunnerOptions, type WorkshopScenario } from './workshop-runner.js';
import { runWorkshopAggregate, type SequenceContext, type SequenceDriver, type AggregateOptions } from './workshop-aggregation.js';
import { InterviewTimeline, INTERVIEW_STAGES, type InterviewStageView } from './interview-timeline.js';
import type { Clock, BudgetLedger } from './budget.js';
import { saveAggregateReadiness } from './workshop-readiness.js';
export const DEMO_HELP = `Usage: pnpm demo <command> [options]
Commands: doctor, list, ${CATALOG.map(m => m.id).join(', ')}, interview, all, rehearsal
Execution available now: ${IMPLEMENTED_SCENARIOS.join(', ')}. Other catalog adapters remain explicitly unavailable until implemented and qualified.
--config /absolute/runtime.json selects an explicit lab. Otherwise use .lab/runtime.json or the latest single-lab successful setup runtime config.
--json emits one JSON document. --dry-run validates only local configuration and budgets, with zero network/browser/deployment calls.
--requests N is the TOTAL request cap, including control-plane reads, probes, redirects, retries and telemetry.
--concurrency N: default2, maximum4. --max-runtime SECONDS: default60, maximum120 for a scenario.
Scenario defaults:30 requests. Hard cap100. Waiting Room additionally supports --sessions N, maximum8.
Doctor supports --scope core-waf for an explicitly labeled subset; default catalog checks do not silently ignore missing products.
Interview has total100 requests/300 seconds; all/rehearsal have total300 requests/900 seconds when their adapters are implemented.
Prerequisites: pinned Node/pnpm dependencies, owned isolated lab, explicit live opt-in, exact HTTPS targets, deployed matching releases, read-only Cloudflare/collector access and a lab run token.
Demo credentials resolve ONLY reader, collector and runner environment references. No personal credentials or setup/deployment key is needed.
Outcomes: verified,failed,inconclusive,unavailable,skipped. A403/429 or Ray ID alone is never mitigation proof.
Exit0: requested verification or scoped doctor preflight passed, or local planning/help/list succeeded. Exit1: nonverified/unavailable. Exit2: invalid/unsafe command/config. Exit3: runner/output failure. Exit130: interrupted.
A doctor pass is not deployment/interview/workshop or mitigation verification. Dry-run is never verification.
Live commands create bounded lab traffic. The $100 monthly plan limit is not a provider-enforced billing cap.`;
export interface ParsedDemoCommand {
  command: 'help' | 'list' | 'doctor' | 'scenario' | 'aggregate'; scenarioId?: z.infer<typeof ScenarioId>;
  aggregate?: 'interview' | 'all' | 'rehearsal'; json: boolean; dryRun: boolean; configPath?: string;
  scope: 'catalog' | 'core-waf'; limits: Limits;
}
function integer(value: string | undefined): number {
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Positive integer required'); return Number(value);
}
export function parseDemoArgs(args: readonly string[]): ParsedDemoCommand {
  const json = args.includes('--json');
  if (!args.length || args.includes('--help') || args.includes('-h')) return { command: 'help', json, dryRun: false, scope: 'catalog', limits: limitsFor() };
  const name = args[0]!;
  const command = name === 'list' ? 'list' : name === 'doctor' ? 'doctor' : ScenarioId.safeParse(name).success ? 'scenario' : ['interview', 'all', 'rehearsal'].includes(name) ? 'aggregate' : null;
  if (!command) throw new Error('Unknown command');
  let configPath: string | undefined; let scope: 'catalog' | 'core-waf' = 'catalog'; let dryRun = false;
  const overrides: Partial<Limits> = {}; const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!; if (seen.has(flag)) throw new Error('Duplicate flag'); seen.add(flag);
    if (flag === '--json') continue;
    if (command === 'list') throw new Error('List accepts no execution flags');
    if (flag === '--config') { configPath = args[++i]; if (!configPath || !isAbsolute(configPath)) throw new Error('Absolute config path required'); continue; }
    if (flag === '--dry-run') { dryRun = true; continue; }
    if (flag === '--scope') { if (command !== 'doctor') throw new Error('Scope only applies to doctor'); scope = z.enum(['catalog', 'core-waf']).parse(args[++i]); continue; }
    if (flag === '--requests') { overrides.requests = integer(args[++i]); continue; }
    if (flag === '--concurrency') { overrides.concurrency = integer(args[++i]); continue; }
    if (flag === '--max-runtime') { overrides.maxRuntimeMs = integer(args[++i]) * 1000; continue; }
    if (flag === '--sessions') { if (name !== 'waiting-room') throw new Error('Sessions only apply to a browser scenario'); overrides.sessions = integer(args[++i]); continue; }
    throw new Error('Unknown or inapplicable flag');
  }
  const aggregate = command === 'aggregate' ? z.enum(['interview', 'all', 'rehearsal']).parse(name) : undefined;
  const defaults = command === 'scenario' ? scenario(name).budget : { sessions: command === 'aggregate' ? 8 : 0 };
  const limits = limitsFor(aggregate ?? 'scenario', { ...defaults, ...overrides });
  return { command, json, dryRun, scope, limits, ...(configPath ? { configPath } : {}), ...(command === 'scenario' ? { scenarioId: ScenarioId.parse(name) } : {}), ...(aggregate ? { aggregate } : {}) };
}
export interface DemoCliDependencies {
  projectRoot: string; mode?: 'live' | 'fixture'; dispatch?: Dispatch; signal?: AbortSignal; parent?: BudgetLedger; clock?: Clock;
  workshop?: Pick<WorkshopRunnerOptions, 'browser' | 'resolveValue' | 'resolveCertificate' | 'resolveServiceToken' | 'policySignal' | 'policyReadback' | 'ddosReader' | 'analyticsInput'>;
  onWaitingRoom?: WorkshopRunnerOptions['onWaitingRoom']; onPreview?: WorkshopRunnerOptions['onPreview'];
  onFrame?: WorkshopRunnerOptions['onFrame']; onRoomControl?: WorkshopRunnerOptions['onRoomControl'];
  onInterviewControl?: (control: { advance: () => void; stop: () => void }) => void;
  onInterviewStage?: (view: InterviewStageView) => void;
  deploymentCheck?: AggregateOptions['deploymentCheck'];
  loadConfig?: (path?: string) => unknown; credentials?: (config: LabConfig) => DemoCredentials;
  doctor?: (options: DoctorOptions) => Promise<DoctorReport>;
  runWafCustom?: (options: WafCustomOptions) => ReturnType<typeof runWafCustom>;
  ownership?: (config: LabConfig, credentials: DemoCredentials, client: GuardedClient, signal: AbortSignal) => Promise<ReadonlySet<string>>;
  ownershipRequests?: number;
  onStarted?: WafCustomOptions['onStarted']; onPhase?: WafCustomOptions['onPhase']; onObservation?: WafCustomOptions['onObservation']; onEvidence?: WafCustomOptions['onEvidence'];
}
export function resolveDemoCredentials(config: LabConfig): DemoCredentials {
  const value = (ref: string | undefined) => ref ? process.env[ref.slice(4)] : undefined;
  return DemoCredentialsSchema.parse({ reader: value(config.credentials.reader), collector: value(config.credentials.collector), runner: value(config.credentials.runner) });
}
export async function runDemoCli(args: readonly string[], deps: DemoCliDependencies): Promise<{ exitCode: number; output: string }> {
  let parsed: ParsedDemoCommand; let config: LabConfig; let credentials: DemoCredentials;
  const emit = (exitCode: number, data: unknown, human: string) => ({ exitCode, output: parsed?.json ? JSON.stringify(data) : human });
  try { parsed = parseDemoArgs(args); }
  catch { return { exitCode: 2, output: args.includes('--json') ? JSON.stringify({ error: 'Invalid or unsafe demo command/limits. Use pnpm demo --help.' }) : 'Invalid or unsafe demo command/limits. Use pnpm demo --help.' }; }
  if (parsed.command === 'help') return emit(0, { kind: 'help', text: DEMO_HELP }, DEMO_HELP);
  if (parsed.command === 'list') {
    const entries = CATALOG.map(m => ({ id: m.id, command: m.command, product: m.product, implemented: (IMPLEMENTED_SCENARIOS as readonly string[]).includes(m.id), availability: (IMPLEMENTED_SCENARIOS as readonly string[]).includes(m.id) ? 'requires live lab preflight' : 'unavailable: adapter not implemented' }));
    return emit(0, { kind: 'catalog', entries }, entries.map(e => `${e.command}: ${e.availability}`).join('\n'));
  }
  try {
    config = validateLabConfig((deps.loadConfig ?? (path => loadRuntimeConfig(deps.projectRoot, path)))(parsed.configPath), deps.projectRoot);
    const minimum = parsed.command === 'doctor' ? doctorMinimumRequests(config) : PolicyModule.safeParse(parsed.scenarioId).success ? scenario(parsed.scenarioId!).minimumRequests + (deps.ownershipRequests ?? OWNERSHIP_MIN_REQUESTS) + (parsed.scenarioId === 'rate-limit' || config.rateLimitRuleId ? 1 : 0) + (parsed.scenarioId === 'bot' ? 1 : 0) + config.environments.reduce((n, e) => n + Math.max(0, e.imageIds.length - 1), 0) : parsed.scenarioId ? workshopMinimum(parsed.scenarioId as WorkshopScenario, deps.ownershipRequests ?? OWNERSHIP_MIN_REQUESTS, config) : 0;
    validatePlan(parsed.limits, minimum, parsed.scenarioId === 'waiting-room' ? 3 : 0, 1000);
    if (parsed.scenarioId === 'waiting-room') workshopWaitingRoomPlan(config, parsed.limits);
  } catch { return emit(2, { error: 'Invalid lab config or proof budget. Use a generated runtime config and sufficient total limits; no traffic was sent.' }, 'Invalid lab config or proof budget. No traffic was sent.'); }
  const implemented = parsed.command === 'doctor' || parsed.command === 'aggregate' || parsed.command === 'scenario';
  if (parsed.dryRun) return emit(implemented ? 0 : 1, { kind: 'planned', command: parsed.scenarioId ?? parsed.aggregate ?? parsed.command, scope: parsed.scope, targets: config.environments.map(e => ({ role: e.role, origin: e.origin })), limits: parsed.limits, executable: implemented, availability: implemented ? 'local plan only; no live readiness assertion' : 'unavailable: adapter not implemented', networkCalls: 0, verified: false }, `Local plan: ${implemented ? 'valid, not verified' : 'unavailable adapter'}. No network calls or browser launch.`);
  if (!implemented) return emit(1, { kind: 'result', outcome: 'unavailable', command: parsed.scenarioId ?? parsed.aggregate, reason: 'Scenario or aggregate execution is not implemented or qualified yet', verified: false }, 'Unavailable: this execution adapter is not implemented or qualified yet.');
  try {
    if (!config.liveOptIn) throw new Error('Opt-in required');
    credentials = DemoCredentialsSchema.parse((deps.credentials ?? resolveDemoCredentials)(config));
    z.enum(['live', 'fixture']).parse(deps.mode ?? 'live');
  } catch { return emit(2, { error: 'Owned-lab live opt-in and separate reader/collector/runner environment references are required. No deployment/setup credentials are used.' }, 'Resolve owned-lab opt-in and reader/collector/runner env references. No setup credentials are used.'); }
  const mode = deps.mode ?? 'live'; const redactor = new Redactor(Object.values(credentials));
  try {
    if (parsed.command === 'doctor') {
      const report = DoctorSchema.parse(await (deps.doctor ?? runDoctor)({ projectRoot: deps.projectRoot, config, credentials, mode, scope: parsed.scope, limits: parsed.limits, ...(deps.parent ? { parent: deps.parent } : {}), ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.dispatch ? { dispatch: deps.dispatch } : {}), ...(deps.signal ? { signal: deps.signal } : {}) }));
      if (report.mode !== mode) throw new Error('Doctor provenance differs from execution mode');
      const directory = join(config.evidenceDirectory, 'doctor'); validateEvidenceDirectory(directory, deps.projectRoot); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${randomUUID()}.json`); writeFileSync(path, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
      return emit(deps.signal?.aborted ? 130 : report.preflightReady ? 0 : 1, { kind: 'doctor', report, reportPath: path }, [`Doctor ${report.scope}: ${report.preflightReady ? 'preflight passed' : 'not ready'}`, `Mode: ${report.mode}`, ...report.checks.filter(c => c.state !== 'passed').map(c => `${c.id}: ${c.state} — ${c.correctiveAction}`), ...report.catalog.filter(c => c.state === 'unavailable').map(c => `${c.id}: ${c.reason}`), 'Mitigation, deployment, interview and workshop verification remain false.', `Report: ${path}`].join('\n'));
    }
    if (parsed.command === 'aggregate') {
      const captures: { report: import('./reports.js').Report; artifacts: Artifact[] }[] = [];
      const drivers = Object.fromEntries(CATALOG.map(manifest => {
        const ownership = (deps.ownershipRequests ?? OWNERSHIP_MIN_REQUESTS) + (config.rateLimitRuleId ? 1 : 0) + config.environments.reduce((n, e) => n + Math.max(0, e.imageIds.length - 1), 0);
        const minimum = PolicyModule.safeParse(manifest.id).success ? manifest.minimumRequests + ownership + (manifest.id === 'rate-limit' && !config.rateLimitRuleId ? 1 : 0) + (manifest.id === 'bot' ? 1 : 0) : workshopMinimum(manifest.id as WorkshopScenario, ownership, config);
        const driver: SequenceDriver = { minimumRequests: minimum, limits: { requests: Math.max(manifest.budget.requests, minimum + manifest.budget.cleanupRequests) }, run: async context => {
          const nestedArgs = [manifest.id, '--json', '--requests', String(context.limits.requests), '--concurrency', String(context.limits.concurrency), '--max-runtime', String(Math.floor(context.limits.maxRuntimeMs / 1000)), ...(manifest.id === 'waiting-room' ? ['--sessions', String(context.limits.sessions)] : []), ...(parsed.configPath ? ['--config', parsed.configPath] : [])];
          const nested = await runDemoCli(nestedArgs, { ...deps, parent: context.parent, clock: context.parent.clock, signal: context.signal });
          const data = JSON.parse(nested.output) as { kind?: string; report?: import('./reports.js').Report };
          if (data.kind !== 'result' || !data.report) throw new Error('Concrete scenario did not return a capture');
          const capture = { report: data.report, artifacts: new ReportStore(deps.projectRoot, config.evidenceDirectory).loadArtifacts(data.report.result.runId) }; captures.push(capture); return capture;
        } }; return [manifest.id, driver];
      })) as Record<z.infer<typeof ScenarioId>, SequenceDriver>;
      const interview = (context?: SequenceContext) => {
        const timeline = new InterviewTimeline({ mode, drivers, ...(deps.clock ? { clock: deps.clock } : {}), ...(context ? { parent: context.parent, signal: context.signal } : deps.signal ? { signal: deps.signal } : {}), limits: { requests: Math.min(100, parsed.limits.requests) },
          storefronts: { run: async c => { await (deps.doctor ?? runDoctor)({ projectRoot: deps.projectRoot, config, credentials, mode, scope: 'core-waf', parent: c.parent, clock: c.parent.clock, limits: c.limits, signal: c.signal, ...(deps.dispatch ? { dispatch: deps.dispatch } : {}) }); return { mode, deploymentVerified: false }; } },
          analyticsInput: values => values.map(c => analyticsFromCapture(c.report, c.artifacts, config)),
          ...(deps.onInterviewStage ? { onStage: deps.onInterviewStage } : {}),
        });
        deps.onInterviewControl?.({ advance: () => timeline.advance(), stop: () => timeline.stop() }); return timeline.run();
      };
      if (parsed.aggregate === 'interview') { const result = await interview(); return emit(result.exitCode, { kind: 'interview', result }, JSON.stringify(result)); }
      const result = await runWorkshopAggregate({ command: parsed.aggregate!, mode, drivers, limits: parsed.limits, ...(deps.clock ? { clock: deps.clock } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
        doctor: { limits: { requests: 30, cleanupRequests: 0 }, run: context => (deps.doctor ?? runDoctor)({ projectRoot: deps.projectRoot, config, credentials, mode, scope: 'catalog', limits: context.limits, parent: context.parent, clock: context.parent.clock, signal: context.signal, ...(deps.dispatch ? { dispatch: deps.dispatch } : {}) }) },
        ...(deps.deploymentCheck ? { deploymentCheck: deps.deploymentCheck } : {}), interviewCheck: { minimumRequests: 80, run: context => interview(context) },
      });
      const readiness = saveAggregateReadiness(deps.projectRoot, config, result);
      return emit(result.exitCode, { kind: 'aggregate', result, readiness: readiness.report, readinessPath: readiness.path }, JSON.stringify({ result, readiness: readiness.report, readinessPath: readiness.path }));
    }
    const journalOwner = randomUUID(); let journal: RunJournal | undefined; let stop = () => {}; let journalFailed = false;
    const append = (event: Parameters<RunJournal['append']>[1]) => { try { journal?.append(journalOwner, event); } catch { journalFailed = true; stop(); } };
    const hooks = {
      onStarted: (info: { runId: string; stop: () => void }) => { stop = info.stop; try { journal = new RunJournal(deps.projectRoot, config.evidenceDirectory, info.runId, redactor); journal.claim(journalOwner); append({ type: 'started', scenarioId: ScenarioId.parse(parsed.scenarioId), mode, labId: config.labId, accountId: config.accountId, zoneId: config.zoneId, releaseDigest: config.environments[0].releaseDigest }); if (journalFailed) throw new Error('Journal scope unavailable'); deps.onStarted?.(info); } catch { journalFailed = true; stop(); throw new Error('Run journal could not start'); } },
      onPhase: (phase: import('./lifecycle.js').Phase) => { append({ type: 'phase', phase }); deps.onPhase?.(phase); },
      onObservation: (observation: z.infer<typeof import('../../contracts/src/schemas.js').ObservationSchema>) => { append({ type: 'observation', observation }); deps.onObservation?.(observation); },
      onEvidence: (artifact: Artifact) => { append({ type: 'evidence', artifact }); deps.onEvidence?.(artifact); },
    };
    const common = {
      projectRoot: deps.projectRoot, config, credentials, mode, limits: parsed.limits,
      ...(deps.parent ? { parent: deps.parent } : {}), ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.dispatch ? { dispatch: deps.dispatch } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
      ownershipPreflight: { minimumRequests: (deps.ownershipRequests ?? OWNERSHIP_MIN_REQUESTS) + (config.rateLimitRuleId ? 1 : 0) + config.environments.reduce((n, e) => n + Math.max(0, e.imageIds.length - 1), 0), run: (client: GuardedClient, signal: AbortSignal) => deps.ownership ? deps.ownership(config, credentials, client, signal) : observeRuntimeOwnership(config, credentials.reader, client, signal) }, ...hooks,
    };
    const result = PolicyModule.safeParse(parsed.scenarioId).success ? await (deps.runWafCustom ?? runWafCustom)({
      ...common, scenarioId: PolicyModule.parse(parsed.scenarioId),
      ownershipPreflight: { minimumRequests: (deps.ownershipRequests ?? OWNERSHIP_MIN_REQUESTS) + (parsed.scenarioId === 'rate-limit' || config.rateLimitRuleId ? 1 : 0) + (parsed.scenarioId === 'bot' ? 1 : 0) + config.environments.reduce((n, e) => n + Math.max(0, e.imageIds.length - 1), 0), run: (client, signal) => deps.ownership ? deps.ownership(config, credentials, client, signal) : observeRuntimeOwnership(config, credentials.reader, client, signal) },
      ...(deps.dispatch ? { dispatch: deps.dispatch } : {}), ...(deps.signal ? { signal: deps.signal } : {}),
      onStarted: info => { stop = info.stop; try { journal = new RunJournal(deps.projectRoot, config.evidenceDirectory, info.runId, redactor); journal.claim(journalOwner); append({ type: 'started', scenarioId: PolicyModule.parse(parsed.scenarioId), mode, labId: config.labId, accountId: config.accountId, zoneId: config.zoneId, releaseDigest: config.environments[0].releaseDigest }); if (journalFailed) throw new Error('Journal scope unavailable'); deps.onStarted?.(info); } catch { journalFailed = true; stop(); throw new Error('Run journal could not start'); } },
      onPhase: phase => { append({ type: 'phase', phase }); deps.onPhase?.(phase); },
      onObservation: observation => { append({ type: 'observation', observation }); deps.onObservation?.(observation); },
      onEvidence: (artifact: Artifact) => { append({ type: 'evidence', artifact }); deps.onEvidence?.(artifact); },
    }) : await runWorkshopScenario({ ...common, ...deps.workshop, scenarioId: parsed.scenarioId as WorkshopScenario, ...(deps.onWaitingRoom ? { onWaitingRoom: deps.onWaitingRoom } : {}), ...(deps.onPreview ? { onPreview: deps.onPreview } : {}), ...(deps.onFrame ? { onFrame: deps.onFrame } : {}), ...(deps.onRoomControl ? { onRoomControl: deps.onRoomControl } : {}) });
    if (result.report.result.scenarioId !== parsed.scenarioId || result.report.mode !== mode || result.decision.mode !== mode || result.report.result.outcome !== result.decision.outcome) throw new Error('Scenario provenance differs from execution mode');
    append({ type: 'outcome', result: result.report.result });
    const directory = new ReportStore(deps.projectRoot, config.evidenceDirectory, redactor).save(result.report, result.artifacts);
    const code = deps.signal?.aborted ? 130 : journalFailed || !journal ? 3 : result.report.result.outcome === 'verified' ? 0 : 1;
    return emit(code, { kind: 'result', report: result.report, reportDirectory: directory, journalComplete: !!journal && !journalFailed, ...('executionAudit' in result ? { executionAudit: result.executionAudit } : {}) }, [`${result.report.result.scenarioId}: ${result.report.result.outcome}`, `Mode: ${result.report.mode}`, `Requests: ${result.report.result.requestsUsed}`, ...result.report.result.missingProof, `Report: ${directory}`].join('\n'));
  } catch { return emit(deps.signal?.aborted ? 130 : 3, { error: 'Demo execution or output failed; no saved/verified success is claimed.', outcome: 'inconclusive' }, 'Demo execution or output failed. No saved/verified success is claimed.'); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { const result = await runDemoCli(process.argv.slice(2), { projectRoot: process.cwd(), signal: controller.signal }); console.log(result.output); process.exitCode = result.exitCode; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
