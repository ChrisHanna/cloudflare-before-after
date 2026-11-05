import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DeploymentToolError } from './deployment-diagnostics.js';
import type { SetupContext, SetupExecutor } from './deployment-apply.js';
import type { DeploymentTools } from './deployment-tools.js';
import type { Dispatch } from './transport.js';
import { isApprovedReadGraphqlBody } from './graphql.js';

const ScopeSchema = z.strictObject({
  runId: z.uuid(), releaseDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(), mode: z.enum(['fixture', 'live']),
  accountId: z.string().regex(/^[a-f0-9]{32}$/), zoneId: z.string().regex(/^[a-f0-9]{32}$/),
});
const Origin = z.url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && u.origin === value && !u.username && !u.password && !u.port;
});
const TargetsSchema = z.strictObject({ before: Origin, after: Origin, telemetry: Origin });
export type ExecutionAuditScope = Readonly<z.infer<typeof ScopeSchema>>;
export type ExecutionAuditTargets = Readonly<z.infer<typeof TargetsSchema>>;
export type ExecutionAuditPhase = 'deployment' | 'verification' | 'interview';
export type ExecutionAuditBoundary = 'setup-executor' | 'setup-context' | 'deployment-tools' | 'provider-dispatch' | 'runtime-dispatch' | 'native-dispatch' | 'browser-dispatch';
type Effect = 'read' | 'setup' | 'scenario-write' | 'unknown';
type State = 'attempt' | 'completed' | 'blocked' | 'failed';
export interface ExecutionAuditEvent {
  readonly sequence: number;
  readonly operationId: string;
  readonly boundary: ExecutionAuditBoundary;
  readonly operation: string;
  readonly phase: ExecutionAuditPhase;
  readonly effect: Effect;
  readonly state: State;
  /** Successful writes are observed; failed writes can still have changed state. */
  readonly mutation: 'none' | 'observed' | 'possible';
  readonly scopeDigest: string;
  readonly previousDigest: string;
  readonly digest: string;
}
export interface ExecutionAuditEvidence {
  readonly schemaVersion: 1;
  readonly auditId: string;
  readonly scope: ExecutionAuditScope;
  readonly scopeDigest: string;
  readonly targetsDigest: string;
  readonly coverage: readonly ExecutionAuditBoundary[];
  readonly phases: readonly ExecutionAuditPhase[];
  readonly events: readonly ExecutionAuditEvent[];
  readonly digest: string;
}
export interface ExecutionAuditAssessment {
  readonly outcome: 'clean-boundaries' | 'repair-detected' | 'unknown';
  readonly noRepairObserved: boolean;
  /** Wrappers alone cannot attest that shared composition roots use them. */
  readonly readinessClaimValid: false;
  readonly blockers: readonly string[];
  readonly attempts: number;
  readonly blockedAttempts: number;
  readonly observedMutations: number;
  readonly possibleMutations: number;
}
export interface ExecutionAudit {
  hookSetupExecutor(executor: SetupExecutor): SetupExecutor;
  hookSetupContext(context: SetupContext): SetupContext;
  hookDeploymentTools(tools: DeploymentTools): DeploymentTools;
  hookProviderDispatch(dispatch: Dispatch): Dispatch;
  hookRuntimeDispatch(dispatch: Dispatch): Dispatch;
  hookNativeDispatchFactory(): (dispatch: Dispatch) => Dispatch;
  hookBrowserDispatch(dispatch: Dispatch): Dispatch;
  beginVerification(): void;
  beginInterview(): void;
  /** Refuses an open operation. The result is immutable, bounded and process-local. */
  finish(): ExecutionAuditEvidence;
}

const REQUIRED: readonly ExecutionAuditBoundary[] = Object.freeze(['setup-executor', 'setup-context', 'deployment-tools', 'provider-dispatch', 'runtime-dispatch']);
const WIRING_GAP = 'Shared apply/live/runtime/AT-15/golden-path composition roots must install these hooks and consume this audit; unwrapped I/O and external console repair remain unobserved';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A checksum is not authority. Only this process's finished, exact object is known.
const issued = new WeakMap<object, { scopeDigest: string; assessment: ExecutionAuditAssessment }>();
function assessment(value: ExecutionAuditAssessment): ExecutionAuditAssessment {
  return Object.freeze({ ...value, blockers: Object.freeze([...value.blockers]) });
}
export function assessExecutionAudit(evidence: unknown, expected: ExecutionAuditScope): ExecutionAuditAssessment {
  const scope = ScopeSchema.safeParse(expected);
  const known = typeof evidence === 'object' && evidence !== null ? issued.get(evidence) : undefined;
  if (!scope.success || !known || known.scopeDigest !== digest(scope.data)) {
    return assessment({ outcome: 'unknown', noRepairObserved: false, readinessClaimValid: false,
      blockers: ['Missing, foreign, copied or untrusted execution audit', WIRING_GAP], attempts: 0,
      blockedAttempts: 0, observedMutations: 0, possibleMutations: 0 });
  }
  return known.assessment;
}

