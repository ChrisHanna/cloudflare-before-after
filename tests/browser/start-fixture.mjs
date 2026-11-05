// Test-only launcher. All Cloudflare data and credentials are synthetic.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.env.LAB_UI_FIXTURE !== '1') throw new Error('Explicit fixture-only launch required');
const source = process.cwd();
const scratch = process.env.KIROCREW_SCRATCH ?? process.env.LAB_TEST_SCRATCH;
if (!scratch) throw new Error('Set an explicit owned KIROCREW_SCRATCH or LAB_TEST_SCRATCH for browser tests');
const work = mkdtempSync(join(scratch, 'ui-fixture-')); const bundle = join(work, 'compiled'); const project = join(work, 'lab');
const compile = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tests/browser/tsconfig.server.json', '--outDir', bundle], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
if (compile.status !== 0) { console.error('Fixture compilation failed:', compile.stdout, compile.stderr); process.exit(1); }
writeFileSync(join(bundle, 'package.json'), '{"type":"module"}'); symlinkSync(join(source, 'node_modules'), join(bundle, 'node_modules'), 'dir');
mkdirSync(join(project, 'apps/command-center'), { recursive: true }); cpSync(join(source, 'apps/command-center/dist'), join(project, 'apps/command-center/dist'), { recursive: true });
const { startControlServer } = await import(pathToFileURL(join(bundle, 'apps/control-server/src/server.js')).href);
const { demoLabFixture } = await import(pathToFileURL(join(bundle, 'tests/fixtures/demo-lab.js')).href);
const lab = demoLabFixture(project, undefined, Date.now, 'entitled'); let server;
const { runDemoCli } = await import(pathToFileURL(join(bundle, 'packages/demo-core/src/demo-cli.js')).href);
const seeded = await runDemoCli(['waf-custom', '--json'], { projectRoot: project, mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: lab.dispatch });
if (seeded.exitCode !== 0) throw new Error('Standalone synthetic CLI capture failed');
server = await startControlServer({ projectRoot: project, port: 4173, demo: { mode: 'fixture', loadConfig: () => lab.config, credentials: () => lab.credentials, dispatch: async (url, init) => {
  // Leave enough time for browser tests to observe/stop an active job.
  await new Promise((done, reject) => {
    const abort = () => { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); reject(new Error('Fixture stopped')); };
    const timer = setTimeout(() => { init.signal?.removeEventListener('abort', abort); done(); }, 60);
    if (init.signal?.aborted) abort(); else init.signal?.addEventListener('abort', abort, { once: true });
  });
  return lab.dispatch(url, init);
} }, onPendingApproval: code => { queueMicrotask(() => server?.control.approvePending(code)); } });
console.log(`Fixture-only Command Center: ${server.origin}; no live Cloudflare traffic.`);
let closing = false;
const close = async () => { if (closing) return; closing = true; await server.close(); rmSync(work, { recursive: true, force: true }); process.exitCode = 0; };
process.once('SIGINT', close); process.once('SIGTERM', close);
