import { z } from 'zod';
import { BudgetLedger, limitsFor, validatePlan, type Clock } from './budget.js';
import { scenario } from '../../../scenarios/catalog.js';
import { joinAnalytics, type AnalyticsInput, type AnalyticsSummary } from './analytics.js';
import { runSequenceSlot, validateCapture, type ScenarioCapture, type SequenceContext, type SequenceDriver } from './workshop-aggregation.js';

export const INTERVIEW_STAGES = Object.freeze([
  { id: 'storefronts', startMs: 0, endMs: 45000, scenarioId: null, purpose: 'Compare the same synthetic shop', action: 'Inspect paired storefronts', question: 'Where does application work run?' },
  { id: 'waf', startMs: 45000, endMs: 105000, scenarioId: 'waf-sqli', purpose: 'Keep inert attack-like inputs from the origin', action: 'Run the SQL-signature comparison', question: 'Which checks must stay in the app?' },
  { id: 'rate-limit', startMs: 105000, endMs: 165000, scenarioId: 'rate-limit', purpose: 'Bound API admission', action: 'Run the bounded API comparison', question: 'Which counting key keeps shoppers apart?' },
  { id: 'waiting-room', startMs: 165000, endMs: 240000, scenarioId: 'waiting-room', purpose: 'Queue visitors while admitted shoppers continue', action: 'Observe actual browser sessions and admission', question: 'How does the admission policy protect availability?' },
  { id: 'analytics', startMs: 240000, endMs: 300000, scenarioId: 'analytics', purpose: 'Explain collected evidence and its limits', action: 'Reuse collected observations without probes', question: 'What evidence would change the explanation?' },
] as const);
export type InterviewStageId = typeof INTERVIEW_STAGES[number]['id'];
export interface InterviewStageView {
  id: InterviewStageId; startMs: number; endMs: number; remainingMs: number; elapsedMs?: number; requestsUsed?: number;
  purpose: string; action: string; question: string;
  customerNotes: { problem: string; solution: string; limitations: string };
}
export interface InterviewStageResult {
  id: InterviewStageId; startedMs: number; finishedMs: number;
  outcome: 'verified' | 'failed' | 'inconclusive' | 'unavailable' | 'skipped';
  capture: ScenarioCapture | null; analytics: AnalyticsSummary | null;
  missingProof: string[]; fallbackLabel: 'SAVED EVIDENCE' | null;
}
export interface InterviewOptions {
  mode: 'live' | 'fixture'; clock?: Clock; signal?: AbortSignal; parent?: BudgetLedger;
  limits?: { requests?: number };
  storefronts: { run(context: SequenceContext): Promise<{ mode: 'live' | 'fixture'; deploymentVerified: boolean }> };
  drivers: Partial<Record<'waf-sqli' | 'rate-limit' | 'waiting-room', SequenceDriver>>;
  /** Derive source metadata from collected evidence, never refresh the network. */
  analyticsInput(captures: readonly ScenarioCapture[]): readonly AnalyticsInput[];
  fallbackAvailable?: (stage: InterviewStageId) => boolean;
  onStage?: (view: InterviewStageView) => void;
}
export interface InterviewRun {
  mode: 'live' | 'fixture'; stages: InterviewStageResult[];
  requestsUsed: number; durationMs: number; sequenceCompleted: boolean;
  interviewVerified: boolean; exitCode: 0 | 1 | 130;
}
/** Fixed offsets are relative to construction. Advance changes the active
 * presentation only; it never shifts the next stage's absolute hard end. */
