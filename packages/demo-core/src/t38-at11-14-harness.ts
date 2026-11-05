import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { validateLabConfig } from './config.js';
import { parseDemoArgs, runDemoCli, type DemoCliDependencies } from './demo-cli.js';
import { ReportSchema, ReportStore } from './reports.js';

// Authorization is local permission to collect, never evidence of provider behavior.
const SOURCE_PATHS = [
  'apps/command-center/src/App.tsx', 'apps/control-server/src/app.ts',
  'apps/storefront-worker/src/worker.ts', 'apps/storefront-container/src/app.ts',
  'packages/demo-core/src/demo-cli.ts', 'packages/demo-core/src/workshop-runner.ts',
  'packages/demo-core/src/browser-transport.ts', 'packages/demo-core/src/waiting-room.ts',
  'packages/demo-core/src/trusted-collectors.ts', 'packages/demo-core/src/trusted-collectors-image.ts',
  'packages/demo-core/src/reports.ts', 'packages/demo-core/src/config.ts',
  'packages/demo-core/src/readiness-report-core.ts', 'packages/demo-core/src/deployment-verification-core.ts',
  'packages/demo-core/src/policy-view.ts', 'packages/demo-core/src/execution-audit.ts',
  'apps/storefront-worker/src/d1.ts', 'apps/storefront-worker/src/assets.ts',
  'apps/storefront-worker/src/telemetry.ts', 'packages/contracts/src/schemas.ts',
  'packages/contracts/src/waiting-room.ts', 'packages/contracts/src/service-read.ts',
  'packages/demo-core/src/t38-at11-14-harness.ts',
] as const;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function t38SourceDigest(root: string): string {
  return hash(SOURCE_PATHS.map(path => {
    const file = join(root, path); const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Unqualified source file');
    return `${path}:${hash(readFileSync(file, 'utf8'))}`;
  }).join('\n'));
}
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Step = z.strictObject({ command: z.enum(['doctor', 'waf-custom', 'waiting-room']), requests: z.number().int().min(1).max(100), maxRuntimeSeconds: z.number().int().min(1).max(120) });
const Plan = z.strictObject({ schemaVersion: z.literal(1), id: z.uuid(), mode: z.enum(['fixture', 'live']), issuedAt: z.number().int().nonnegative(), configDigest: Digest, sourceDigest: Digest, steps: z.array(Step).min(1).max(4) });
export type T38Plan = z.infer<typeof Plan>;
export const t38PlanDigest = (plan: T38Plan): string => hash(canonical(Plan.parse(plan)));
export function createT38Plan(root: string, config: unknown, mode: T38Plan['mode'], steps: T38Plan['steps'], now = Date.now(), sourceRoot = root): T38Plan {
  const plan = Plan.parse({ schemaVersion: 1, id: randomUUID(), mode, issuedAt: now, configDigest: hash(canonical(validateLabConfig(config, root))), sourceDigest: t38SourceDigest(sourceRoot), steps });
  if (plan.steps.reduce((n, s) => n + s.requests, 0) > 300 || plan.steps.reduce((n, s) => n + s.maxRuntimeSeconds, 0) > 900) throw new Error('Acceptance collection exceeds aggregate caps');
  for (const step of plan.steps) parseDemoArgs(args(step));
  return plan;
}
function args(step: T38Plan['steps'][number]): string[] {
  return [step.command, '--json', '--requests', String(step.requests), '--max-runtime', String(step.maxRuntimeSeconds), ...(step.command === 'doctor' ? ['--scope', 'core-waf'] : [])];
}
export interface T38Authorization { liveOptIn: boolean; approvedDigest: string; confirmation: string }
export interface T38StepResult { command: string; exitCode: number; runId: string | null; mode: 'fixture' | 'live'; requestsUsed: number | null; outcome: string; reportPath: string | null }
/** Actual CLI/runner/collector/report orchestration. It has no setup dependency.
 * Collection alone cannot pass AT-11/12/13/14: UI, isolation, source and fault
 * assertions remain separate executable tests, not caller-provided booleans.
 */
export async function executeT38Plan(input: {
  plan: unknown; authorization?: T38Authorization; config: unknown;
  dependencies: DemoCliDependencies; now?: number; sourceRoot?: string;
}): Promise<{ status: 'blocked' | 'incomplete'; reason: string; steps: T38StepResult[]; acceptancePassed: false }> {
  const stopped = { status: 'blocked' as const, reason: 'Exact current collection plan and explicit opt-in required', steps: [], acceptancePassed: false as const };
  let plan: T38Plan;
  try {
    plan = Plan.parse(input.plan); const a = input.authorization; const digest = t38PlanDigest(plan); const now = input.now ?? Date.now();
    // Gate before credentials, transports, browsers, configuration loaders or CLI.
    if (!a?.liveOptIn || a.approvedDigest !== digest || a.confirmation !== `RUN AT11-14 ${digest}` || now < plan.issuedAt || now - plan.issuedAt > 900000) return stopped;
    const config = validateLabConfig(input.config, input.dependencies.projectRoot);
    if (!config.liveOptIn || plan.configDigest !== hash(canonical(config)) || plan.sourceDigest !== t38SourceDigest(input.sourceRoot ?? input.dependencies.projectRoot)) return stopped;
    if (plan.steps.reduce((n, s) => n + s.requests, 0) > 300 || plan.steps.reduce((n, s) => n + s.maxRuntimeSeconds, 0) > 900) return stopped;
  } catch { return stopped; }
  const steps: T38StepResult[] = [];
  const config = structuredClone(input.config);
  for (const step of plan.steps) {
    if (input.dependencies.signal?.aborted) break;
    try {
      if (plan.sourceDigest !== t38SourceDigest(input.sourceRoot ?? input.dependencies.projectRoot)) return { ...stopped, reason: 'Source changed after approval; collection stopped', steps };
      const result = await runDemoCli(args(step), { ...input.dependencies, mode: plan.mode, loadConfig: () => structuredClone(config) });
      const value = JSON.parse(result.output);
      if (value.kind === 'result') {
        const report = ReportSchema.parse(value.report);
        if (report.mode !== plan.mode || report.result.scenarioId !== step.command) throw new Error('Foreign collection result');
        const stored = new ReportStore(input.dependencies.projectRoot, validateLabConfig(config, input.dependencies.projectRoot).evidenceDirectory).load(report.result.runId);
        if (canonical(stored) !== canonical(report)) throw new Error('Stored report differs');
        steps.push({ command: step.command, exitCode: result.exitCode, runId: report.result.runId, mode: report.mode, requestsUsed: report.result.requestsUsed, outcome: report.result.outcome, reportPath: join(validateLabConfig(config, input.dependencies.projectRoot).evidenceDirectory, 'runs', report.result.runId, 'report.json') });
      } else {
        // Never echo arbitrary output/errors or infer traffic counts from failure.
        steps.push({ command: step.command, exitCode: result.exitCode, runId: null, mode: plan.mode, requestsUsed: null, outcome: value.kind === 'doctor' ? 'doctor-only' : 'unavailable', reportPath: null });
      }
      if (result.exitCode !== 0) break;
    } catch { steps.push({ command: step.command, exitCode: 3, runId: null, mode: plan.mode, requestsUsed: null, outcome: 'collection-failed', reportPath: null }); break; }
  }
  return { status: 'incomplete', reason: 'Collected CLI evidence; full UI/service/isolation/queue/policy AT assertions still required', steps, acceptancePassed: false };
}
