import { z } from 'zod';
import { ToolFailureSchema } from './deployment-diagnostics.js';
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Digest, Id, Time } from '../../contracts/src/schemas.js';
import { PlanSchema, digestValue, PLAN_LIFETIME_MS, type DeploymentPlan } from './deployment-plan.js';
import { validateEvidenceDirectory } from './config.js';
const StoredPlan = z.strictObject({ plan: PlanSchema, digest: Digest });
const Approval = z.strictObject({ schemaVersion: z.literal(1), planId: Id, planDigest: Digest, approvedAt: Time, method: z.literal('interactive-tty') });
export type PlanApproval = z.infer<typeof Approval>;
const Resource = z.strictObject({ kind: z.string().max(100), id: z.string().max(256), operationId: z.string().max(256), certainty: z.enum(['confirmed', 'possible']) });
export const ApplyRecordSchema = z.strictObject({ schemaVersion: z.literal(1), planId: Id, planDigest: Digest, startedAt: Time, finishedAt: Time.nullable(), status: z.enum(['running', 'succeeded', 'failed']), completedSteps: z.array(z.string().max(256)).max(100), resources: z.array(Resource).max(500), failure: z.string().max(256).nullable(), toolFailure: ToolFailureSchema.optional() });
export type ApplyRecord = z.infer<typeof ApplyRecordSchema>;
export class DeploymentStore {
  readonly directory: string;
  constructor(readonly projectRoot: string, readonly evidenceDirectory: string) {
    this.directory = join(validateEvidenceDirectory(evidenceDirectory, projectRoot), 'deployment', 'plans');
  }
  #ensure(): void { validateEvidenceDirectory(this.directory, this.projectRoot); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); validateEvidenceDirectory(this.directory, this.projectRoot); }
  #read(path: string): string {
    if (!isAbsolute(path)) throw new Error('Absolute saved plan path required');
    const rel = relative(this.directory, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || dirname(path) !== this.directory) throw new Error('Saved plan must be in the configured owned plan directory');
    validateEvidenceDirectory(dirname(path), this.projectRoot);
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid bounded plan file');
    return readFileSync(path, 'utf8');
  }
  #path(id: string, suffix: string): string { return join(this.directory, `${Id.parse(id)}.${suffix}.json`); }
  save(input: DeploymentPlan): { planPath: string; digest: string } {
    const plan = PlanSchema.parse(input); this.#ensure();
    const path = this.#path(plan.id, 'plan'); const digest = digestValue(plan);
    writeFileSync(path, JSON.stringify({ plan, digest }), { flag: 'wx', mode: 0o600 });
    return { planPath: path, digest };
  }
  load(path: string): { plan: DeploymentPlan; digest: string } {
    const record = StoredPlan.parse(JSON.parse(this.#read(path)));
    if (path !== this.#path(record.plan.id, 'plan') || digestValue(record.plan) !== record.digest) throw new Error('Saved plan integrity mismatch');
    return record;
  }
  approve(path: string, confirmation: string, interactiveTTY: boolean, now = Date.now()): PlanApproval {
    const { plan, digest } = this.load(path);
    if (!interactiveTTY || confirmation !== `APPROVE ${digest}`) throw new Error('Exact interactive operator confirmation required');
    if (plan.status !== 'review-required' || plan.blockers.length || now < Date.parse(plan.createdAt) || now >= Date.parse(plan.expiresAt)) throw new Error('Blocked or expired plan cannot be approved');
    const approval = Approval.parse({ schemaVersion: 1, planId: plan.id, planDigest: digest, approvedAt: new Date(now).toISOString(), method: 'interactive-tty' });
    writeFileSync(this.#path(plan.id, 'approval'), JSON.stringify(approval), { flag: 'wx', mode: 0o600 });
    return approval;
  }
  approval(plan: DeploymentPlan, digest: string, now = Date.now()): PlanApproval {
    const approval = Approval.parse(JSON.parse(this.#read(this.#path(plan.id, 'approval'))));
    const age = now - Date.parse(approval.approvedAt);
    if (approval.planId !== plan.id || approval.planDigest !== digest || age < 0 || age > PLAN_LIFETIME_MS || Date.parse(approval.approvedAt) < Date.parse(plan.createdAt) || Date.parse(approval.approvedAt) >= Date.parse(plan.expiresAt)) throw new Error('Approval does not match the current exact plan');
    return approval;
  }
  begin(plan: DeploymentPlan, digest: string, now = Date.now()): ApplyRecord {
    const record = ApplyRecordSchema.parse({ schemaVersion: 1, planId: plan.id, planDigest: digest, startedAt: new Date(now).toISOString(), finishedAt: null, status: 'running', completedSteps: [], resources: [], failure: null });
    // Exclusive attempt is consumed before any mutation. Recovery always requires a new plan.
    writeFileSync(this.#path(plan.id, 'attempt'), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return record;
  }
  update(record: ApplyRecord): void {
    const validated = ApplyRecordSchema.parse(record); const path = this.#path(record.planId, 'attempt');
    const previous = ApplyRecordSchema.parse(JSON.parse(this.#read(path)));
    if (previous.planDigest !== record.planDigest || previous.status !== 'running') throw new Error('Attempt is terminal or belongs to another plan');
    const temp = this.#path(randomUUID(), 'pending');
    try { writeFileSync(temp, JSON.stringify(validated), { flag: 'wx', mode: 0o600 }); renameSync(temp, path); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
  }
}
