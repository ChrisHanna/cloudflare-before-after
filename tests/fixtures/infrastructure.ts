import { randomUUID } from 'node:crypto';
import type { CoreInventory, DeploymentSettings } from '../../packages/demo-core/src/infrastructure.js';
export function infrastructureFixture(): { inventory: CoreInventory; settings: DeploymentSettings } {
  const lab = 'workshop-test';
  const env = (role: 'before' | 'after') => ({ worker_name: `${lab}-${role}`, database_name: `${lab}-${role}-storefront`, database_id: randomUUID(), bucket_name: `${lab}-${role}-objects`, image_id: `${lab}-${role}-product`, image_owner: `${lab}:${role}:immutable-catalog`, container_name: `${lab}-${role}-origin` });
  const inventory: CoreInventory = { schema_version: 1, account_id: 'a'.repeat(32), lab_id: lab, image_variant: `${lab}-catalog`, environments: { before: env('before'), after: env('after') } };
  const image = (role: 'before' | 'after') => ({ id: inventory.environments[role].image_id, role, labId: lab, immutable: true as const, deliveryOrigin: 'https://imagedelivery.net' as const, accountHash: 'synthetic-account', variant: inventory.image_variant, expectedDigest: 'a'.repeat(64) });
  const settings: DeploymentSettings = { zoneId: 'b'.repeat(32), origins: { before: 'https://before.example.test', after: 'https://after.example.test', telemetry: 'https://receipts.example.test' }, releaseDigest: 'c'.repeat(64), viewRunId: randomUUID(), images: { before: image('before'), after: image('after') } };
  return { inventory, settings };
}
