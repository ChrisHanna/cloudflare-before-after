import { chromium, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { BudgetLedger } from './budget.js';
import { assertLiveReady, validateTarget, type LabConfig } from './config.js';
import { Redactor } from '../../contracts/src/redaction.js';
import { ReceiptSchema, type Receipt } from '../../contracts/src/schemas.js';
import type { Dispatch } from './transport.js';

export type BrowserRole = 'before' | 'after';
export interface BrowserSessionView {
  sessionId: string; role: BrowserRole; state: 'open' | 'closed';
}
export interface BrowserFrameScope {
  ownerId: string; runId: string; sessionId: string; releaseDigest: string;
}
export interface BrowserFrame extends BrowserFrameScope {
  sessionId: string; mode: 'live' | 'fixture'; observedAt: string; expiresAt: string;
  kind: 'frame'; text: ''; frame: string; width: number; height: number;
}
export type BrowserPreview = BrowserFrame | {
  sessionId: string; mode: 'live' | 'fixture'; observedAt: string;
  kind: 'text'; text: string; frame: null;
};
export const WAITING_ROOM_JSON_DOCUMENTATION = 'https://developers.cloudflare.com/waiting-room/how-to/json-response/';
export interface QueueDetection {
  qualified: boolean; source: 'cloudflare-json-response' | 'fixture-selector' | 'unqualified';
}
interface QueueObservationScope extends BrowserFrameScope { requestId: string | null; observedAt: string; queue: boolean; storefront: boolean; queueCookiePresent: boolean; cookieContinuity: boolean }
const ownedBrowserObservations = new WeakMap<object, QueueObservationScope & { documentedQueue: boolean }>();
export function isOwnedBrowserObservation(value: object, scope: QueueObservationScope): boolean {
  const actual = ownedBrowserObservations.get(value);
  return !!actual && (Object.keys(scope) as (keyof typeof scope)[]).every(key => actual[key] === scope[key]);
}
export function isDocumentedQueueObservation(value: object, scope: QueueObservationScope): boolean {
  return isOwnedBrowserObservation(value, scope) && ownedBrowserObservations.get(value)!.documentedQueue;
}
export interface BrowserFixtureResponse { status: number; contentType: string; body: string; headers?: Record<string, string> }
export interface BrowserTransportOptions {
  mode: 'live' | 'fixture' | 'dry-run'; config: LabConfig; ledger: BudgetLedger;
  observedOwnedResources?: ReadonlySet<string>; headed?: boolean; followRedirects?: boolean;
  runnerToken?: string;
  /** Actual intercepted network boundary; fixtures never call this transport. */
  dispatch?: Dispatch;
  previewSelectors?: readonly string[];
  /** Exact document paths, without queries. Applies to every navigation and redirect. */
  navigationPaths?: readonly string[];
  /** Only approved synthetic leaf text may remain visible in actual masked frames. */
  framePublicText?: readonly string[];
  launch?: () => Promise<Browser>;
  fixture?: (request: { url: string; method: string; sessionId: string; requestId: string | null }) => Promise<BrowserFixtureResponse>;
  correlation: { runId: string; scenarioId: string };
}
interface OwnedSession { view: BrowserSessionView; context: BrowserContext; page: Page; cookies: Map<string, string>; requestId: string | null; documentedQueue: boolean; navigating: boolean }

/** No browser, profile, cookies, or debugging endpoint is exposed at the public boundary. */
export class BrowserTransport {
  readonly #sessions = new Map<string, OwnedSession>();
  readonly #ownerId = randomUUID();
  readonly #frames = new Map<string, BrowserFrame>();
  readonly #frameTimes = new Map<string, number>();
  readonly #capturing = new Set<string>();
  readonly #admitted = new Set<string>();
  readonly #active = new Map<Request, () => void>();
  readonly #browser: Browser;
  readonly #options: BrowserTransportOptions;
  readonly #abort: () => void;
  readonly #cancelDeadline: () => void;
  readonly #controller = new AbortController();
  #workDeadlineReached = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  private constructor(browser: Browser, options: BrowserTransportOptions) {
    this.#browser = browser; this.#options = options;
    this.#abort = () => { this.#workDeadlineReached = true; void this.close().catch(() => {}); };
    options.ledger.signal.addEventListener('abort', this.#abort, { once: true });
    this.#cancelDeadline = options.ledger.clock.schedule(Math.max(0, options.ledger.workDeadline - options.ledger.clock.now()), this.#abort);
    if (options.ledger.signal.aborted) this.#abort();
  }
  static async create(options: BrowserTransportOptions): Promise<BrowserTransport | null> {
    options = Object.freeze({ ...options, correlation: Object.freeze({ ...options.correlation }), previewSelectors: Object.freeze([...(options.previewSelectors ?? [])]), ...(options.navigationPaths ? { navigationPaths: Object.freeze([...options.navigationPaths]) } : {}), framePublicText: Object.freeze([...(options.framePublicText ?? [])]) });
    if (options.mode === 'dry-run') return null;
    if (options.mode === 'live') assertLiveReady(options.config, options.observedOwnedResources ?? new Set());
    if (options.mode === 'fixture' && !options.fixture) throw new Error('Fixture responder required; network fallback forbidden');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(options.correlation.runId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(options.correlation.scenarioId)) throw new Error('Invalid correlation labels');
    if (options.navigationPaths && (!options.navigationPaths.length || options.navigationPaths.length > 16 || options.navigationPaths.some(path => path.length > 256 || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*$/.test(path)))) throw new Error('Exact navigation paths required');
    if ((options.framePublicText?.length ?? 0) > 64 || options.framePublicText?.some(text => !text || text.length > 128)) throw new Error('Bounded synthetic frame text required');
    options.ledger.signal.throwIfAborted();
    const browser = await (options.launch ?? (() => chromium.launch({ headless: options.headed === undefined ? options.mode === 'fixture' : !options.headed })))();
    if (options.ledger.signal.aborted || options.ledger.clock.now() >= options.ledger.workDeadline) { await browser.close(); throw new Error('Browser launch exceeded deadline'); }
    return new BrowserTransport(browser, options);
  }
  get mode(): 'live' | 'fixture' { return this.#options.mode === 'fixture' ? 'fixture' : 'live'; }
  get stopped(): boolean { return this.#workDeadlineReached; }
  get signal(): AbortSignal { return this.#controller.signal; }
  get sessions(): BrowserSessionView[] { return [...this.#sessions.values()].map(s => ({ ...s.view })); }
  #get(id: string): OwnedSession {
    const s = this.#sessions.get(id);
    if (this.#closed || !s || s.view.state !== 'open') throw new Error('Owned browser session unavailable');
    return s;
  }
  #navigationTarget(url: string, role: BrowserRole): void {
    const target = validateTarget(this.#options.config, url, role);
    if (this.#options.navigationPaths && (target.search || !this.#options.navigationPaths.includes(target.pathname) || target.href !== `${target.origin}${target.pathname}`)) throw new Error('Navigation route is not allowlisted');
  }
  async open(role: BrowserRole): Promise<string> {
    if (this.#closed) throw new Error('Browser transport closed');
    if (role !== 'before' && role !== 'after') throw new Error('Invalid browser role');
    const ordinal = this.#options.ledger.openSession();
    const id = `session-${ordinal}`;
    const context = await this.#browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
    if (this.#closed) { await context.close(); throw new Error('Browser transport closed'); }
    try {
      await context.routeWebSocket('**/*', socket => socket.close());
      const requestControllers = new Map<Request, AbortController>();
      context.on('requestfailed', request => requestControllers.get(request)?.abort());
      await context.route('**/*', async route => {
        const request = route.request(); let release: (() => void) | undefined;
        const controller = new AbortController(); requestControllers.set(request, controller);
        const signal = AbortSignal.any([this.#controller.signal, controller.signal]);
        try {
          if (!['GET', 'HEAD'].includes(request.method())) throw new Error('Browser writes forbidden');
          if (request.isNavigationRequest() && request.frame() === this.#sessions.get(id)?.page.mainFrame()) {
            if (this.#capturing.has(id)) throw new Error('Navigation during capture forbidden');
            this.#frames.delete(id); this.#admitted.delete(id);
            const session = this.#get(id); session.documentedQueue = false; session.requestId = null;
          }
          const incoming = await request.allHeaders();
          let url = request.url();
          for (let hop = 0; hop <= 3; hop++) {
            signal.throwIfAborted();
            let kind: BrowserRole | 'image' = role;
            try { validateTarget(this.#options.config, url, role); }
            catch { validateTarget(this.#options.config, url, 'image'); kind = 'image'; }
            if (request.isNavigationRequest()) {
              if (kind !== role || request.frame() !== this.#sessions.get(id)?.page.mainFrame()) throw new Error('Foreign frame navigation forbidden');
              this.#navigationTarget(url, role);
            }
            const headers: Record<string, string> = {};
            for (const name of ['accept', 'accept-language', 'user-agent', 'content-type']) if (incoming[name]) headers[name] = incoming[name];
            if (kind === role) {
              const cookies = await context.cookies(url);
              if (cookies.length) headers.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
              if (this.#options.runnerToken) headers['x-demo-run-token'] = this.#options.runnerToken;
              headers['x-demo-run-id'] = this.#options.correlation.runId;
              headers['x-demo-scenario'] = this.#options.correlation.scenarioId;
              headers['x-demo-request-id'] = randomUUID();
              if (request.isNavigationRequest() && request.frame() === this.#sessions.get(id)?.page.mainFrame()) this.#sessions.get(id)!.requestId = headers['x-demo-request-id'];
            }
            release = await this.#options.ledger.acquire(signal);
            this.#active.set(request, release); signal.throwIfAborted();
            let response: { status: number; headers: Record<string, string>; body: Buffer; contentType?: string };
            if (this.#options.mode === 'fixture') {
              const fixture = await this.#options.fixture!({ url, method: request.method(), sessionId: id, requestId: headers['x-demo-request-id'] ?? null });
              response = { status: fixture.status, headers: fixture.headers ?? {}, body: Buffer.from(fixture.body), contentType: fixture.contentType };
            } else {
              const remote = await (this.#options.dispatch ?? fetch)(url, { method: request.method(), headers, redirect: 'manual', signal });
              const safeHeaders: Record<string, string> = {};
              for (const name of ['content-type', 'location', 'set-cookie', 'content-security-policy', 'x-frame-options', 'cache-control']) {
                const value = remote.headers.get(name); if (value) safeHeaders[name] = value;
              }
              if (remote.headers.getSetCookie().length) safeHeaders['set-cookie'] = remote.headers.getSetCookie().join('\n');
              const chunks: Uint8Array[] = []; let bytes = 0; const reader = remote.body?.getReader();
              if (reader) try {
                while (true) {
                  const next = await reader.read(); if (next.done) break;
                  bytes += next.value.byteLength;
                  if (bytes > 1048576) { await reader.cancel(); throw new Error('Browser response byte cap reached'); }
                  chunks.push(next.value);
                }
              } finally { reader.releaseLock(); }
              response = { status: remote.status, headers: safeHeaders, body: Buffer.concat(chunks) };
            }
            signal.throwIfAborted();
            if (response.body.byteLength > 1048576) throw new Error('Browser response byte cap reached');
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              // Never hand Chromium a redirect: its redirect chain can bypass route interception.
              release(); release = undefined; this.#active.delete(request);
              if (!this.#options.followRedirects || hop === 3 || !response.headers.location || response.headers['set-cookie']) throw new Error('Unsupported browser redirect flow');
              const next = new URL(response.headers.location, url).href;
              validateTarget(this.#options.config, next, kind); url = next; continue;
            }
            if (request.isNavigationRequest() && request.frame() === this.#sessions.get(id)?.page.mainFrame()) {
              const session = this.#get(id); session.documentedQueue = false;
              const contentType = response.contentType ?? response.headers['content-type'] ?? '';
              if (response.status === 200 && contentType.split(';')[0]?.trim() === 'application/json' && response.body.length <= 16384) {
                try {
                  const value: unknown = JSON.parse(response.body.toString('utf8'));
                  session.documentedQueue = typeof value === 'object' && value !== null && 'cfWaitingRoom' in value && typeof value.cfWaitingRoom === 'object' && value.cfWaitingRoom !== null && 'inWaitingRoom' in value.cfWaitingRoom && value.cfWaitingRoom.inWaitingRoom === true;
                } catch { /* An absent documented signal is explicitly unqualified. */ }
              }
            }
            await route.fulfill(response);
            return;
          }
        } catch {
          await route.abort('blockedbyclient').catch(() => {});
        } finally { requestControllers.delete(request); this.#active.delete(request); release?.(); }
      });
      context.on('page', page => { page.on('download', download => { void download.cancel(); }); });
      const page = await context.newPage();
      context.on('page', popup => { if (popup !== page) void popup.close(); });
      this.#sessions.set(id, { view: { sessionId: id, role, state: 'open' }, context, page, cookies: new Map(), requestId: null, documentedQueue: false, navigating: false });
      return id;
    } catch { await context.close(); throw new Error('Owned context setup failed'); }
  }
  async navigate(id: string, url: string): Promise<void> {
    const s = this.#get(id); this.#navigationTarget(url, s.view.role);
    if (s.navigating || this.#capturing.has(id)) throw new Error('Owned page action already active');
    this.#frames.delete(id); this.#admitted.delete(id); s.documentedQueue = false;
    const timeout = Math.floor(this.#options.ledger.workDeadline - this.#options.ledger.clock.now());
    if (timeout <= 0) throw new Error('Browser work deadline reached');
    s.navigating = true;
    try { await s.page.goto(url, { waitUntil: 'load', timeout }); }
    catch { throw new Error('Owned browser navigation failed'); }
    finally { s.navigating = false; }
  }
  async refresh(id: string): Promise<void> { await this.navigate(id, this.#get(id).page.url()); }
  /** Cookie continuity stays in memory; no digest or cookie value is returned. */
  async continuity(id: string): Promise<boolean> {
    const s = this.#get(id);
    const origin = this.#options.config.environments.find(e => e.role === s.view.role)!.origin;
    const cookies = await s.context.cookies(origin);
    const current = new Map(cookies.map(c => [`${c.domain}|${c.path}|${c.name}`, createHash('sha256').update(c.value).digest('hex')]));
    // Waiting Room rotates its own cookie at admission; rotation is not a new jar.
    const unchanged = [...s.cookies].every(([key, value]) => current.has(key) && (key.endsWith('|__cfwaitingroom') || current.get(key) === value));
    s.cookies = current;
    return unchanged;
  }
  /** Inspect only qualified DOM contracts; arbitrary page text is never persisted. */
  async inspect(id: string, selectors: { queue: string; storefront: string }): Promise<{ queue: boolean; storefront: boolean; queueCookiePresent: boolean; requestId: string | null; observedAt: string; queueDetection: QueueDetection; sessionId: string; cookieContinuity: boolean }> {
    const s = this.#get(id);
    const fixtureQueue = this.mode === 'fixture' && await s.page.locator(selectors.queue).isVisible();
    const documented = this.mode === 'live' && s.documentedQueue;
    const result = Object.freeze({ sessionId: id, cookieContinuity: await this.continuity(id), queue: documented || fixtureQueue, storefront: await s.page.locator(selectors.storefront).isVisible(), queueCookiePresent: (await s.context.cookies()).some(c => c.name === '__cfwaitingroom'), requestId: s.requestId, observedAt: new Date().toISOString(), queueDetection: { qualified: documented || fixtureQueue, source: documented ? 'cloudflare-json-response' : fixtureQueue ? 'fixture-selector' : 'unqualified' } as QueueDetection });
    ownedBrowserObservations.set(result, { ...this.frameScope(id), requestId: result.requestId, observedAt: result.observedAt, queue: result.queue, storefront: result.storefront, queueCookiePresent: result.queueCookiePresent, cookieContinuity: result.cookieContinuity, documentedQueue: documented });
    return result;
  }
  async preview(id: string, selector: string, redactor = new Redactor()): Promise<BrowserPreview> {
    const s = this.#get(id);
    if (!this.#options.previewSelectors?.includes(selector)) throw new Error('Unqualified synthetic preview selector');
    // Text is captured from the actual synthetic view. Private elements never enter output.
    const text = await s.page.locator(selector).evaluate(node => {
      if (node.matches('input,textarea,select,[contenteditable],[data-private],script,style')) return '';
      const clone = node.cloneNode(true) as Element;
      clone.querySelectorAll('input,textarea,select,[contenteditable],[data-private],script,style').forEach(privateNode => privateNode.remove());
      return (clone.textContent ?? '').slice(0, 16384);
    }, undefined, { timeout: 1000 });
    const cookies = await s.context.cookies();
    const privateText = new Redactor(cookies.map(c => c.value));
    return { sessionId: id, mode: this.#options.mode === 'fixture' ? 'fixture' : 'live', observedAt: new Date().toISOString(), kind: 'text', text: redactor.excerpt(privateText.text(text)), frame: null };
  }
  frameScope(id: string): BrowserFrameScope {
    const session = this.#get(id);
    return { ownerId: this.#ownerId, runId: this.#options.correlation.runId, sessionId: id, releaseDigest: this.#options.config.environments.find(e => e.role === session.view.role)!.releaseDigest };
  }
  #assertScope(scope: BrowserFrameScope): void {
    const expected = this.frameScope(scope.sessionId);
    if (Object.keys(scope).length !== 4 || Object.keys(expected).some(key => expected[key as keyof BrowserFrameScope] !== scope[key as keyof BrowserFrameScope])) throw new Error('Foreign preview scope');
  }
  latestFrame(scope: BrowserFrameScope): BrowserFrame {
    this.#assertScope(scope);
    const frame = this.#frames.get(scope.sessionId);
    if (!frame || Date.parse(frame.expiresAt) <= Date.now() || (Object.keys(scope) as (keyof BrowserFrameScope)[]).some(key => frame[key] !== scope[key])) { this.#frames.delete(scope.sessionId); throw new Error('Stale or absent preview'); }
    return { ...frame };
  }
  /** Capture actual pixels, with all but approved synthetic leaf text hidden BEFORE capture. */
  async captureFrame(scope: BrowserFrameScope, selector: string, redactor = new Redactor()): Promise<BrowserFrame> {
    this.#assertScope(scope); const id = scope.sessionId; const s = this.#get(id);
    if (!this.#options.previewSelectors?.includes(selector) || !this.#options.framePublicText?.length) throw new Error('Qualified frame surface required');
    if (s.navigating || this.#capturing.has(id) || Date.now() - (this.#frameTimes.get(id) ?? 0) < 1000) throw new Error('Frame rate limit');
    if (this.#options.ledger.clock.now() >= this.#options.ledger.workDeadline) throw new Error('Browser work deadline reached');
    this.#frames.delete(id); this.#frameTimes.set(id, Date.now()); this.#capturing.add(id);
    let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
    let restore: import('@playwright/test').JSHandle<() => void> | undefined;
    try {
      cdp = await s.context.newCDPSession(s.page);
      await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
      const surface = s.page.locator(selector);
      if (await surface.count() !== 1 || await surface.evaluate(node => node.matches('[data-demo-public]') || [...node.querySelectorAll('*')].some(child => child.shadowRoot !== null))) throw new Error('Unique plain frame surface required');
      const leaves = surface.locator('[data-demo-public]');
      const text = await leaves.evaluateAll(nodes => {
        if (!nodes.length || nodes.length > 64) return null;
        return nodes.map(node => !['P', 'SPAN', 'DIV', 'H1', 'H2', 'H3'].includes(node.tagName) || node.children.length || node.closest('input,textarea,select,[contenteditable],[data-private],svg,canvas,iframe,script,style') ? null : node.textContent);
      });
      const cookies = new Redactor([...(await s.context.cookies()).map(c => c.value), ...(this.#options.runnerToken ? [this.#options.runnerToken] : [])]);
      if (!text || text.some(value => value === null || !this.#options.framePublicText!.includes(value) || redactor.text(cookies.text(value)) !== value)) throw new Error('Frame privacy contract failed');
      const box = await surface.boundingBox();
      if (!box || box.width < 1 || box.height < 1 || box.x < 0 || box.y < 0 || box.x >= 800 || box.y >= 600) throw new Error('Frame size cap');
      // Inline !important masking beats hostile page styles too. No DOM leaves the page.
      restore = await s.page.evaluateHandle(rootSelector => {
        const root = document.querySelector(rootSelector)!;
        const sheets = [...document.styleSheets]; const disabled = sheets.map(sheet => sheet.disabled);
        sheets.forEach(sheet => { sheet.disabled = true; });
        const nodes = [...document.querySelectorAll<HTMLElement>('*')];
        const previous = nodes.map(node => node.getAttribute('style'));
        for (const node of nodes) {
          node.style.setProperty('visibility', 'hidden', 'important');
          for (const property of ['background-image', 'border-image', 'box-shadow', 'text-shadow']) node.style.setProperty(property, 'none', 'important');
          if (root.contains(node) && node.hasAttribute('data-demo-public')) {
            // Public leaf styles cannot smuggle an image, font, marker, or CSS content.
            node.setAttribute('style', 'visibility:visible!important;font-family:sans-serif!important;color:black!important;background:white!important');
          }
        }
        return () => {
          nodes.forEach((node, i) => { const style = previous[i]; if (style === null) node.removeAttribute('style'); else node.setAttribute('style', style!); });
          sheets.forEach((sheet, i) => { sheet.disabled = disabled[i]!; });
        };
      }, selector);
      const maskedBox = await surface.boundingBox();
      if (!maskedBox || maskedBox.x < 0 || maskedBox.y < 0 || maskedBox.x >= 800 || maskedBox.y >= 600) throw new Error('Masked frame size cap');
      // The surface may extend past the 800x600 viewport; only the visible part is captured.
      const clip = { x: maskedBox.x, y: maskedBox.y, width: Math.min(maskedBox.width, 800 - maskedBox.x), height: Math.min(maskedBox.height, 600 - maskedBox.y) };
      const bytes = await s.page.screenshot({ type: 'png', clip, animations: 'disabled', caret: 'hide', timeout: 1000,
        style: '* { visibility: hidden !important; background-image: none !important; border-image: none !important; box-shadow: none !important; text-shadow: none !important; } *::before, *::after { content: none !important; } [data-demo-public] { visibility: visible !important; font-family: sans-serif !important; color: black !important; background: white !important; -webkit-text-security: none !important; }',
      });
      if (bytes.length > 196608) throw new Error('Frame payload cap');
      this.#assertScope(scope);
      const now = Date.now();
      const frame: BrowserFrame = { ...scope, mode: this.mode, kind: 'frame', text: '', frame: `data:image/png;base64,${bytes.toString('base64')}`, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 5000).toISOString() };
      this.#frames.set(id, frame);
      setTimeout(() => { if (this.#frames.get(id) === frame) this.#frames.delete(id); }, 5000).unref();
      return { ...frame };
    } finally {
      await restore?.evaluate(undo => undo()).catch(() => {}); await restore?.dispose().catch(() => {});
      await cdp?.send('Emulation.setScriptExecutionDisabled', { value: false }).catch(() => {}); await cdp?.detach().catch(() => {}); this.#capturing.delete(id);
    }
  }
  async confirmAdmission(id: string, storefrontSelector: string, receipts: readonly Receipt[]): Promise<void> {
    const s = this.#get(id); const scope = this.frameScope(id);
    const matching = receipts.filter(r => ReceiptSchema.safeParse(r).success && r.runId === scope.runId && r.requestId === s.requestId && r.scenarioId === this.#options.correlation.scenarioId && r.targetRole === s.view.role && r.releaseDigest === scope.releaseDigest && r.stage === 'entry' && Date.parse(r.observedAt) <= Date.now());
    if (s.documentedQueue || matching.length !== 1 || !await s.page.locator(storefrontSelector).isVisible() || !await this.continuity(id)) throw new Error('Admission proof missing');
    this.#admitted.add(id);
  }
  /** Same page and cookie jar; exact paths and all redirected requests retain permits. */
  async navigateAdmitted(scope: BrowserFrameScope, path: string): Promise<void> {
    this.#assertScope(scope);
    if (!this.#admitted.has(scope.sessionId)) throw new Error('Admitted owned session required');
    if (!this.#options.navigationPaths?.includes(path)) throw new Error('Navigation route is not allowlisted');
    const session = this.#get(scope.sessionId);
    const origin = this.#options.config.environments.find(e => e.role === session.view.role)!.origin;
    await this.navigate(scope.sessionId, new URL(path, origin).href);
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; this.#frames.clear(); this.#frameTimes.clear(); this.#admitted.clear(); this.#controller.abort(); this.#cancelDeadline();
    this.#options.ledger.signal.removeEventListener('abort', this.#abort);
    this.#closePromise = (async () => {
      const results = await Promise.allSettled([...this.#sessions.values()].map(async s => { await s.context.close(); s.view.state = 'closed'; s.cookies.clear(); }));
      for (const release of this.#active.values()) release(); this.#active.clear();
      await this.#browser.close();
      if (results.some(r => r.status === 'rejected')) throw new Error('Owned context cleanup incomplete');
    })();
    return this.#closePromise;
  }
}
