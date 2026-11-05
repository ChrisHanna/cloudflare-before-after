import { z } from 'zod';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RateSettingsSchema } from '../../contracts/src/schemas.js';
import { validateEvidenceDirectory } from './config.js';
import { validatePlan, type Limits } from './budget.js';
export function planRateBurst(settings: z.infer<typeof RateSettingsSchema>, limits: Limits, alreadyUsed = 0) {
  const actual = RateSettingsSchema.parse(settings);
  if (actual.characteristics.join(',') !== 'cf.colo.id,ip.src' || actual.requests_per_period > 8 || actual.mitigation_timeout < 1) throw new Error('Unsupported or unsafe counting key/threshold');
  const signals = actual.requests_per_period + 1; const requests = signals * 2 + 8;
  validatePlan(limits, alreadyUsed + requests, 0, 1000);
  const quietMs = (actual.period + actual.mitigation_timeout) * 1000 + 1000;
  if (quietMs > 120000) throw new Error('Configured cooldown exceeds the bounded scenario');
  return { signals, requests, quietMs, windowMs: actual.period * 1000 };
}
const Stamp = z.strictObject({ schemaVersion: z.literal(1), labId: z.string().regex(/^[a-z][a-z0-9-]{2,19}$/), lastRunId: z.uuid(), readyAt: z.iso.datetime() });
/** Conservative shared-IP quiet time. This never resets a Cloudflare counter. */
export class RateCooldown {
  readonly directory: string; readonly file: string;
  constructor(root: string, evidence: string, readonly labId: string, readonly now: () => number) {
    Stamp.shape.labId.parse(labId); this.directory = join(evidence, 'cooldown'); validateEvidenceDirectory(this.directory, root); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); this.file = join(this.directory, `${labId}-rate-limit.json`);
  }
  remaining(): number {
    if (!existsSync(this.file)) return 0;
    const fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid cooldown metadata'); const value = Stamp.parse(JSON.parse(readFileSync(fd, 'utf8'))); if (value.labId !== this.labId) throw new Error('Foreign cooldown'); return Math.max(0, Date.parse(value.readyAt) - this.now()); }
    finally { closeSync(fd); }
  }
  note(runId: string, quietMs: number): string {
    if (!Number.isSafeInteger(quietMs) || quietMs < 1 || quietMs > 120000) throw new Error('Unsupported cooldown duration');
    const readyAt = new Date(this.now() + quietMs).toISOString(); const temporary = join(this.directory, `.rate-${randomUUID()}`);
    writeFileSync(temporary, JSON.stringify(Stamp.parse({ schemaVersion: 1, labId: this.labId, lastRunId: runId, readyAt })), { flag: 'wx', mode: 0o600 }); renameSync(temporary, this.file); return readyAt;
  }
}