/** Boundary adapters, not a caller-fed recorder. No public append/count/coverage API.
 * Install before deployment, then keep the same audit through verification/interview.
 * Hashes cover ONLY fixed operation labels, scope and event order, never secrets.
 * This cannot observe a caller retaining a raw dependency or a separate console.
 * Those central wiring gaps always prevent a readiness claim, even with no events.
 */
export function createExecutionAudit(input: ExecutionAuditScope, targetInput: ExecutionAuditTargets): ExecutionAudit {
  const scope = Object.freeze(ScopeSchema.parse(input));
  const targets = Object.freeze(TargetsSchema.parse(targetInput));
  if (new Set(Object.values(targets)).size !== 3 || Object.values(targets).includes('https://api.cloudflare.com')) throw new Error('Distinct lab audit targets required');
  const scopeDigest = digest(scope); const targetsDigest = digest(targets); const auditId = randomUUID();
  const events: ExecutionAuditEvent[] = []; const coverage = new Set<ExecutionAuditBoundary>();
  const phases: ExecutionAuditPhase[] = ['deployment'];
  let phase: ExecutionAuditPhase = 'deployment'; let finished: ExecutionAuditEvidence | undefined;
  let pending = 0; let operations = 0; let overflow = false; let postSealAttempt = false;
  let chain = digest({ auditId, scopeDigest, targetsDigest });
  const ensureOpen = () => {
    if (finished) {
      postSealAttempt = true;
      const prior = issued.get(finished)!.assessment;
      issued.set(finished, { scopeDigest, assessment: assessment({ ...prior,
        outcome: prior.outcome === 'repair-detected' ? 'repair-detected' : 'unknown', noRepairObserved: false,
        blockers: [...new Set([...prior.blockers, 'Execution attempted after audit seal'])],
        attempts: Math.min(Number.MAX_SAFE_INTEGER, prior.attempts + 1), blockedAttempts: Math.min(Number.MAX_SAFE_INTEGER, prior.blockedAttempts + 1) }) });
      throw new Error('Execution audit is sealed');
    }
  };
  const hook = (boundary: ExecutionAuditBoundary) => {
    ensureOpen();
    if (phase !== 'deployment') throw new Error('Audit hooks must be installed before verification');
    coverage.add(boundary);
  };
  const record = (operationId: string, boundary: ExecutionAuditBoundary, operation: string, operationPhase: ExecutionAuditPhase, effect: Effect, state: State, mutation: ExecutionAuditEvent['mutation']) => {
    const value = { sequence: events.length + 1, operationId, boundary, operation, phase: operationPhase, effect, state, mutation, scopeDigest, previousDigest: chain };
    chain = digest(value); events.push(Object.freeze({ ...value, digest: chain }));
  };
  const invoke = async <T>(boundary: ExecutionAuditBoundary, operation: string, effect: Effect, action: () => Promise<T>, succeeded: (value: T) => boolean = () => true): Promise<T> => {
    ensureOpen();
    // Two records per operation, including denied attempts. Overflow poisons claims.
    if (++operations > 2048) { overflow = true; throw new Error('Execution audit event cap reached'); }
    const operationId = `${auditId}:${operations}`; const operationPhase = phase;
    record(operationId, boundary, operation, operationPhase, effect, 'attempt', 'none');
    if (effect === 'unknown' || effect === 'setup' && operationPhase !== 'deployment') {
      record(operationId, boundary, operation, operationPhase, effect, 'blocked', 'none');
      throw new Error('Execution audit blocked setup repair or unknown operation');
    }
    const writing = effect === 'setup' || effect === 'scenario-write';
    pending++;
    try {
      const result = await action();
      const ok = succeeded(result);
      record(operationId, boundary, operation, operationPhase, effect, ok ? 'completed' : 'failed', writing ? ok ? 'observed' : 'possible' : 'none');
      return result;
    } catch (error) {
      record(operationId, boundary, operation, operationPhase, effect, 'failed', writing ? 'possible' : 'none');
      // Reconstruct only strict, allowlisted tool metadata; never preserve raw errors.
      if (error instanceof DeploymentToolError) throw new DeploymentToolError(error.failure);
      // Do not retain or export raw executor errors, responses, args or credentials.
      throw new Error('Audited boundary failed; inspect scoped audit records');
    } finally { pending--; }
  };
  const advance = (next: 'verification' | 'interview') => {
    ensureOpen();
    if (pending || overflow || (next === 'verification' ? phase !== 'deployment' : phase !== 'verification')) throw new Error('Invalid or busy execution audit phase');
    phase = next; phases.push(next);
  };
  const dispatchHook = (boundary: 'provider-dispatch' | 'runtime-dispatch' | 'native-dispatch' | 'browser-dispatch', dispatch: Dispatch, install = true): Dispatch => {
    if (install) hook(boundary);
    // Capture the function, never a caller-mutated options object or event list.
    return async (url, init) => {
      let operation = 'dispatch.unknown'; let effect: Effect = 'unknown';
      try {
        const u = new URL(url); const method = (init.method ?? 'GET').toUpperCase();
        const normal = u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.hash && !/%|\\/.test(u.pathname) && new URL(u.pathname, u.origin).pathname === u.pathname;
        if (normal && boundary === 'provider-dispatch' && u.origin === 'https://api.cloudflare.com') {
          const account = `/client/v4/accounts/${scope.accountId}`; const zone = `/client/v4/zones/${scope.zoneId}`;
          const scoped = u.pathname === account || u.pathname.startsWith(`${account}/`) || u.pathname === zone || u.pathname.startsWith(`${zone}/`);
          const graphql = u.pathname === '/client/v4/graphql' && method === 'POST' && typeof init.body === 'string' && isApprovedReadGraphqlBody(init.body) && (JSON.parse(init.body).query as string).includes(`zoneTag: "${scope.zoneId}"`);
          // Discovery token inspection is read-only, scoped by the caller's existing client.
          const tokenRead = method === 'GET' && /^\/client\/v4\/user\/tokens\/(?:verify|[a-f0-9]{32})$/.test(u.pathname);
          if (graphql || tokenRead || scoped && ['GET', 'HEAD'].includes(method)) { operation = 'provider.read'; effect = 'read'; }
          else if (scoped && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) { operation = 'provider.write'; effect = 'setup'; }
        } else if (normal && boundary !== 'provider-dispatch') {
          const storefront = u.origin === targets.before || u.origin === targets.after;
          const readonly = ['/', '/catalog', '/launch', '/api', '/admin', '/register', '/health', '/internal/checkpoint', '/internal/service-read', '/internal/registration-config', '/internal/registration-evidence'];
          if (storefront && u.pathname === '/internal/seed') { operation = 'storefront.seed'; effect = 'setup'; }
          else if (storefront && ['GET', 'HEAD'].includes(method) && readonly.includes(u.pathname)) { operation = 'storefront.read'; effect = 'read'; }
          else if (storefront && method === 'POST' && ['/register', '/internal/registrations/cleanup'].includes(u.pathname)) {
            // Correlation/body checks are necessary, not a substitute for Worker authorization.
            const headers = new Headers(init.headers); const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : null;
            const owned = u.pathname === '/register' ? headers.get('x-demo-run-id') === scope.runId && headers.get('x-demo-scenario') === 'turnstile' : body?.['runId'] === scope.runId && Object.keys(body).length === 1;
            if (owned) { operation = 'storefront.scenario-write'; effect = 'scenario-write'; }
          } else if (u.origin === targets.telemetry && method === 'GET' && u.pathname === '/receipts') { operation = 'telemetry.read'; effect = 'read'; }
          else if (u.origin === 'https://imagedelivery.net' && method === 'GET') { operation = 'images.read'; effect = 'read'; }
        }
      } catch { /* Malformed/unknown operations are recorded and blocked below. */ }
      return invoke(boundary, operation, effect, () => dispatch(url, init), response => response.ok);
    };
  };
  const ownsContext = (context: SetupContext) => context.plan.id === scope.runId && context.plan.intentDigest === scope.configurationDigest && (scope.sourceDigest === undefined || context.plan.sourceDigest === scope.sourceDigest) && context.plan.mode === scope.mode && context.plan.intent.releaseDigest === scope.releaseDigest && context.plan.intent.discovery.accountId === scope.accountId && context.plan.intent.discovery.zoneId === scope.zoneId;
  const api: ExecutionAudit = {
    hookSetupExecutor(executor: SetupExecutor): SetupExecutor {
      const execute = executor.execute.bind(executor); const close = executor.close.bind(executor); const mode = executor.mode;
      if (mode !== scope.mode) throw new Error('Execution audit executor mode differs');
      hook('setup-executor');
      return Object.freeze<SetupExecutor>({ mode,
        execute: (step, context) => invoke('setup-executor', 'executor.execute', ownsContext(context) ? 'setup' : 'unknown', () => execute(step, context)),
        close: () => invoke('setup-executor', 'executor.close', 'read', close),
      });
    },
    hookSetupContext(context: SetupContext): SetupContext {
      if (!ownsContext(context)) throw new Error('Foreign setup context cannot cover this audit');
      hook('setup-context'); const perform = context.perform.bind(context); const observeResource = context.observeResource.bind(context);
      return Object.freeze<SetupContext>({ signal: context.signal, plan: context.plan,
        perform: <T>(kind: string, ownedId: string, action: () => Promise<T>) => invoke('setup-context', 'context.perform', 'setup', () => perform(kind, ownedId, action)),
        // Metadata notification performs no provider write and carries no evidence authority.
        observeResource: (kind: string, ownedId: string) => { ensureOpen(); observeResource(kind, ownedId); },
      });
    },
    hookDeploymentTools(tools: DeploymentTools): DeploymentTools {
      hook('deployment-tools');
      const verifyVersions = tools.verifyVersions.bind(tools); const terraform = tools.terraform.bind(tools);
      const applyTerraform = tools.applyTerraform.bind(tools); const wrangler = tools.wrangler.bind(tools); const close = tools.close.bind(tools);
      return Object.freeze<DeploymentTools>({
        verifyVersions: signal => invoke('deployment-tools', 'tools.versions', 'read', () => verifyVersions(signal)),
        terraform: (args, cwd, signal) => {
          const command = args[0]; const read = command === 'version' || command === 'show' || command === 'output';
          const prepare = command === 'init' || command === 'plan';
          return invoke('deployment-tools', read ? 'terraform.read' : prepare ? 'terraform.prepare' : 'terraform.unknown', read ? 'read' : prepare ? 'setup' : 'unknown', () => terraform(args, cwd, signal));
        },
        applyTerraform: (path, cwd, signal) => invoke('deployment-tools', 'terraform.apply', 'setup', () => applyTerraform(path, cwd, signal)),
        wrangler: (args, cwd, signal, input) => invoke('deployment-tools', 'wrangler.write', 'setup', () => wrangler(args, cwd, signal, input)),
        close: () => invoke('deployment-tools', 'tools.close', 'read', close),
      });
    },
    hookProviderDispatch: dispatch => dispatchHook('provider-dispatch', dispatch),
    hookRuntimeDispatch: dispatch => dispatchHook('runtime-dispatch', dispatch),
    hookBrowserDispatch: dispatch => dispatchHook('browser-dispatch', dispatch),
    hookNativeDispatchFactory: () => { hook('native-dispatch'); return dispatch => dispatchHook('native-dispatch', dispatch, false); },
    beginVerification: () => advance('verification'),
    beginInterview: () => advance('interview'),
    finish(): ExecutionAuditEvidence {
      if (finished) return finished;
      if (pending) throw new Error('Execution audit has unfinished operations');
      const missing = REQUIRED.filter(boundary => !coverage.has(boundary));
      const attempts = events.filter(e => e.state === 'attempt' && e.phase !== 'deployment');
      const repairs = attempts.filter(e => e.effect === 'setup');
      const unknown = attempts.some(e => e.effect === 'unknown');
      const terminal = events.filter(e => e.state !== 'attempt' && e.phase !== 'deployment');
      const failed = terminal.some(e => e.state === 'failed');
      const emptyWindows = phases.filter(p => p !== 'deployment' && !terminal.some(e => e.phase === p && e.state === 'completed' && (e.boundary === 'provider-dispatch' || e.boundary === 'runtime-dispatch')));
      const blockers = [WIRING_GAP, ...missing.map(boundary => `Missing boundary: ${boundary}`),
        ...emptyWindows.map(p => `No completed transport observation in ${p}`),
        ...(failed ? ['Failed boundary observation; mutation or observation completeness is uncertain'] : []),
        ...(!phases.includes('verification') ? ['Verification window missing'] : []),
        ...(overflow ? ['Execution audit event cap reached'] : []), ...(unknown ? ['Unknown operation attempted'] : []),
        ...(repairs.length ? ['Setup or repair attempted after deployment'] : [])];
      const complete = !missing.length && phases.includes('verification') && !emptyWindows.length && !failed && !overflow && !unknown && !postSealAttempt;
      const data = { schemaVersion: 1 as const, auditId, scope, scopeDigest, targetsDigest,
        coverage: Object.freeze([...coverage]), phases: Object.freeze([...phases]), events: Object.freeze([...events]) };
      finished = Object.freeze({ ...data, digest: digest(data) });
      issued.set(finished, { scopeDigest, assessment: assessment({
        outcome: repairs.length ? 'repair-detected' : complete ? 'clean-boundaries' : 'unknown',
        noRepairObserved: complete && !repairs.length, readinessClaimValid: false, blockers,
        attempts: attempts.length, blockedAttempts: terminal.filter(e => e.state === 'blocked').length,
        observedMutations: terminal.filter(e => e.mutation === 'observed').length,
        possibleMutations: terminal.filter(e => e.mutation === 'possible').length,
      }) });
      return finished;
    },
  };
  return Object.freeze(api);
}
