import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, lstatSync, copyFileSync, chmodSync, openSync, readSync, closeSync, rmSync } from 'node:fs';
import { resolve, join, isAbsolute, parse, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// Deliberate trust inventory. New roots/providers require explicit review here.
export const TERRAFORM_ROOTS = [
  { name: 'core', path: 'infra/terraform' },
  { name: 'core-public', path: 'infra/terraform/core-public' },
  { name: 'routing', path: 'infra/terraform/routing' },
];
const TF_VERSION = '1.17.1';
const PROVIDER_VERSION = '5.28.1';
const PROVIDER = 'registry.terraform.io/cloudflare/cloudflare';
const MAX_OUTPUT = 131072;
const MAX_PACKAGE_BYTES = 536870912;

function stopped(root) {
  // Historical workflow controls are not current stop signals.
  const paths = ['STOP', 'STOP.md', '.kiro/STOP', '.kiro/STOP.md'];
  const spec = '.kiro/specs/exactly-we-should-build-automated';
  if (existsSync(resolve(root, spec))) for (const name of readdirSync(resolve(root, spec))) if (/stop/i.test(name)) paths.push(`${spec}/${name}`);
  return paths.some(path => existsSync(resolve(root, path)));
}
function cleanEnv(home, scratch, path) {
  return { PATH: path ?? '/usr/bin:/bin', HOME: home, KIROCREW_SCRATCH: scratch, TMPDIR: scratch, LAB_TEST_SCRATCH: scratch, CI: 'true', NO_COLOR: '1', COREPACK_ENABLE_NETWORK: '0', npm_config_offline: 'true', WRANGLER_SEND_METRICS: 'false' };
}
function regularFile(path, maxBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Expected bounded regular file');
  return stat;
}
function plainDirectory(path) {
  // No symlink traversal from an operator-approved package input.
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split('/').filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Expected plain directory');
  }
}
function hashFile(path) {
  const hash = createHash('sha256'); const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1048576); let size;
    while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { closeSync(fd); }
}
function hclString(value) {
  return JSON.stringify(value.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{'));
}
// A bounded lexical scope check, not an HCL evaluator. Keep quoted tokens intact;
// comments can separate tokens but never join them or consume quoted markers.
// Trusted roots use only simple traversal templates. Heredocs, directives and
// richer interpolations fail closed rather than guessing their quote boundaries.
function hclTokens(bytes) {
  const invalid = () => { throw new Error('invalid-hcl-lexeme'); };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { invalid(); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) invalid();
  const tokens = []; const delimiters = []; let newlineBefore = false;
  function token(kind, value) { tokens.push({ kind, value, newlineBefore }); newlineBefore = false; }
  const identifier = /[A-Za-z_][A-Za-z0-9_-]*/y;
  const traversal = /\$\{[ \t]*[A-Za-z_][A-Za-z0-9_-]*(?:[ \t]*\.[ \t]*[A-Za-z_][A-Za-z0-9_-]*)*[ \t]*\}/y;
  let i = 0;
  while (i < text.length) {
    const start = i; const char = text[i]; const pair = text.slice(i, i + 2);
    if (/[ \t\r\n]/.test(char)) { if (char === '\r' || char === '\n') newlineBefore = true; i++; continue; }
    if (char === '#' || pair === '//') {
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
      continue;
    }
    if (pair === '/*') {
      const end = text.indexOf('*/', i + 2); const nested = text.indexOf('/*', i + 2);
      if (end < 0 || (nested >= 0 && nested < end)) invalid();
      i = end + 2; continue;
    }
    if (pair === '*/') invalid();
    if (pair === '<<') throw new Error('unsupported-hcl-heredoc');
    if (char === '"') {
      i++; let closed = false;
      while (i < text.length) {
        if (text[i] === '"') { i++; closed = true; break; }
        if (text[i] === '\r' || text[i] === '\n') invalid();
        if (text[i] === '\\') {
          const escape = text[i + 1];
          if (escape && '"\\nrt'.includes(escape)) { i += 2; continue; }
          const digits = escape === 'u' ? 4 : escape === 'U' ? 8 : 0;
          const hex = text.slice(i + 2, i + 2 + digits);
          if (!digits || hex.length !== digits || !/^[0-9a-fA-F]+$/.test(hex)) invalid();
          const point = parseInt(hex, 16);
          if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) invalid();
          i += 2 + digits; continue;
        }
        const triple = text.slice(i, i + 3);
        if (triple === '$${' || triple === '%%{') { i += 3; continue; }
        if (text.slice(i, i + 2) === '%{') throw new Error('unsupported-hcl-template');
        if (text.slice(i, i + 2) === '${') {
          traversal.lastIndex = i; const match = traversal.exec(text);
          if (!match) throw new Error('unsupported-hcl-template');
          i = traversal.lastIndex; continue;
        }
        i++;
      }
      if (!closed) invalid();
      token('string', text.slice(start, i)); continue;
    }
    identifier.lastIndex = i; const word = identifier.exec(text);
    if (word) { i = identifier.lastIndex; token('identifier', word[0]); continue; }
    if ('{[('.includes(char)) {
      delimiters.push(char); if (delimiters.length > 128) invalid();
    } else if ('}])'.includes(char)) {
      if (delimiters.pop() !== ({ '}': '{', ']': '[', ')': '(' })[char]) invalid();
    }
    if (!'=.,:?!+*/%<>|&-{}[]()0123456789'.includes(char)) invalid();
    token('symbol', char); i++;
  }
  if (delimiters.length) invalid();
  return tokens;
}
function hclText(tokens) { return tokens.map(token => token.value).join(' '); }
// Visit body items, not arbitrary identifiers inside expressions or block labels.
// Headers accept all HCL label spellings (quoted, bare, multiple or mixed).
// Attribute expressions stay opaque: balanced groups and real newline tokens
// delimit them. A newline inside a block comment is not an HCL newline token.
function checkStaticScope(tokens) {
  const unsupported = () => { throw new Error('unsupported-static-root'); };
  let index = 0;
  function body(nested = false) {
    while (index < tokens.length) {
      if (tokens[index].value === '}') {
        if (!nested) unsupported();
        index++; return;
      }
      const type = tokens[index++];
      if (type.kind !== 'identifier') unsupported();
      if (tokens[index]?.value === '=') {
        index++; let depth = 0; let seen = false;
        while (index < tokens.length) {
          const token = tokens[index];
          if (!depth && (token.value === '}' || (seen && token.newlineBefore))) break;
          if ('{[('.includes(token.value)) depth++;
          else if ('}])'.includes(token.value)) depth--;
          index++; seen = true;
        }
        if (!seen || depth) unsupported();
      } else {
        while (tokens[index]?.kind === 'identifier' || tokens[index]?.kind === 'string') index++;
        if (tokens[index]?.value !== '{' || ['module', 'provider', 'terraform'].includes(type.value)) unsupported();
        index++; body(true);
      }
    }
    if (nested) unsupported();
  }
  body();
}
function rootInput(root, entry) {
  const source = resolve(root, entry.path); plainDirectory(source);
  const names = readdirSync(source).filter(name => name.endsWith('.tf') || name.endsWith('.tf.json')).sort();
  if (!names.includes('versions.tf') || names.length > 32 || names.some(name => name.endsWith('.tf.json'))) throw new Error('unsupported-static-root');
  const files = names.map(name => { const path = join(source, name); regularFile(path, 1048576); return [name, readFileSync(path)]; });
  const testNames = readdirSync(source).filter(name => name.endsWith('.tftest.hcl')).sort();
  if (testNames.length > 32) throw new Error('too-many-format-test-files');
  const formatFiles = testNames.map(name => { const path = join(source, name); regularFile(path, 1048576); return [name, readFileSync(path)]; });
  const lexed = files.map(([name, bytes]) => [name, hclTokens(bytes)]);
  const versions = hclText(lexed.find(([name]) => name === 'versions.tf')[1]);
  const expected = /^\s*terraform\s*\{\s*required_version\s*=\s*"=\s*1\.17\.1"\s*required_providers\s*\{\s*cloudflare\s*=\s*\{\s*source\s*=\s*"cloudflare\/cloudflare"\s*version\s*=\s*"=\s*5\.28\.1"\s*\}\s*\}\s*\}\s*provider\s*"cloudflare"\s*\{\s*\}\s*$/;
  if (!expected.test(versions)) throw new Error('root-version-pin-mismatch');
  // Static trusted roots only: no module fetching or second provider contract.
  for (const [name, tokens] of lexed) if (name !== 'versions.tf') checkStaticScope(tokens);
  const lockPath = join(source, '.terraform.lock.hcl'); regularFile(lockPath, 65536);
  const lock = readFileSync(lockPath); const text = hclText(hclTokens(lock));
  const match = /^\s*provider\s+"registry\.terraform\.io\/cloudflare\/cloudflare"\s*\{\s*version\s*=\s*"5\.28\.1"\s*constraints\s*=\s*"(?:=\s*)?5\.28\.1"\s*hashes\s*=\s*\[([\s\S]*?)\]\s*\}\s*$/.exec(text);
  if (!match) throw new Error('lock-pin-mismatch');
  const hashes = [...match[1].matchAll(/"(h1:[A-Za-z0-9+/]{43}=|zh:[a-f0-9]{64})"/g)].map(value => value[1]);
  if (!hashes.length || !/^\s*"(?:h1:[A-Za-z0-9+/]{43}=|zh:[a-f0-9]{64})"(?:\s*,\s*"(?:h1:[A-Za-z0-9+/]{43}=|zh:[a-f0-9]{64})")*\s*,?\s*$/.test(match[1])) throw new Error('lock-hashes-invalid');
  return { ...entry, files, formatFiles, lock, hashes };
}

// This function is also the test seam: fake executables/packages exercise the same argv path.
export function runTerraformGates({ root, scratch, mirror, terraform = 'terraform', path = '/usr/bin:/bin', spawn = spawnSync }) {
  const results = []; let work;
  const evidence = mkdtempSync(join(scratch, 'terraform-logs-'));
  const pending = ['terraform-version', 'terraform-format', ...TERRAFORM_ROOTS.flatMap(entry => [`terraform-${entry.name}-init`, `terraform-${entry.name}`])];
  function blockRemaining(blocker) {
    for (const name of pending) if (!results.some(result => result.name === name)) results.push({ name, status: 'blocked', exitCode: null, blocker });
  }
  function run(name, args, cwd, extraEnv = {}, timeout = 120000) {
    if (stopped(root)) { const result = { name, status: 'stopped', exitCode: null, blocker: 'source-stop' }; results.push(result); return result; }
    const gateScratch = mkdtempSync(join(work, 'gate-')); const home = join(gateScratch, 'home'); mkdirSync(home, { mode: 0o700 });
    let run;
    try {
      run = spawn(terraform, args, { cwd, env: { ...cleanEnv(home, gateScratch, path), CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: 'true', TF_INPUT: '0', ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, shell: false });
    } catch { run = { status: null, error: { code: 'SPAWN_FAILED' } }; }
    finally { rmSync(gateScratch, { recursive: true, force: true }); }
    const evidencePath = join(evidence, `${name}.log`);
    writeFileSync(evidencePath, Buffer.from(`${run.stdout ?? ''}${run.stderr ?? ''}`).subarray(-65536), { mode: 0o600 });
    const blocker = run.error ? `tool-${run.error.code ?? 'error'}` : run.signal ? 'tool-signal' : run.status !== 0 ? 'tool-exit' : null;
    const result = { name, command: [terraform, ...args], status: run.error?.code === 'ENOENT' ? 'unexecuted' : blocker ? 'failed' : 'passed', exitCode: run.status, blocker, evidencePath };
    results.push(result); return { ...result, stdout: run.stdout };
  }
  try {
    let inputs; let packageDir; let packageNames;
    try {
      if (!mirror || !isAbsolute(mirror)) throw new Error('explicit-absolute-provider-mirror-required');
      if (terraform !== 'terraform' && !isAbsolute(terraform)) throw new Error('absolute-terraform-executable-required');
      if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('unsupported-provider-platform');
      packageDir = join(mirror, PROVIDER, PROVIDER_VERSION, `linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}`); plainDirectory(packageDir);
      packageNames = readdirSync(packageDir).sort(); let bytes = 0;
      if (!packageNames.length || packageNames.length > 64 || packageNames.some(name => !/^[A-Za-z0-9._-]+$/.test(name))) throw new Error('provider-package-files-invalid');
      for (const name of packageNames) bytes += regularFile(join(packageDir, name), MAX_PACKAGE_BYTES).size;
      if (bytes > MAX_PACKAGE_BYTES || packageNames.filter(name => /^terraform-provider-cloudflare_v5\.28\.1(?:_x[0-9]+)?$/.test(name)).length !== 1) throw new Error('provider-package-pin-mismatch');
      inputs = TERRAFORM_ROOTS.map(entry => {
        try { return rootInput(root, entry); }
        catch (error) { throw new Error(`${entry.path}: ${error.code === 'ENOENT' ? 'root-or-lock-missing' : error.message}`); }
      });
    } catch (error) {
      const blocker = error.code === 'ENOENT' ? 'provider-mirror-package-missing' : error.message;
      results.push({ name: 'terraform-preflight', status: 'failed', exitCode: null, blocker }); blockRemaining(blocker); return results;
    }
    work = mkdtempSync(join(scratch, 'terraform-work-')); chmodSync(work, 0o700);
    // Snapshot package-only regular files. No state, .terraform, tfvars or credentials are copied.
    const stagedMirror = join(work, 'mirror'); const stagedPackage = join(stagedMirror, PROVIDER, PROVIDER_VERSION, `linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}`);
    mkdirSync(stagedPackage, { recursive: true, mode: 0o700 });
    for (const name of packageNames) { copyFileSync(join(packageDir, name), join(stagedPackage, name)); chmodSync(join(stagedPackage, name), name.startsWith('terraform-provider-') ? 0o500 : 0o400); }
    // Terraform/go dirhash Hash1 for an unpacked, flat provider package.
    const listing = packageNames.map(name => `${hashFile(join(stagedPackage, name))}  ${name}\n`).join('');
    const packageHash = `h1:${createHash('sha256').update(listing).digest('base64')}`;
    const mismatched = inputs.filter(input => !input.hashes.includes(packageHash));
    if (mismatched.length) {
      const blocker = `provider-package-lock-hash-mismatch: ${mismatched.map(input => input.path).join(', ')}`;
      results.push({ name: 'terraform-preflight', status: 'failed', exitCode: null, blocker }); blockRemaining(blocker); return results;
    }
    const config = join(work, 'terraform.rc');
    writeFileSync(config, `disable_checkpoint = true\nprovider_installation {\n  filesystem_mirror {\n    path = ${hclString(stagedMirror)}\n    include = ["${PROVIDER}"]\n  }\n}\n`, { mode: 0o400 });
    const env = { TF_CLI_CONFIG_FILE: config };
    results.push({ name: 'terraform-preflight', status: 'passed', exitCode: 0, providerPackageHash: packageHash });
    const version = run('terraform-version', ['version', '-json'], work, env, 15000);
    let versionMatch = false;
    try { versionMatch = version.status === 'passed' && JSON.parse(version.stdout).terraform_version === TF_VERSION; } catch { /* malformed version is a non-pass */ }
    if (!versionMatch) {
      const record = results.find(result => result.name === 'terraform-version');
      if (record.status === 'passed') { record.status = 'failed'; record.blocker = 'terraform-version-pin-mismatch'; }
      record.versionMatch = false; blockRemaining(record.blocker); return results;
    }
    results.find(result => result.name === 'terraform-version').versionMatch = true;
    const staged = join(work, 'roots'); mkdirSync(staged);
    for (const input of inputs) {
      const directory = join(staged, input.name); mkdirSync(directory);
      for (const [name, bytes] of input.files) writeFileSync(join(directory, name), bytes, { mode: 0o400 });
      writeFileSync(join(directory, '.terraform.lock.hcl'), input.lock, { mode: 0o400 });
      // Preserve fmt coverage of static test HCL without putting it in init/validate roots.
      if (input.formatFiles.length) {
        const formatDirectory = join(staged, 'format-only-tests', input.name); mkdirSync(formatDirectory, { recursive: true });
        for (const [name, bytes] of input.formatFiles) writeFileSync(join(formatDirectory, name), bytes, { mode: 0o400 });
      }
    }
    run('terraform-format', [`-chdir=${staged}`, 'fmt', '-check', '-recursive'], work, env, 30000);
    for (const input of inputs) {
      const directory = join(staged, input.name); const rootEnv = { ...env, TF_DATA_DIR: join(directory, '.terraform') };
      const initName = `terraform-${input.name}-init`; const validateName = `terraform-${input.name}`;
      const init = run(initName, [`-chdir=${directory}`, 'init', '-backend=false', '-input=false', '-get=false', '-upgrade=false', '-lockfile=readonly', '-no-color'], work, rootEnv);
      if (init.status !== 'passed') { results.push({ name: validateName, status: 'blocked', exitCode: null, blocker: `${initName}: ${init.blocker}` }); continue; }
      if (!readFileSync(join(directory, '.terraform.lock.hcl')).equals(input.lock)) {
        Object.assign(results.find(result => result.name === initName), { status: 'failed', blocker: 'readonly-lock-changed' });
        results.push({ name: validateName, status: 'blocked', exitCode: null, blocker: 'readonly-lock-changed' }); continue;
      }
      const validation = run(validateName, [`-chdir=${directory}`, 'validate', '-no-color'], work, rootEnv);
      if (!readFileSync(join(directory, '.terraform.lock.hcl')).equals(input.lock)) Object.assign(results.find(result => result.name === validation.name), { status: 'failed', blocker: 'readonly-lock-changed' });
    }
    return results;
  } catch (error) {
    const blocker = `terraform-bootstrap-error: ${error.code ?? 'invalid-local-input'}`;
    results.push({ name: 'terraform-bootstrap', status: 'failed', exitCode: null, blocker }); blockRemaining(blocker); return results;
  } finally { if (work) rmSync(work, { recursive: true, force: true }); }
}

export function runOfflineGates({ root = process.cwd(), toolsOnly = false, callerEnv = process.env } = {}) {
  if (!callerEnv.KIROCREW_SCRATCH) throw new Error('KIROCREW_SCRATCH is required');
  const node = process.execPath;
  const acceptance = readdirSync(resolve(root, 'tests')).filter(name => name.startsWith('t38-at11-14-') || name.startsWith('t39-at15-capability-')).filter(name => name.endsWith('.test.ts')).map(name => `tests/${name}`);
  if (acceptance.length < 6) throw new Error('Required acceptance suites are missing');
  const expectedWrangler = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).devDependencies.wrangler;
  const gates = [
    ['node', node, ['scripts/check-node.mjs']],
    ['frozen-install', 'pnpm', ['install', '--offline', '--frozen-lockfile']],
    ['types', node, ['node_modules/typescript/bin/tsc', '--noEmit']],
    ['worker-types', node, ['node_modules/typescript/bin/tsc', '-p', 'apps/storefront-worker/tsconfig.json', '--noEmit']],
    ['unit-integration', node, ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1']],
    ['node-build', node, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json']],
    ['ui-build', node, ['node_modules/vite/bin/vite.js', 'build', 'apps/command-center']],
    ['loopback-browser', node, ['node_modules/@playwright/test/cli.js', 'test', '--workers=1']],
    ['acceptance', node, ['node_modules/vitest/vitest.mjs', 'run', ...acceptance, '--maxWorkers=1']],
    ['golden-path', node, ['scripts/golden-path.mjs']],
    ['terraform', null, []],
    ['wrangler-version', node, ['node_modules/wrangler/bin/wrangler.js', '--version']],
    ['wrangler-contracts', node, ['node_modules/vitest/vitest.mjs', 'run', 'tests/core-infra-plan.test.ts', 'tests/deployment-tools.test.ts', 'tests/workshop-deployment.test.ts', '--maxWorkers=1']],
  ];
  const selected = toolsOnly ? gates.filter(([name]) => name === 'terraform' || name === 'wrangler-version') : gates;
  const results = [];
  for (const [name, executable, args] of selected) {
    if (stopped(root)) { results.push({ name, status: 'stopped', exitCode: null }); break; }
    if (name === 'terraform') {
      results.push(...runTerraformGates({ root, scratch: callerEnv.KIROCREW_SCRATCH, mirror: callerEnv.OFFLINE_TF_PROVIDER_MIRROR, terraform: callerEnv.OFFLINE_TERRAFORM_BIN ?? 'terraform', path: callerEnv.PATH })); continue;
    }
    const scratch = mkdtempSync(join(callerEnv.KIROCREW_SCRATCH, 'g-'));
    const home = join(scratch, 'home'); mkdirSync(home, { mode: 0o700 });
    const env = cleanEnv(home, scratch, callerEnv.PATH);
    // An installed browser cache is allowed; credentials and provider tokens are not.
    for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']) if (callerEnv[key]) env[key] = callerEnv[key];
    if (callerEnv.PNPM_STORE_DIR) env.npm_config_store_dir = callerEnv.PNPM_STORE_DIR;
    const evidenceDirectory = mkdtempSync(join(callerEnv.KIROCREW_SCRATCH, 'gate-logs-')); const evidencePath = join(evidenceDirectory, 'gate.log');
    let run;
    try { run = spawnSync(executable, args, { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, shell: false }); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
    writeFileSync(evidencePath, Buffer.from(`${run.stdout ?? ''}${run.stderr ?? ''}`).subarray(-65536), { mode: 0o600 });
    const missing = run.error?.code === 'ENOENT';
    const versionMatch = name === 'wrangler-version' && run.status === 0 ? run.stdout?.trim() === expectedWrangler : null;
    results.push({ name, command: [executable, ...args], status: missing ? 'unexecuted' : !run.error && !run.signal && run.status === 0 && versionMatch !== false ? 'passed' : 'failed', exitCode: run.status, versionMatch, evidencePath });
  }
  return { schemaVersion: 1, mode: 'offline', liveQualification: 'not_run', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const toolsOnly = process.argv.length === 3 && process.argv[2] === '--tools';
  if (process.argv.length > 2 && !toolsOnly) throw new Error('Usage: node scripts/offline-gates.mjs [--tools]');
  const report = runOfflineGates({ toolsOnly }); console.log(JSON.stringify(report));
  process.exitCode = report.results.every(result => result.status === 'passed') ? 0 : 1;
}
