import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntentSchema } from '../packages/demo-core/src/deployment-plan.js';
import { deploymentIntent } from './fixtures/deployment.js';

const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'turnstile-intent-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('Turnstile deployment setting', () => {
  it('is optional and limited to documented test mode', () => {
    const intent = deploymentIntent(root);
    expect(IntentSchema.parse(intent).turnstile).toBeUndefined();
    expect(IntentSchema.parse({ ...intent, turnstile: { mode: 'test' } }).turnstile).toEqual({ mode: 'test' });
    expect(IntentSchema.parse({ ...intent, turnstile: { mode: 'live' } }).turnstile).toEqual({ mode: 'live' });
  });
  it.each([{ mode: 'disabled' }, { mode: 'test', secret: 'must-not-be-in-intent-0000000' }, {}])('rejects %j', turnstile => {
    expect(() => IntentSchema.parse({ ...deploymentIntent(root), turnstile })).toThrow();
  });
});
