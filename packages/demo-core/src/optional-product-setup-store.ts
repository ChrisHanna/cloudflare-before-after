import { z } from 'zod';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, mkdirSync, fstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateEvidenceDirectory } from './config.js';
import { digestValue } from './deployment-plan.js';
import type { OptionalProductJournal, OptionalProductRecord } from './optional-product-setup.js';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.strictObject({ key: z.string().regex(/^[a-f0-9]{64}:[a-f0-9]{64}$/), planDigest: Digest, operationId: Digest,
  state: z.enum(['possible', 'confirmed']), resourceIds: z.array(z.string().regex(/^[a-f0-9]{32}$|^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)).max(3), afterDigest: Digest.nullable(),
}).superRefine((r, ctx) => {
  if (r.key !== `${r.planDigest}:${r.operationId}` || (r.state === 'confirmed') !== (r.afterDigest !== null) || (r.state === 'confirmed' && r.resourceIds.length !== 1)) ctx.addIssue({ code: 'custom', message: 'Journal identity or certainty mismatch' });
});
export { RecordSchema as OptionalProductRecordSchema };
/** Durable intent is consumed before dispatch. Interrupted intent cannot be replayed. */
export class OptionalProductFileJournal implements OptionalProductJournal {
  readonly directory: string;
  constructor(readonly projectRoot: string, evidenceDirectory: string) {
    this.directory = join(validateEvidenceDirectory(evidenceDirectory, projectRoot), 'deployment', 'optional-products');
    validateEvidenceDirectory(this.directory, projectRoot); mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    validateEvidenceDirectory(this.directory, projectRoot);
  }
  #path(key: string) {
    if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key)) throw new Error('Invalid optional-operation key');
    validateEvidenceDirectory(this.directory, this.projectRoot);
    return join(this.directory, `${key.replace(':', '-')}.json`);
  }
  async get(key: string): Promise<OptionalProductRecord | null> {
    let fd: number;
    try { fd = openSync(this.#path(key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Journal read failed'); }
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid bounded journal file');
      const record = RecordSchema.parse(JSON.parse(readFileSync(fd, 'utf8')));
      if (record.key !== key) throw new Error('Journal identity mismatch'); return record;
    } finally { closeSync(fd); }
  }
  #write(path: string, record: OptionalProductRecord) {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(RecordSchema.parse(record))); fsyncSync(fd); } finally { closeSync(fd); }
  }
  #syncDirectory() { const fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  async begin(input: OptionalProductRecord): Promise<void> {
    const record = RecordSchema.parse(input);
    if (record.state !== 'possible' || record.afterDigest !== null) throw new Error('Only uncertain intent may begin');
    this.#write(this.#path(record.key), record); this.#syncDirectory();
  }
  async save(input: OptionalProductRecord): Promise<void> {
    const record = RecordSchema.parse(input); const prior = await this.get(record.key);
    if (!prior || prior.planDigest !== record.planDigest || prior.operationId !== record.operationId) throw new Error('Journal intent missing or changed');
    if (prior.state === 'confirmed' && digestValue(prior) !== digestValue(record)) throw new Error('Confirmed operation is immutable');
    const path = this.#path(record.key); const temporary = join(this.directory, `${randomUUID()}.pending`);
    this.#write(temporary, record); renameSync(temporary, path); this.#syncDirectory();
  }
}
