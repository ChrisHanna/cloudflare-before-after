import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { IntentSchema, createDeploymentPlan, viewRunReuseBlockers } from '../packages/demo-core/src/deployment-plan.js';
import { discoverCapabilities } from '../packages/demo-core/src/capabilities.js';
import { deploymentIntent } from './fixtures/deployment.js';

const root = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), 'view-run-reuse-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const MESSAGE = 'viewRunId was already deployed with a different release digest; mint a new viewRunId for this release';
function record(intent: ReturnType<typeof deploymentIntent>, prior: { viewRunId: string; releaseDigest: string; attempted?: boolean }) {
  const directory = join(intent.discovery.evidenceDirectory, 'deployment', 'plans'); mkdirSync(directory, { recursive: true });
  const id = randomUUID();
  writeFileSync(join(directory, `${id}.plan.json`), JSON.stringify({ plan: { intent: { viewRunId: prior.viewRunId, releaseDigest: prior.releaseDigest } } }));
  if (prior.attempted !== false) writeFileSync(join(directory, `${id}.attempt.json`), '{}');
  return directory;
}
describe('viewRunId reuse guard', () => {
  it('has no history to inspect on a fresh lab', () => {
    expect(viewRunReuseBlockers(deploymentIntent(mkdtempSync(join(root, 'fresh-'))))).toEqual([]);
  });
  it('blocks a reused viewRunId with a different release and lets the plan surface it', async () => {
    const lab = mkdtempSync(join(root, 'reuse-')); const intent = IntentSchema.parse(deploymentIntent(lab));
    record(intent, { viewRunId: intent.viewRunId, releaseDigest: 'b'.repeat(64) });
    expect(viewRunReuseBlockers(intent)).toEqual([MESSAGE]);
    const snapshot = await discoverCapabilities(intent.discovery, 'core', { mode: 'live', inspect: async () => ({ state: 'available', source: 'offline-injected', reasons: [] }) });
    expect(createDeploymentPlan(intent, snapshot, 'a'.repeat(64), lab).blockers).toContain(MESSAGE);
  });
  it.each([
    ['a fresh viewRunId', { viewRunId: randomUUID(), releaseDigest: 'b'.repeat(64) }],
    ['the same release', { viewRunId: 'same', releaseDigest: 'a'.repeat(64) }],
    ['a plan that was never applied', { viewRunId: 'same', releaseDigest: 'b'.repeat(64), attempted: false }],
  ] as const)('allows %s', (_name, prior) => {
    const intent = IntentSchema.parse(deploymentIntent(mkdtempSync(join(root, 'allow-'))));
    record(intent, { ...prior, viewRunId: prior.viewRunId === 'same' ? intent.viewRunId : prior.viewRunId });
    expect(viewRunReuseBlockers(intent)).toEqual([]);
  });
  it('ignores unreadable history instead of inventing a block', () => {
    const intent = IntentSchema.parse(deploymentIntent(mkdtempSync(join(root, 'broken-'))));
    const directory = record(intent, { viewRunId: intent.viewRunId, releaseDigest: 'b'.repeat(64) });
    writeFileSync(join(directory, `${randomUUID()}.attempt.json`), '{}');
    writeFileSync(join(directory, 'not-json.attempt.json'), '{}'); writeFileSync(join(directory, 'not-json.plan.json'), '{broken');
    expect(viewRunReuseBlockers(intent)).toEqual([MESSAGE]);
  });
});
