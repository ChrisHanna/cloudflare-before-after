import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntentSchema, type DeploymentIntent } from './deployment-plan.js';
import { validateDiscoveryConfig } from './config.js';

/** A blocked, opt-out template. IDs and prices are not account observations. */
export function exampleIntent(root: string, now = new Date()): DeploymentIntent {
  if (!isAbsolute(root)) throw new Error('Absolute project root required');
  const intent = IntentSchema.parse({ schemaVersion: 1, profile: 'core-waf', releaseDigest: 'a'.repeat(64), viewRunId: randomUUID(), priorModules: [], setup: { maxRuntimeMs: 120000, maxOperations: 100 },
    discovery: { schemaVersion: 1, purpose: 'synthetic-lab', ownedLab: true, labId: 'example-lab', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32),
      environments: [{ role: 'before', origin: 'https://before.example.test' }, { role: 'after', origin: 'https://after.example.test' }],
      telemetryOrigin: 'https://receipts.example.test', apiOrigin: 'https://api.cloudflare.com', imageOrigins: ['https://imagedelivery.net'],
      evidenceDirectory: join(root, '.evidence'), liveOptIn: false,
      credentials: { reader: 'env:LAB_READER', collector: 'env:LAB_COLLECTOR', deployer: 'env:LAB_DEPLOYER', runner: 'env:LAB_RUN_SECRET', setup: 'env:LAB_SETUP_SECRET' } },
    costs: { currency: 'USD', month: now.toISOString().slice(0, 7), observedAt: now.toISOString(), pricingAsOf: now.toISOString().slice(0, 10), materialUnknowns: ['Replace all example IDs, hostnames, release digest and material costs before setup'],
      lines: ['existing-spend', 'remaining-commitments', 'renewals', 'new-subscriptions', 'usage', 'tax', 'reserve'].map(category => ({ category, label: category, thisMonthCents: null, source: 'unpriced-example', assumption: 'Operator must supply current billing and pricing evidence' })) } });
  validateDiscoveryConfig(intent.discovery, root);
  return intent;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 2) { console.error('Example generator takes no arguments; writes JSON to stdout only.'); process.exitCode = 2; }
  else console.log(JSON.stringify(exampleIntent(process.cwd()), null, 2));
}
