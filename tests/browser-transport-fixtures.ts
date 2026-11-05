import { chromium } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Receipt } from '../packages/contracts/src/schemas.js';
import type { BrowserTransportOptions } from '../packages/demo-core/src/browser-transport.js';
import { BudgetLedger } from '../packages/demo-core/src/budget.js';
import { labConfig } from './fixtures/lab.js';

// Only installed browsers. No install or download fallback.
export function installedBrowser() {
  const paths = [chromium.executablePath(), ...['1247', '1208'].map(version => join(homedir(), '.cache', 'ms-playwright', `chromium-${version}`, 'chrome-linux64', 'chrome'))];
  const executablePath = paths.find(existsSync);
  if (!executablePath) throw new Error('No installed Chromium; browser fixture checks unmet');
  return chromium.launch({ executablePath, headless: true });
}
export function browserOptions(ledger = new BudgetLedger({ limits: { cleanupRequests: 0 } })): BrowserTransportOptions {
  return { mode: 'fixture', config: labConfig(), ledger, launch: installedBrowser, previewSelectors: ['main', '[data-view]'],
    correlation: { runId: randomUUID(), scenarioId: 'waiting-room' },
    fixture: async () => ({ status: 200, contentType: 'text/html', body: '<main data-storefront>Synthetic launch shirt</main>' }) };
}
export function waitingRoomFixture(options: { noQueue?: boolean; noTransition?: boolean; missingReceipt?: boolean; rotateCookie?: boolean; breakCookies?: boolean } = {}) {
  const receipts: Receipt[] = []; const visits = new Map<string, number>();
  const config = browserOptions();
  config.fixture = async request => {
    const n = (visits.get(request.sessionId) ?? 0) + 1; visits.set(request.sessionId, n);
    const queue = request.sessionId === 'session-3' && !options.noQueue && (n === 1 || options.noTransition);
    if (!queue && request.requestId && !options.missingReceipt) receipts.push({ schemaVersion: 1, id: randomUUID(), runId: config.correlation.runId, requestId: request.requestId, scenarioId: 'waiting-room', targetRole: request.sessionId === 'session-1' ? 'before' : 'after', producerId: 'fixture-container', sequence: receipts.length + 1, observedAt: new Date().toISOString(), rayId: null, releaseDigest: 'a'.repeat(64), stage: 'entry' });
    return { status: 200, contentType: 'text/html', headers: queue ? { 'set-cookie': '__cfwaitingroom=fixture-private-cookie; Path=/; Secure; HttpOnly' } : options.breakCookies && request.sessionId === 'session-3' ? { 'set-cookie': '__cfwaitingroom=; Max-Age=0; Path=/; Secure; HttpOnly' } : options.rotateCookie && request.sessionId === 'session-3' ? { 'set-cookie': '__cfwaitingroom=fixture-rotated-cookie; Path=/; Secure; HttpOnly' } : {}, body: queue ? '<main data-queue>Waiting Room: queued</main>' : '<main data-storefront>Synthetic launch shirt</main>' };
  };
  return { config, receipts, visits };
}
