import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertCredentialSeparation, type CredentialRole } from '../packages/demo-core/src/credential-policy.js';
import { IntentSchema, createDeploymentPlan } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { defaultOptionalProvider } from '../packages/demo-core/src/optional-product-integration.js';
import { resolveSetupCredentials } from '../packages/demo-core/src/lab-cli.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';

afterEach(() => vi.unstubAllEnvs());
const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'shared-api-token-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function sharedIntent() {
  const intent = deploymentIntent(root);
  intent.discovery.credentials.apiTokenMode = 'shared';
  intent.discovery.credentials.reader = intent.discovery.credentials.deployer = 'env:LAB_API_TOKEN';
  return intent;
}
function environment() {
  for (const [key, value] of Object.entries({ LAB_API_TOKEN: FIXTURE_CREDENTIALS.reader, LAB_READER: FIXTURE_CREDENTIALS.reader, LAB_DEPLOYER: FIXTURE_CREDENTIALS.deployer, LAB_COLLECTOR: FIXTURE_CREDENTIALS.collector, LAB_RUN_SECRET: FIXTURE_CREDENTIALS.runner, LAB_SETUP_SECRET: FIXTURE_CREDENTIALS.setup })) vi.stubEnv(key, value);
}
describe('explicit single Cloudflare API token mode', () => {
  it('resolves one API token and keeps three separate application secrets', () => {
    environment();
    const intent = IntentSchema.parse(sharedIntent());
    expect(resolveSetupCredentials(intent.discovery)).toEqual({ ...FIXTURE_CREDENTIALS, deployer: FIXTURE_CREDENTIALS.reader });
  });
  it('retains the existing separate-token default', () => {
    environment(); expect(resolveSetupCredentials(deploymentIntent(root).discovery)).toEqual(FIXTURE_CREDENTIALS);
  });
  it.each([undefined, 'separate'] as const)('rejects shared references without opt-in (%s)', mode => {
    const intent = sharedIntent();
    if (mode === undefined) delete intent.discovery.credentials.apiTokenMode;
    else intent.discovery.credentials.apiTokenMode = mode;
    expect(() => IntentSchema.parse(intent)).toThrow();
  });
  it('rejects aliased values even with distinct references in default mode', () => {
    environment(); vi.stubEnv('LAB_DEPLOYER', FIXTURE_CREDENTIALS.reader);
    expect(() => resolveSetupCredentials(deploymentIntent(root).discovery)).toThrow('Separate');
  });
  it('requires matching references and matching API values in shared mode', () => {
    const intent = sharedIntent(); intent.discovery.credentials.deployer = 'env:LAB_DEPLOYER';
    expect(() => IntentSchema.parse(intent)).toThrow();
    expect(() => assertCredentialSeparation(FIXTURE_CREDENTIALS, true)).toThrow('matching');
  });
  it.each(['collector', 'runner', 'setup'] as const)('never shares %s with the API token', role => {
    environment(); const intent = sharedIntent(); intent.discovery.credentials[role] = 'env:LAB_API_TOKEN';
    expect(() => IntentSchema.parse(intent)).toThrow();
    const refs = { collector: 'LAB_COLLECTOR', runner: 'LAB_RUN_SECRET', setup: 'LAB_SETUP_SECRET' };
    vi.stubEnv(refs[role], FIXTURE_CREDENTIALS.reader);
    expect(() => resolveSetupCredentials(sharedIntent().discovery)).toThrow('Separate');
  });
  it.each([['collector', 'runner'], ['runner', 'setup'], ['collector', 'setup']] as const)('never shares application secrets %s/%s', (left, right) => {
    const values = { ...FIXTURE_CREDENTIALS, deployer: FIXTURE_CREDENTIALS.reader };
    values[left] = values[right];
    expect(() => assertCredentialSeparation(values, true)).toThrow('Separate');
  });
  it('supports optional providers without making a network request or weakening default mode', async () => {
    const intent = IntentSchema.parse(sharedIntent());
    const snapshot = await discoverCapabilities(intent.discovery, 'core', { mode: 'live', inspect: async () => ({ state: 'available', source: 'offline-injected', reasons: [] }) });
    const plan = createDeploymentPlan(intent, snapshot, 'a'.repeat(64), root);
    const dispatch = vi.fn(async () => { throw new Error('No network expected'); });
    const credentials = { reader: FIXTURE_CREDENTIALS.reader, deployer: FIXTURE_CREDENTIALS.reader };
    expect(defaultOptionalProvider(plan, credentials, dispatch).mode).toBe('live');
    delete intent.discovery.credentials.apiTokenMode;
    intent.discovery.credentials.deployer = 'env:LAB_DEPLOYER';
    const separate = createDeploymentPlan(intent, snapshot, 'a'.repeat(64), root);
    expect(() => defaultOptionalProvider(separate, credentials, dispatch)).toThrow('Separate');
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('rejects missing and short secrets without disclosing values', () => {
    environment(); vi.stubEnv('LAB_API_TOKEN', 'private-short-value');
    try { resolveSetupCredentials(sharedIntent().discovery); throw new Error('Expected refusal'); }
    catch (error) { expect(String(error)).not.toContain('private-short-value'); expect(String(error)).toContain('resolved'); }
    vi.stubEnv('LAB_API_TOKEN', undefined);
    expect(() => resolveSetupCredentials(sharedIntent().discovery)).toThrow();
  });
  it('rejects each unapproved role collision', () => {
    const roles: CredentialRole[] = ['reader', 'deployer', 'collector', 'runner', 'setup'];
    for (let i = 0; i < roles.length; i++) for (const right of roles.slice(i + 1)) {
      const left = roles[i]!;
      if (left === 'reader' && right === 'deployer') continue;
      const values = { ...FIXTURE_CREDENTIALS, deployer: FIXTURE_CREDENTIALS.reader };
      values[right] = values[left];
      expect(() => assertCredentialSeparation(values, true)).toThrow();
    }
  });
});
