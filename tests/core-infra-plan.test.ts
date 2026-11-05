import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CoreInventorySchema, renderDeployment, provisionOwnedImage, SYNTHETIC_IMAGE_DIGEST, type OwnedImageApi } from '../packages/demo-core/src/infrastructure.js';
import { infrastructureFixture } from './fixtures/infrastructure.js';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
describe('core-infra-plan', () => {
  it('derives separate deploys, binding IDs and routing from one owned inventory', () => {
    const { inventory, settings } = infrastructureFixture(); const output = renderDeployment(inventory, settings, process.cwd());
    expect(output.environments).toHaveLength(2); expect(output.order.indexOf('routing-terraform')).toBeGreaterThan(output.order.indexOf('secret-provisioning')); expect(output.order.at(-2)).toBe('owned-seeds');
    expect(output.environments.map(e => e.config.d1_databases[0]!.database_id)).toEqual([inventory.environments.before.database_id, inventory.environments.after.database_id]);
    for (const e of output.environments) {
      expect(e.config.workers_dev).toBe(false); expect(e.config.preview_urls).toBe(false);
      expect(e.config.containers[0]).toMatchObject({ instance_type: 'lite', max_instances: 4, ssh: { enabled: false } });
      expect(e.config).not.toHaveProperty('routes'); expect(e.requiredSecrets).toContain('INGEST_ROOT_SECRET');
      expect(JSON.stringify(e.config)).not.toContain('Enterprise');
    }
    expect(output.telemetry.config.d1_databases).toHaveLength(2);
    expect(Object.keys(output.routingVariables.routes)).toEqual(['before', 'after', 'telemetry']);
  });
  it('rejects shared D1 IDs, foreign image ownership and aliased hostnames', () => {
    const f = infrastructureFixture(); f.inventory.environments.after.database_id = f.inventory.environments.before.database_id;
    expect(() => CoreInventorySchema.parse(f.inventory)).toThrow('separate');
    const g = infrastructureFixture(); g.settings.images.after.labId = 'other-lab';
    expect(() => renderDeployment(g.inventory, g.settings, process.cwd())).toThrow('ownership');
    const h = infrastructureFixture(); h.settings.origins.after = h.settings.origins.before;
    expect(() => renderDeployment(h.inventory, h.settings, process.cwd())).toThrow('separate');
  });
  it('uploads only the declared synthetic image and reruns without duplicate/foreign writes', async () => {
    const { inventory } = infrastructureFixture(); const values = new Map<string, { id: string; metadata: { owner: string; sourceDigest: string }; variants: string[] }>();
    const upload = vi.fn(async (input: Parameters<OwnedImageApi['upload']>[0]) => { expect(input.bytes.length).toBeLessThan(32768); expect(input.requireSignedUrls).toBe(false); const value = { id: input.id, metadata: input.metadata, variants: [] }; values.set(input.id, value); return value; });
    const api: OwnedImageApi = { inspect: async id => values.get(id) ?? null, upload };
    await provisionOwnedImage(api, inventory, 'before'); await provisionOwnedImage(api, inventory, 'before'); await provisionOwnedImage(api, inventory, 'after');
    expect(upload).toHaveBeenCalledTimes(2);
    expect(values.get(inventory.environments.before.image_id)?.metadata.sourceDigest).toBe(SYNTHETIC_IMAGE_DIGEST);
    values.get(inventory.environments.before.image_id)!.metadata.owner = 'foreign';
    await expect(provisionOwnedImage(api, inventory, 'before')).rejects.toThrow('foreign'); expect(upload).toHaveBeenCalledTimes(2);
  });
  it('validates actual Worker bundles locally without deployment, Docker installs or personal account state', () => {
    const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
    const root = mkdtempSync(join(scratch, 'wrangler-core-')); roots.push(root); const home = join(root, 'home'); mkdirSync(home);
    const { inventory, settings } = infrastructureFixture(); const output = renderDeployment(inventory, settings, process.cwd());
    const executable = resolve('node_modules/wrangler/bin/wrangler.js');
    for (const entry of [...output.environments.map(e => ({ name: e.role, config: e.config })), { name: 'telemetry', config: output.telemetry.config }]) {
      const config = join(root, `${entry.name}.json`); const outdir = join(root, `bundle-${entry.name}`); writeFileSync(config, JSON.stringify(entry.config));
      // Wrangler dry-run otherwise builds Docker images and may install packages.
      // This validates Worker bundles only; Container image qualification is separate.
      const log = execFileSync(process.execPath, [executable, 'deploy', '--dry-run', '--containers-rollout=none', '--config', config, '--outdir', outdir], { cwd: process.cwd(), timeout: 45000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: root, WRANGLER_SEND_METRICS: 'false', WRANGLER_DOCKER_BIN: join(root, 'docker-denied'), CI: 'true', NO_COLOR: '1' } });
      expect(log).toContain('dry-run'); expect(log).not.toContain('docker build'); expect(existsSync(outdir)).toBe(true);
    }
  }, 150000);
});
