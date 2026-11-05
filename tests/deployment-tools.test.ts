import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runBoundedTool, LocalDeploymentTools } from '../packages/demo-core/src/deployment-tools.js';
import { DeploymentToolError } from '../packages/demo-core/src/deployment-diagnostics.js';
import { deploymentIntent, FIXTURE_CREDENTIALS } from './fixtures/deployment.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'deploy-tools-')); roots.push(root); return root;
}
describe('deployment-tools', () => {
  it('runs without a shell and retains no raw failure output', async () => {
    const root = fixture(); const env = { PATH: process.env.PATH ?? '' };
    await expect(runBoundedTool(process.execPath, ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'literal; echo NOT_A_SHELL'], { cwd: root, env })).resolves.toContain('literal; echo NOT_A_SHELL');
    await expect(runBoundedTool(process.execPath, ['-e', 'console.error("private-canary-secret");process.exit(1)'], { cwd: root, env })).rejects.toThrow('no raw output retained');
  });
  it('kills owned command groups on cancellation and rejects oversized output', async () => {
    const root = fixture(); const env = { PATH: process.env.PATH ?? '' }; const controller = new AbortController();
    const pending = runBoundedTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: root, env, signal: controller.signal });
    const check = expect(pending).rejects.toThrow('bounds'); controller.abort(); await check;
    await expect(runBoundedTool(process.execPath, ['-e', 'console.log("x".repeat(5000))'], { cwd: root, env, maxBytes: 64 })).rejects.toThrow('bounds');
  });
  it.each(['deadline', 'abort', 'output-cap'] as const)('settles %s without waiting for escaped descendant pipes or claiming quiescence', async kind => {
    const root = fixture(); const pidFile = join(root, 'synthetic-descendant.pid');
    const leaf = 'setTimeout(()=>{},1600)';
    const code = `const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');const p=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:['ignore',1,2],env:{PATH:process.env.PATH}});writeFileSync(${JSON.stringify(pidFile)},String(p.pid));p.unref();${kind === 'output-cap' ? 'setTimeout(()=>{console.log("x".repeat(4096));process.exit(1)},120)' : 'process.exit(1)'}`;
    const controller = new AbortController(); const timer = kind === 'abort' ? setTimeout(() => controller.abort(new Error('private-abort-canary')), 200) : undefined;
    const start = performance.now(); let failure: unknown;
    try { await runBoundedTool(process.execPath, ['-e', code], { cwd: root, env: { PATH: process.env.PATH ?? '' }, signal: controller.signal, timeoutMs: kind === 'deadline' ? 200 : 3000, maxBytes: kind === 'output-cap' ? 64 : 65536, diagnosticMode: 'terraform-json' }); }
    catch (error) { failure = error; }
    finally { if (timer) clearTimeout(timer); }
    expect(failure).toBeInstanceOf(DeploymentToolError);
    expect((failure as DeploymentToolError).failure).toMatchObject({ stopped: true, processQuiescence: 'unproven', diagnostics: [] });
    expect(JSON.stringify(failure)).not.toContain('private-abort-canary');
    expect(performance.now() - start).toBeLessThan(1100);
    // The test descendant owns its own short expiry; a quick rejection is not a kill claim.
    const pid = Number(readFileSync(pidFile, 'utf8')); expect(() => process.kill(pid, 0)).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 1700));
  });
  it('does not expose a caller-supplied abort reason or spawn after an existing abort', async () => {
    const controller = new AbortController(); controller.abort(new Error('private-pre-abort-canary'));
    try { await runBoundedTool('/nonexistent-no-spawn', [], { cwd: fixture(), env: {}, signal: controller.signal }); }
    catch (error) { expect(error).toBeInstanceOf(DeploymentToolError); expect(JSON.stringify(error)).not.toContain('private-pre-abort-canary'); expect((error as DeploymentToolError).failure.stopped).toBe(true); return; }
    throw new Error('Already-aborted tool unexpectedly succeeded');
  });
  it('retains only allowlisted Terraform JSON metadata from an actual failed child', async () => {
    const root = fixture(); const secret = 'never-emit-this-provider-secret';
    const event = { type: 'diagnostic', diagnostic: { severity: 'error', summary: 'failed to make http request', address: 'cloudflare_image_variant.catalog', detail: `HTTP 403 {"errors":[{"code":10000,"message":"${secret}"}]}` } };
    try {
      await runBoundedTool(process.execPath, ['-e', `console.log(${JSON.stringify(JSON.stringify(event))});console.error(${JSON.stringify(secret)});process.exit(1)`], { cwd: root, env: { PATH: process.env.PATH ?? '' }, diagnosticMode: 'terraform-json' });
      throw new Error('Expected tool failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DeploymentToolError);
      expect((error as DeploymentToolError).failure.diagnostics[0]).toMatchObject({ resource: 'cloudflare_image_variant.catalog', httpStatus: 403, providerCodes: [10000] });
      expect(JSON.stringify(error)).not.toContain(secret); expect(String(error)).not.toContain(secret);
    }
  });
  it('requests structured JSON for apply without changing its mutation scope', async () => {
    const root = fixture(); const intent = deploymentIntent(root);
    const fake = join(root, 'terraform-json-fixture');
    writeFileSync(fake, `#!${process.execPath}\nif(!process.argv.includes('-json'))process.exit(2);console.log(JSON.stringify({type:'diagnostic',diagnostic:{severity:'error',summary:'failed to make http request',address:'cloudflare_image_variant.catalog',detail:'HTTP 400 {"code":5400}'}}));process.exit(1);\n`); chmodSync(fake, 0o700);
    const tool = new LocalDeploymentTools(root, intent.discovery.evidenceDirectory, FIXTURE_CREDENTIALS.deployer, fake);
    const cwd = join(intent.discovery.evidenceDirectory, 'deployment/tool-home'); const path = join(cwd, 'core.tfplan'); writeFileSync(path, 'fixture only');
    await expect(tool.applyTerraform(path, cwd, new AbortController().signal)).rejects.toMatchObject({ failure: { diagnostics: [{ httpStatus: 400, providerCodes: [5400] }] } });
  });
  it('does not expose mutation commands in read-only Terraform preparation', async () => {
    const root = fixture(); const intent = deploymentIntent(root);
    const fake = join(root, 'terraform-fixture'); writeFileSync(fake, `#!${process.execPath}\nconsole.log('{}');\n`); chmodSync(fake, 0o700);
    const tool = new LocalDeploymentTools(root, intent.discovery.evidenceDirectory, FIXTURE_CREDENTIALS.deployer, fake);
    for (const args of [['apply'], ['destroy'], ['import'], ['state', 'rm']]) await expect(tool.terraform(args, join(intent.discovery.evidenceDirectory, 'deployment/tool-home'))).rejects.toThrow('cannot mutate');
    await expect(tool.wrangler(['delete'], join(intent.discovery.evidenceDirectory, 'deployment/tool-home'), new AbortController().signal)).rejects.toThrow('Unsupported');
    await expect(tool.terraform(['version'], '/outside/owned/root')).rejects.toThrow('configured');
  });
});
