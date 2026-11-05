import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const args = process.argv.slice(2);
const unavailable = gap => {
  console.log(JSON.stringify({ schemaVersion: 1, mode: 'live', status: 'unavailable', liveReadiness: false, stoppingStep: 'checkout', remoteWrites: 0, gaps: [gap] }));
  process.exitCode = 1;
};
if (args.length === 0) {
  const run = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/golden-path.test.ts', '--maxWorkers=1'], { stdio: 'inherit' });
  process.exitCode = run.status ?? 1;
} else if (args[0] === '--live') {
  let optIn = false; let approve = false; let resumePlanPath;
  let valid = true; const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) { valid = false; break; }
    seen.add(arg);
    if (arg === '--opt-in') optIn = true;
    else if (arg === '--approve') approve = true;
    else if (arg === '--resume-plan' && args[i + 1] && isAbsolute(args[i + 1])) resumePlanPath = args[++i];
    else { valid = false; break; }
  }
  if (!valid) { console.error('Usage: pnpm test:golden-path [--live [--opt-in] [--approve] [--resume-plan /absolute/plan.json]]'); process.exitCode = 2; }
  else if (!optIn) unavailable('Explicit live opt-in is missing. No provider or setup action ran.');
  else {
    const modulePath = resolve('dist/packages/demo-core/src/golden-path.js');
    if (!existsSync(modulePath)) unavailable('Build the installed workspace first; the production golden-path entrypoint is absent.');
    else {
      try {
        const { runGoldenPath } = await import(pathToFileURL(modulePath).href);
        const result = await runGoldenPath({ projectRoot: process.cwd(), checkoutRoot: process.cwd(), mode: 'live', liveOptIn: true, requestApproval: approve, lab: {}, demo: {}, ...(resumePlanPath ? { resumePlanPath } : {}) });
        console.log(JSON.stringify(result)); process.exitCode = result.status === 'passed' ? 0 : 1;
      } catch {
        // Do not infer a zero-write count after orchestration has started.
        console.log(JSON.stringify({ schemaVersion: 1, mode: 'live', status: 'failed', liveReadiness: false, stoppingStep: 'checkout', gaps: ['Production orchestration failed; inspect saved stage checkpoints.'] }));
        process.exitCode = 1;
      }
    }
  }
} else {
  console.error('Usage: pnpm test:golden-path [--live [--opt-in] [--approve] [--resume-plan /absolute/plan.json]]'); process.exitCode = 2;
}
