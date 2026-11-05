import { z } from 'zod';
import { readWorkerCodeMaterial, type WorkerCodeMaterial } from './worker-code.js';
import { isApprovedReadGraphqlBody } from './graphql.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { RayId, Digest, Role } from '../../contracts/src/schemas.js';
import { BudgetLedger, type Clock, type RequestReservation } from './budget.js';
import { assertLiveReady, validateRedirect, validateTarget, type TargetConfig, type TargetKind } from './config.js';

export type Dispatch = (url: string, init: RequestInit) => Promise<Response>;
export interface RequestPlan {
  url: string; kind: TargetKind; method?: 'GET' | 'POST' | 'HEAD';
  headers?: Readonly<Record<string, string>>; body?: string;
  followRedirects?: boolean; maxRedirects?: number; retries?: number;
  /** Return the enforcement response without retaining or following Location. */
  observeRedirect?: boolean;
}
export interface SafeResponse {
  status: number; excerpt: string; rayId: string | null; latencyMs: number;
  metadata: { role: 'before' | 'after' | null; releaseDigest: string | null; services: string[]; contentType: string | null; bodyBytes: number };
}
const SAFE_HEADERS = new Set(['accept', 'user-agent', 'content-type', 'authorization', 'cf-access-client-id', 'cf-access-client-secret', 'x-demo-run-id', 'x-demo-request-id', 'x-demo-scenario', 'x-demo-run-token', 'x-demo-test']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

async function boundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new Error('Response exceeds byte limit'); }
      chunks.push(part.value);
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytes: length };
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
function delay(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Request aborted')); return; }
    const abort = () => { cancel(); signal.removeEventListener('abort', abort); reject(new Error('Request aborted')); };
    const cancel = clock.schedule(ms, () => { signal.removeEventListener('abort', abort); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}
export class GuardedClient {
  readonly #dispatch: Dispatch;
  readonly #purpose: 'runtime' | 'discovery';
  constructor(readonly config: TargetConfig, readonly ledger: BudgetLedger, options: { observedOwnedResources: ReadonlySet<string>; dispatch?: Dispatch; redactor?: Redactor; purpose?: 'runtime' | 'discovery' }) {
    this.#purpose = options.purpose ?? 'runtime';
    if (this.#purpose === 'discovery') {
      if (!config.liveOptIn || !config.ownedLab || config.purpose !== 'synthetic-lab') throw new Error('Explicit owned-lab discovery opt-in required');
    } else {
      if (!('inventory' in config)) throw new Error('Runtime traffic requires deployed resource inventory');
      assertLiveReady(config, options.observedOwnedResources);
    }
    this.#dispatch = options.dispatch ?? ((url, init) => fetch(url, init));
    this.redactor = options.redactor ?? new Redactor();
  }
  readonly redactor: Redactor;
  async request(plan: RequestPlan, signal?: AbortSignal, reservation?: RequestReservation): Promise<SafeResponse> {
    const { data: _data, ...result } = await this.#perform(plan, undefined, signal, false, reservation);
    return result;
  }
  async requestJson<S extends z.ZodType>(plan: RequestPlan, schema: S, signal?: AbortSignal, reservation?: RequestReservation): Promise<SafeResponse & { data: z.infer<S> }> {
    const result = await this.#perform(plan, text => JSON.parse(this.redactor.serialize(schema, JSON.parse(text))) as z.infer<S>, signal, false, reservation);
    return { ...result, data: result.data as z.infer<S> };
  }
  async requestWorkerCode(role: 'before' | 'after', readerCredential: string, signal?: AbortSignal): Promise<SafeResponse & { code: WorkerCodeMaterial | null }> {
    Role.parse(role);
    if (this.#purpose !== 'runtime' || !('inventory' in this.config)) throw new Error('Worker code requires verified owned runtime inventory');
    const env = this.config.environments.find(env => env.role === role)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(env.workerName)) throw new Error('Invalid owned Worker name');
    if (!z.string().min(24).max(256).safeParse(readerCredential).success) throw new Error('Reader credential unavailable');
    const result = await this.#perform({ kind: 'cloudflare', url: `${this.config.apiOrigin}/client/v4/accounts/${this.config.accountId}/workers/scripts/${encodeURIComponent(env.workerName)}/content/v2`,
      headers: { authorization: `Bearer ${readerCredential}`, accept: 'string' }, retries: 0 }, undefined, signal, true);
    const { data: _data, code, ...safe } = result;
    return { ...safe, code: code ?? null };
  }
  async #perform<T>(plan: RequestPlan, parse: ((text: string) => T) | undefined, signal?: AbortSignal, codeOnly = false, reservation?: RequestReservation): Promise<SafeResponse & { data: T | undefined; code?: WorkerCodeMaterial | undefined }> {
    const method = plan.method ?? 'GET';
    const guardTarget = (u: URL) => {
      const graphqlRead = plan.kind === 'cloudflare' && method === 'POST' && u.pathname === '/client/v4/graphql' && isApprovedReadGraphqlBody(plan.body);
      if (!['before', 'after'].includes(plan.kind) && method !== 'GET' && !graphqlRead) throw new Error('Control-plane clients are read-only');
      // All supported control-plane IDs/names use literal ASCII path segments.
      // Reject ambiguous encodings rather than guess a provider's decode rules.
      if (plan.kind === 'cloudflare' && (u.pathname.includes('%') || u.pathname.includes('//'))) throw new Error('Ambiguous control-plane path');
      if (!codeOnly && plan.kind === 'cloudflare' && /\/workers\/scripts\/[^/]+\/content(?:\/v2)?\/?$/i.test(u.pathname)) throw new Error('Worker content requires the hash-only read');
      if (this.#purpose === 'discovery') {
        const prefix = '/client/v4/';
        const account = `${prefix}accounts/${this.config.accountId}`;
        const zone = `${prefix}zones/${this.config.zoneId}`;
        const scoped = u.pathname === account || u.pathname.startsWith(`${account}/`) || u.pathname === zone || u.pathname.startsWith(`${zone}/`) || u.pathname === `${prefix}user/tokens/verify` || /^\/client\/v4\/user\/tokens\/[a-f0-9]{32}$/.test(u.pathname) || (u.pathname === `${prefix}graphql` && isApprovedReadGraphqlBody(plan.body) && (JSON.parse(plan.body!).query as string).includes(`zoneTag: "${this.config.zoneId}"`));
        if (plan.kind !== 'cloudflare' || !scoped) throw new Error('Discovery is restricted to configured-account control-plane reads');
      }
    };
    guardTarget(new URL(plan.url));
    if (plan.observeRedirect && (plan.followRedirects || plan.kind !== 'after' || method !== 'GET' || new URL(plan.url).pathname !== '/admin')) throw new Error('Redirect observation is restricted to protected Access enforcement');
    const retries = plan.retries ?? 0; const maxRedirects = plan.maxRedirects ?? 3;
    if (!Number.isInteger(retries) || retries < 0 || retries > 3 || !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3) throw new Error('Invalid bounded retry/redirect plan');
    if (!['GET', 'POST', 'HEAD'].includes(method)) throw new Error('Unsupported request method');
    const isGraphqlRead = plan.kind === 'cloudflare' && method === 'POST' && new URL(plan.url).pathname === '/client/v4/graphql' && isApprovedReadGraphqlBody(plan.body);
    if (!['before', 'after'].includes(plan.kind) && method !== 'GET' && !isGraphqlRead) throw new Error('Control-plane clients are read-only');
    if (plan.body !== undefined && (method !== 'POST' || Buffer.byteLength(plan.body) > 8192)) throw new Error('Invalid synthetic body');
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(plan.headers ?? {})) {
      if (!SAFE_HEADERS.has(name.toLowerCase()) || /[\r\n]/.test(value)) throw new Error('Header is not allowed');
      headers[name.toLowerCase()] = value;
    }
    const headerRedactor = new Redactor(Object.entries(headers).filter(([name]) => /authorization|secret|token|key/i.test(name)).map(([, value]) => value));
    let target = validateTarget(this.config, plan.url, plan.kind);
    const controller = new AbortController();
    const effective = AbortSignal.any([controller.signal, this.ledger.signal, ...(signal ? [signal] : [])]);
    const end = this.ledger.snapshot.cleanup ? this.ledger.deadline : this.ledger.workDeadline;
    const cancelTimer = this.ledger.clock.schedule(Math.max(0, end - this.ledger.clock.now()), () => controller.abort());
    const start = this.ledger.clock.now(); let redirects = 0; let attempts = 0;
    try {
      while (true) {
        guardTarget(target);
        const release = await this.ledger.acquire(effective, reservation);
        let response: Response;
        let text = ''; let bodyBytes = 0; let code: WorkerCodeMaterial | undefined;
        try {
          effective.throwIfAborted();
          response = await this.#dispatch(target.href, { method, headers, ...(plan.body !== undefined ? { body: plan.body } : {}), redirect: 'manual', signal: effective });
          // Bodies on redirects and retry responses are cancelled rather than retained.
          if (REDIRECTS.has(response.status) || (response.status === 429 && attempts < retries)) await response.body?.cancel();
          else if (codeOnly) { code = await readWorkerCodeMaterial(response, effective) ?? undefined; bodyBytes = code?.contentBytes ?? 0; }
          else { const body = await boundedBody(response, 65536, effective); text = body.text; bodyBytes = body.bytes; }
        } finally { release(); }
        if (REDIRECTS.has(response.status) && !plan.observeRedirect) {
          const location = response.headers.get('location');
          if (!location) throw new Error('Redirect missing destination');
          if (++redirects > maxRedirects) throw new Error('Redirect allowance exhausted');
          if (method === 'POST' && response.status !== 307 && response.status !== 308) throw new Error('Method-changing redirects rejected');
          target = validateRedirect(this.config, target.href, location, plan.kind, headers, plan.followRedirects ?? false);
          continue;
        }
        if (response.status === 429 && attempts < retries) {
          const raw = response.headers.get('retry-after');
          const ms = raw !== null && /^\d+$/.test(raw) ? Number(raw) * 1000 : 250 * 2 ** attempts;
          if (!Number.isSafeInteger(ms) || ms > 5000) throw new Error('Retry exceeds bounded backoff');
          attempts++; await delay(this.ledger.clock, ms, effective); continue;
        }
        const ray = RayId.safeParse(response.headers.get('cf-ray'));
        const data = parse ? parse(headerRedactor.text(text)) : undefined;
        const role = Role.safeParse(response.headers.get('x-lab-role'));
        const releaseHeader = Digest.safeParse(headerRedactor.text(this.redactor.text(response.headers.get('x-lab-release') ?? '')));
        const knownServices = new Set(['d1', 'r2', 'images-reference', 'container-completed']);
        const services = [...new Set((response.headers.get('x-lab-services') ?? '').split(',').map(s => s.trim()).filter(s => knownServices.has(s)))];
        const type = (response.headers.get('content-type') ?? '').split(';')[0]!.toLowerCase();
        const contentType = ['application/json', 'text/html', 'text/plain', 'image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(type) ? type : null;
        return { status: response.status, excerpt: codeOnly ? '' : this.redactor.excerpt(parse ? JSON.stringify(data) : headerRedactor.text(text)), rayId: ray.success ? ray.data : null, latencyMs: this.ledger.clock.now() - start, metadata: { role: role.success ? role.data : null, releaseDigest: releaseHeader.success ? releaseHeader.data : null, services, contentType, bodyBytes }, data, ...(code ? { code } : {}) };
      }
    } catch { throw new Error('Guarded request failed; inspect sanitized run state'); }
    finally { cancelTimer(); }
  }
}

// Factories remain unevaluated in dry-run; even client construction is forbidden.
export function executionDependencies<T>(mode: 'dry-run' | 'live', factories: { http: () => T; browser: () => T; deployment: () => T }) {
  if (mode === 'dry-run') return Object.freeze({ kind: 'planned' as const });
  // Deployment never belongs in the execution dependency graph, even in live mode.
  return Object.freeze({ kind: 'live' as const, http: factories.http, browser: factories.browser });
}
