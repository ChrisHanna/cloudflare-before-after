import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DeploymentApi } from '../packages/demo-core/src/deployment-api.js';
import type { SetupContext } from '../packages/demo-core/src/deployment-apply.js';
import { deploymentIntent } from './fixtures/deployment.js';

const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'turnstile-widget-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const SITEKEY = '0x4AAAAAAAtestkeyForLab01'; const SECRET = '0x4AAAAAAAtestSecretForLabOnly000000';
const context = { signal: new AbortController().signal, perform: async (_kind: string, _id: string, action: () => Promise<unknown>) => action(), observeResource: () => {} } as unknown as SetupContext;
function api(widgets: unknown[]) {
  const intent = deploymentIntent(root); const calls: { url: string; method: string; body?: unknown }[] = [];
  const dispatch = async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET'; calls.push({ url, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const result = method === 'GET' ? widgets : { sitekey: SITEKEY, secret: SECRET };
    return new Response(JSON.stringify({ success: true, result, errors: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { api: new DeploymentApi(root, intent, 'reader-token-at-least-24-chars', 'deployer-token-at-least-24-chars', dispatch), calls, host: new URL(intent.discovery.environments[1].origin).hostname, lab: intent.discovery.labId };
}
describe('live Turnstile widget setup', () => {
  it('creates one hostname-scoped managed widget when none exists', async () => {
    const f = api([]); const widget = await f.api.ensureTurnstileWidget(context);
    expect(widget).toEqual({ sitekey: SITEKEY, secret: SECRET });
    const create = f.calls.find(c => c.method === 'POST')!; expect(create.url).toMatch(/\/challenges\/widgets$/);
    expect(create.body).toEqual({ name: `${f.lab}-after-register`, domains: [f.host], mode: 'managed', bot_fight_mode: false, region: 'world' });
  });
  it('rotates the secret of the existing owned widget instead of creating a duplicate', async () => {
    const f = api([]); const probe = api([{ sitekey: SITEKEY, name: `${f.lab}-after-register`, domains: [f.host] }]);
    await probe.api.ensureTurnstileWidget(context);
    expect(probe.calls.filter(c => c.method === 'POST').map(c => c.url.split('/widgets')[1])).toEqual([`/${SITEKEY}/rotate_secret`]);
  });
  it('refuses a widget with the lab name but a different hostname', async () => {
    const f = api([]); const other = api([{ sitekey: SITEKEY, name: `${f.lab}-after-register`, domains: ['elsewhere.example.test'] }]);
    await expect(other.api.ensureTurnstileWidget(context)).rejects.toThrow('different hostname');
  });
});
