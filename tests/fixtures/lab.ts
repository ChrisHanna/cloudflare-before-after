import { resolve } from 'node:path';
import type { LabConfig } from '../../packages/demo-core/src/config.js';
export function labConfig(projectRoot = process.cwd()): LabConfig {
  const env = (role: 'before' | 'after') => ({ role, origin: `https://${role}.example.test`, workerName: `${role}-worker`, containerBinding: `${role}-container`, d1Id: role === 'before' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', r2Bucket: `${role}-bucket`, imageIds: [`${role}-image`], releaseDigest: 'a'.repeat(64) });
  const environments = [env('before'), env('after')] as LabConfig['environments'];
  return {
    schemaVersion: 1, purpose: 'synthetic-lab', ownedLab: true, labId: 'test-lab', accountId: 'a'.repeat(32), zoneId: 'd'.repeat(32),
    environments, telemetryOrigin: 'https://receipts.example.test', apiOrigin: 'https://api.cloudflare.com', imageOrigins: ['https://imagedelivery.net'],
    credentials: { reader: 'env:LAB_READER', collector: 'env:LAB_COLLECTOR' }, evidenceDirectory: resolve(projectRoot, '.evidence'), liveOptIn: false,
    inventory: environments.flatMap(e => [
      { type: 'worker' as const, id: e.workerName, role: e.role, labId: 'test-lab' },
      { type: 'container' as const, id: e.containerBinding, role: e.role, labId: 'test-lab' },
      { type: 'd1' as const, id: e.d1Id, role: e.role, labId: 'test-lab' },
      { type: 'r2' as const, id: e.r2Bucket, role: e.role, labId: 'test-lab' },
      { type: 'image' as const, id: e.imageIds[0]!, role: e.role, labId: 'test-lab' },
    ]),
  };
}
