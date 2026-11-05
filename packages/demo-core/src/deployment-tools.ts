import { spawn } from 'node:child_process';
import { DeploymentToolError, terraformFailure } from './deployment-diagnostics.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { CORE_VERSIONS } from './infrastructure.js';
import { validateEvidenceDirectory } from './config.js';
import type { TerraformReadTool } from './terraform-plan.js';
const TF_READ = new Set(['init', 'plan', 'show', 'output', 'version']);
export interface DeploymentTools extends TerraformReadTool {
  verifyVersions(signal?: AbortSignal): Promise<void>;
  applyTerraform(path: string, cwd: string, signal: AbortSignal): Promise<void>;
  wrangler(args: readonly string[], cwd: string, signal: AbortSignal, input?: string): Promise<string>;
  close(): Promise<void>;
}
export function runBoundedTool(executable: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; input?: string; timeoutMs?: number; maxBytes?: number; diagnosticMode?: 'terraform-json' }): Promise<string> {
  if (options.signal?.aborted) throw new DeploymentToolError(terraformFailure('', null, true));
  if (process.platform === 'win32') throw new Error('Use a POSIX host such as WSL for process-group cancellation');
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], { cwd: options.cwd, env: options.env, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clean = () => { if (timer) clearTimeout(timer); options.signal?.removeEventListener('abort', terminate); };
    const discardPipes = () => { chunks.length = 0; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); };
    const terminate = () => {
      if (settled) return;
      settled = true;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      clean(); discardPipes();
      // Escaped descendants may survive. Settle the wait, not a quiescence claim.
      reject(new DeploymentToolError(terraformFailure('', child.exitCode, true)));
    };
    timer = setTimeout(terminate, options.timeoutMs ?? 120000);
    options.signal?.addEventListener('abort', terminate, { once: true });
    child.stdout.on('data', (data: Buffer) => { if (settled) return; size += data.length; if (size > (options.maxBytes ?? 16 * 1024 * 1024)) terminate(); else chunks.push(data); });
    child.stderr.on('data', (data: Buffer) => { if (settled) return; size += data.length; if (size > (options.maxBytes ?? 16 * 1024 * 1024)) terminate(); });
    child.stdin.on('error', terminate);
    child.on('error', () => { if (settled) return; settled = true; clean(); discardPipes(); reject(new Error('Deployment tool could not start')); });
    child.on('close', code => {
      if (settled) return;
      settled = true; clean(); const output = Buffer.concat(chunks).toString('utf8'); chunks.length = 0;
      if (code !== 0 || options.signal?.aborted) {
        reject(new DeploymentToolError(terraformFailure(options.diagnosticMode === 'terraform-json' ? output : '', code, options.signal?.aborted === true)));
      } else resolvePromise(output);
    });
    if (options.signal?.aborted) terminate();
    if (!settled) child.stdin.end(options.input);
  });
}
// Provider plugins fail to start when their temp files sit on a Windows-mounted drive under WSL.
export function resolveToolScratch(env: NodeJS.ProcessEnv, tmp: () => string = tmpdir): string {
  const configured = env['KIROCREW_SCRATCH'];
  const base = configured || tmp();
  if (!isAbsolute(base)) throw new Error('Tool scratch directory must be an absolute path');
  if (/^\/mnt\/[a-z]\//i.test(base)) throw new Error('Tool scratch must be on Linux storage, not a Windows-mounted drive; set KIROCREW_SCRATCH to a path such as /tmp/cf-lab');
  return configured ? configured : mkdtempSync(join(base, 'cf-lab-'));
}
export class LocalDeploymentTools implements DeploymentTools {
  readonly #home: string;
  readonly #terraform: string;
  #scratch: string | undefined;
  constructor(readonly projectRoot: string, readonly evidenceDirectory: string, readonly deploymentToken: string, terraformBinary = process.env['TERRAFORM_BIN'] ?? 'terraform') {
    if (deploymentToken.length < 24) throw new Error('Deployment credential required');
    this.#terraform = terraformBinary;
    this.#home = join(validateEvidenceDirectory(evidenceDirectory, projectRoot), 'deployment', 'tool-home');
    mkdirSync(this.#home, { recursive: true, mode: 0o700 }); validateEvidenceDirectory(this.#home, projectRoot);
  }
  #environment(): NodeJS.ProcessEnv {
    this.#scratch ??= resolveToolScratch(process.env);
    return { PATH: process.env['PATH'] ?? '', HOME: this.#home, TMPDIR: this.#scratch, CI: 'true', NO_COLOR: '1', TF_INPUT: 'false', TF_IN_AUTOMATION: 'true', CLOUDFLARE_API_TOKEN: this.deploymentToken, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error' };
  }
  #cwd(path: string): void {
    if (!isAbsolute(path)) throw new Error('Absolute tool workspace required');
    const rel = relative(this.evidenceDirectory, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Tool workspace must remain in the configured owned deployment directory');
    validateEvidenceDirectory(path, this.projectRoot);
  }
  async verifyVersions(signal?: AbortSignal): Promise<void> {
    const result = JSON.parse(await runBoundedTool(this.#terraform, ['version', '-json'], { cwd: this.#home, env: this.#environment(), ...(signal ? { signal } : {}), timeoutMs: 10000 }));
    const wrangler = JSON.parse(readFileSync(join(this.projectRoot, 'node_modules/wrangler/package.json'), 'utf8'));
    const containers = JSON.parse(readFileSync(join(this.projectRoot, 'apps/storefront-worker/node_modules/@cloudflare/containers/package.json'), 'utf8'));
    if (result.terraform_version !== CORE_VERSIONS.terraform || wrangler.version !== CORE_VERSIONS.wrangler || containers.version !== CORE_VERSIONS.containersSdk) throw new Error('Deployment tool versions differ from reviewed pins');
  }
  async terraform(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
    this.#cwd(cwd); if (!TF_READ.has(args[0] ?? '')) throw new Error('Read-only Terraform preparation cannot mutate infrastructure');
    return runBoundedTool(this.#terraform, args, { cwd, env: this.#environment(), ...(signal ? { signal } : {}) });
  }
  async applyTerraform(path: string, cwd: string, signal: AbortSignal): Promise<void> {
    this.#cwd(cwd); validateEvidenceDirectory(resolve(path, '..'), this.projectRoot);
    if (!isAbsolute(path) || !existsSync(path) || !/\/(core|routing)\.tfplan$/.test(path)) throw new Error('Original reviewed Terraform binary plan required');
    await runBoundedTool(this.#terraform, ['apply', '-json', '-input=false', '-lock-timeout=5s', path], { cwd, env: this.#environment(), signal, diagnosticMode: 'terraform-json' });
  }
  async wrangler(args: readonly string[], cwd: string, signal: AbortSignal, input?: string): Promise<string> {
    this.#cwd(cwd);
    const supported = args[0] === 'deploy' || (args[0] === 'd1' && args[1] === 'migrations' && args[2] === 'apply') || (args[0] === 'secret' && args[1] === 'bulk');
    if (!supported || args.includes('--delete') || args.includes('--force')) throw new Error('Unsupported setup action');
    const binary = join(this.projectRoot, 'node_modules/wrangler/bin/wrangler.js');
    return runBoundedTool(process.execPath, [binary, ...args], { cwd, env: this.#environment(), signal, ...(input !== undefined ? { input } : {}) });
  }
  async close(): Promise<void> {}
}