export class InterviewTimeline {
  readonly #parent: BudgetLedger;
  readonly #start: number;
  readonly #stop = new AbortController();
  #active: AbortController | null = null;
  #running = false; #finished = false;
  constructor(readonly options: InterviewOptions) {
    z.enum(['live', 'fixture']).parse(options.mode);
    this.#parent = new BudgetLedger({ scope: 'interview', limits: { ...options.limits, cleanupRequests: 0, cleanupMs: 0 }, ...(options.clock ? { clock: options.clock } : {}), ...(options.parent ? { parent: options.parent } : {}) });
    this.#start = this.#parent.clock.now();
  }
  advance(): void { if (this.#active && !this.#stop.signal.aborted) this.#active.abort('Presenter advanced'); }
  stop(): void { this.#stop.abort('Presenter stopped'); this.#active?.abort(); }
  async run(): Promise<InterviewRun> {
    if (this.#running || this.#finished) throw new Error('Interview timeline is single-use');
    this.#running = true;
    const stages: InterviewStageResult[] = []; const captures: ScenarioCapture[] = [];
    const signal = AbortSignal.any([this.#stop.signal, this.#parent.signal, ...(this.options.signal ? [this.options.signal] : [])]);
    try {
      for (const stage of INTERVIEW_STAGES) {
        const startedMs = this.#parent.clock.now() - this.#start;
        let outcome: InterviewStageResult['outcome'] = 'skipped'; let capture: ScenarioCapture | null = null;
        let analytics: AnalyticsSummary | null = null; const missingProof: string[] = [];
        if (signal.aborted) missingProof.push('Interview stopped');
        else if (startedMs >= stage.endMs) missingProof.push('Fixed stage slot already elapsed');
        else {
          const stageController = new AbortController(); this.#active = stageController;
          const stageSignal = AbortSignal.any([signal, stageController.signal]);
          const manifest = stage.scenarioId ? scenario(stage.scenarioId) : null;
          this.options.onStage?.({ ...stage, elapsedMs: startedMs, requestsUsed: this.#parent.snapshot.requestsUsed, remainingMs: Math.min(stage.endMs - startedMs, stage.endMs - stage.startMs),
            customerNotes: manifest ? { ...manifest.notes } : { problem: 'Two different apps cannot form a fair comparison', solution: 'Use the same release and synthetic content', limitations: 'Reachability alone is not deployment proof' } });
          if (stage.id === 'analytics') {
            try {
              const used = this.#parent.snapshot.requestsUsed;
              const inputs = this.options.analyticsInput(captures);
              const summaries = inputs.map(joinAnalytics);
              if (this.#parent.snapshot.requestsUsed !== used) throw new Error('Analytics cannot dispatch probes');
              const validScope = inputs.every(input => captures.some(c => c.report.result.runId === input.scope.runId && c.report.result.scenarioId === input.scope.scenarioId && c.report.mode === input.scope.mode));
              if (!validScope || !summaries.length) throw new Error('Analytics requires collected same-run evidence');
              analytics = summaries.at(-1)!;
              outcome = summaries.every(s => s.outcome === 'verified') ? 'verified' : 'inconclusive';
            } catch { outcome = 'inconclusive'; missingProof.push('Collected analytics evidence is incomplete'); }
          } else {
            const driver = stage.scenarioId ? this.options.drivers[stage.scenarioId] : undefined;
            if (stage.id !== 'storefronts' && !driver) { outcome = 'unavailable'; missingProof.push('Required scenario adapter is unavailable'); }
            else if (driver?.nextEligibleAt !== undefined && this.#parent.clock.now() < driver.nextEligibleAt) { outcome = 'unavailable'; missingProof.push('Declared cooldown has not elapsed'); }
            else {
              try {
              const remaining = Math.min(stage.endMs - startedMs, stage.endMs - stage.startMs);
              const limits = limitsFor('scenario', { ...(manifest?.budget ?? {}), ...driver?.limits, maxRuntimeMs: Math.min(driver?.limits?.maxRuntimeMs ?? (stage.id === 'waiting-room' ? 75000 : remaining), remaining) });
              const minimum = driver?.minimumRequests ?? manifest?.minimumRequests ?? 2;
              validatePlan(limits, minimum, manifest?.budget.sessions ?? 0, driver?.minimumWorkMs ?? 0);
              if (minimum + limits.cleanupRequests > this.#parent.limits.requests - this.#parent.snapshot.requestsUsed || limits.cleanupMs >= limits.maxRuntimeMs || (driver?.minimumWorkMs ?? 0) + limits.cleanupMs > limits.maxRuntimeMs) { outcome = 'skipped'; missingProof.push('Stage proof and cleanup cannot fit remaining limits'); }
              else {
                const result = await runSequenceSlot(this.#parent, limits, async context => {
                  if (stage.id === 'storefronts') return { storefronts: await this.options.storefronts.run(context), capture: null };
                  return { storefronts: null, capture: await driver!.run(context) };
                }, stageSignal);
                if (result.state !== 'completed') { outcome = 'inconclusive'; missingProof.push(`Stage ${result.state}; cleanup acknowledgement unavailable`); }
                else if (result.value.capture) {
                  try {
                    capture = validateCapture(result.value.capture, manifest!.id, this.options.mode);
                    if (capture.report.result.requestsUsed !== result.requestsUsed) throw new Error('Stage bypassed aggregate budget');
                    captures.push(capture);
                    outcome = capture.report.result.outcome;
                    if (capture.report.result.cleanup === 'incomplete' && outcome === 'verified') outcome = 'inconclusive';
                  } catch { outcome = 'inconclusive'; missingProof.push('Stage evidence validation failed'); }
                } else outcome = result.value.storefronts?.deploymentVerified && result.value.storefronts.mode === this.options.mode ? 'verified' : 'inconclusive';
                if (result.state === 'completed' && result.interruption) { if (outcome !== 'failed') outcome = 'inconclusive'; missingProof.push(`Stage ${result.interruption}; partial evidence retained`); }
              }
              } catch { outcome = 'unavailable'; missingProof.push('Invalid stage plan or proof cannot fit its slot'); }
            }
          }
          if (stageSignal.aborted && outcome !== 'failed') { outcome = 'inconclusive'; missingProof.push('Stage stopped or advanced before proof completed'); }
          // Hold a finished stage for discussion until its original end, unless
          // the presenter advances. Holding never sends requests or resets time.
          if (!stageSignal.aborted && this.#parent.clock.now() < this.#start + stage.endMs) {
            await new Promise<void>(resolve => {
              const done = () => { cancel(); stageSignal.removeEventListener('abort', done); resolve(); };
              const cancel = this.#parent.clock.schedule(this.#start + stage.endMs - this.#parent.clock.now(), done);
              stageSignal.addEventListener('abort', done, { once: true });
              if (stageSignal.aborted) done();
            });
          }
          this.#active = null;
        }
        stages.push({ id: stage.id, startedMs, finishedMs: this.#parent.clock.now() - this.#start, outcome, capture, analytics, missingProof,
          fallbackLabel: outcome !== 'verified' && this.options.fallbackAvailable?.(stage.id) ? 'SAVED EVIDENCE' : null });
      }
      const stopped = this.#stop.signal.aborted || !!this.options.signal?.aborted;
      const complete = !stopped && stages.every(s => s.outcome === 'verified');
      return { mode: this.options.mode, stages, requestsUsed: this.#parent.snapshot.requestsUsed, durationMs: this.#parent.clock.now() - this.#start,
        sequenceCompleted: !stopped && stages.every(s => s.outcome !== 'skipped'), interviewVerified: this.options.mode === 'live' && complete,
        exitCode: stopped ? 130 : complete ? 0 : 1 };
    } finally { this.#active = null; this.#finished = true; this.#parent.stop('Interview finished'); }
  }
}
