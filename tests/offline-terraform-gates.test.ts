import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Dynamic file URL: production is plain Node ESM, not a second TS implementation.
const runnerUrl = pathToFileURL(resolve('scripts/offline-gates.mjs')).href;
const { runTerraformGates, TERRAFORM_ROOTS } = await import(runnerUrl);
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Result = { name: string; status: string; blocker?: string; evidencePath?: string; versionMatch?: boolean };
type Call = { args: string[]; env: Record<string, string>; cwd: string; config: string; files: string[]; home: string; data?: string };
const trusted = ['infra/terraform', 'infra/terraform/core-public', 'infra/terraform/routing'];
function fixture(mode = '', hostile = false) {
  const scratch = process.env.KIROCREW_SCRATCH; if (!scratch) throw new Error('KIROCREW_SCRATCH required');
  const root = mkdtempSync(join(scratch, 'offline-tf-')); roots.push(root);
  const base = join(root, hostile ? 'space ; $(touch NO_SHELL) ${literal} %{literal} "quote"' : 'fixture'); mkdirSync(base);
  const project = join(base, 'project'); const work = join(base, 'scratch'); mkdirSync(project); mkdirSync(work);
  const mirror = join(base, 'approved mirror');
  const packageDir = join(mirror, 'registry.terraform.io/cloudflare/cloudflare/5.28.1', `linux_${process.arch === 'x64' ? 'amd64' : 'arm64'}`); mkdirSync(packageDir, { recursive: true });
  const providerName = 'terraform-provider-cloudflare_v5.28.1'; const provider = join(packageDir, providerName);
  const bytes = 'synthetic-provider-only-not-executed'; writeFileSync(provider, bytes); chmodSync(provider, 0o700);
  const listing = `${createHash('sha256').update(bytes).digest('hex')}  ${providerName}\n`;
  const hash = `h1:${createHash('sha256').update(listing).digest('base64')}`;
  const lock = `provider "registry.terraform.io/cloudflare/cloudflare" {\n  version = "5.28.1"\n  constraints = "5.28.1"\n  hashes = ["${hash}",]\n}\n`;
  for (const source of trusted) {
    const directory = join(project, source); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'versions.tf'), readFileSync('infra/terraform/versions.tf'));
    writeFileSync(join(directory, 'main.tf'), 'variable "fixture" { type = string }\n');
    writeFileSync(join(directory, '.terraform.lock.hcl'), lock);
    // These are synthetic traps, never real project state or credentials.
    writeFileSync(join(directory, 'terraform.tfstate'), 'DO_NOT_COPY_SYNTHETIC_STATE');
    writeFileSync(join(directory, 'secret.auto.tfvars'), 'DO_NOT_COPY_SYNTHETIC_VARIABLES');
    writeFileSync(join(directory, 'core.tftest.hcl'), 'DO_NOT_RUN_TESTS');
  }
  const executable = join(base, 'fake terraform ; literal'); const record = join(base, 'calls.jsonl');
  writeFileSync(executable, `#!${process.execPath}
import {appendFileSync,readFileSync,readdirSync,mkdirSync,writeFileSync,existsSync,chmodSync} from 'node:fs';
import {basename,join} from 'node:path';
const args=process.argv.slice(2), cwd=args[0]?.startsWith('-chdir=')?args[0].slice(7):process.cwd();
const cmd=args[0]?.startsWith('-chdir=')?args[1]:args[0];
const mode=${JSON.stringify(mode)}, name=basename(cwd);
appendFileSync(${JSON.stringify(record)},JSON.stringify({args,cwd,env:process.env,home:process.env.HOME,data:process.env.TF_DATA_DIR,config:readFileSync(process.env.TF_CLI_CONFIG_FILE,'utf8'),files:readdirSync(cwd)})+'\\n');
if(cmd==='version'){console.log(mode==='bad-json'?'not-json':JSON.stringify({terraform_version:mode==='version'?'1.16.0':'1.17.1'}));process.exit(0)}
if(cmd==='init'){
 if(mode==='init'&&name==='core-public')process.exit(7);
 if(mode==='output'&&name==='core')console.log('x'.repeat(262144));
 if(mode==='unicode-output'&&name==='core')console.log('😀'.repeat(65536));
 mkdirSync(process.env.TF_DATA_DIR,{recursive:true});writeFileSync(join(process.env.TF_DATA_DIR,'initialized'),'synthetic');
 if(mode==='lock'&&name==='core'){const p=join(cwd,'.terraform.lock.hcl');chmodSync(p,0o600);writeFileSync(p,readFileSync(p,'utf8')+'# mutated\\n')}
}
if(cmd==='validate'){
 if(!existsSync(join(process.env.TF_DATA_DIR,'initialized')))process.exit(8);
 if(mode==='validate'&&name==='routing')process.exit(9);
 if(mode==='validate-lock'&&name==='core'){const p=join(cwd,'.terraform.lock.hcl');chmodSync(p,0o600);writeFileSync(p,readFileSync(p,'utf8')+'# mutated\\n')}
}
console.log('fixture-only '+cmd);
`); chmodSync(executable, 0o700);
  // Node ESM syntax in an extensionless executable is unambiguous in current Node.
  const run = (overrides: Record<string, unknown> = {}): Result[] => runTerraformGates({ root: project, scratch: work, mirror, terraform: executable, path: '/usr/bin:/bin', ...overrides });
  const calls = (): Call[] => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Call) : [];
  return { root, base, project, work, mirror, packageDir, provider, record, executable, run, calls };
}
function assertNoInvoke(f: ReturnType<typeof fixture>, result: Result[], blocker: string) {
  expect(f.calls()).toEqual([]);
  expect(result.find(row => row.name === 'terraform-preflight')).toMatchObject({ status: 'failed', blocker: expect.stringContaining(blocker) });
  for (const name of ['core', 'core-public', 'routing']) for (const gate of [`terraform-${name}-init`, `terraform-${name}`]) expect(result.find(row => row.name === gate)).toMatchObject({ status: 'blocked' });
  expect(readdirSync(f.work).every(name => name.startsWith('terraform-logs-') || name.startsWith('gate-logs-'))).toBe(true);
}
// Lexical probes use the production preflight and a counted, nonexecuting tool seam.
// A refusal must happen before even `version`; no invalid-HCL fake success is proof.
function lexicalProbe(f: ReturnType<typeof fixture>, blocker?: string) {
  const spawn = vi.fn((_executable: string, args: string[]) => ({ status: 0, stdout: args.includes('version') ? '{"terraform_version":"1.17.1"}' : '', stderr: '' }));
  const results = f.run({ spawn });
  if (blocker) { assertNoInvoke(f, results, blocker); expect(spawn).not.toHaveBeenCalled(); }
  else { expect(results).toHaveLength(9); expect(results.every(row => row.status === 'passed')).toBe(true); expect(spawn).toHaveBeenCalledTimes(8); }
  return results;
}
const forbiddenBlocks = [
  ['provider', 'provider "cloudflare" { alias = "unreviewed" }'],
  ['module', 'module "remote" { source = "unapproved/module/test" }'],
  ['terraform', 'terraform { backend "local" {} }'],
] as const;
describe('offline HCL lexical scope', () => {
  it.each(forbiddenBlocks)('rejects quoted-marker-hidden %s before every tool', (_kind, block) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[1]!, 'main.tf'), `\nlocals { opener = "/*" }\n${block}\nlocals { closer = "*/" }\n`);
    lexicalProbe(f, 'unsupported-static-root');
  });
  it.each(forbiddenBlocks)('rejects comment-separated %s tokens and CRLF before every tool', (_kind, block) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), '\r\n' + block.replace(' ', ' /* real comment */\r\n') + '\r\n');
    lexicalProbe(f, 'unsupported-static-root');
  });
  it.each(['#', '//', '/*', '*/', '\\" /*', '\\\\', 'https://host/#path', 'module \\"remote\\" {}'])('keeps harmless quoted %s from hiding a following block', marker => {
    const f = fixture(); appendFileSync(join(f.project, trusted[2]!, 'main.tf'), `\nlocals { text = ${JSON.stringify(marker)} }\nprovider "cloudflare" { alias = "unreviewed" }\n`);
    lexicalProbe(f, 'unsupported-static-root');
  });
  it.each([
    ['ordinary strings', String.raw`locals { text = "# // /* */ provider \"cloudflare\" {} module \"x\" {} terraform {}" }`],
    ['escapes', String.raw`locals { text = "quote: \" slash: \\ tab: \t cr: \r lf: \n unicode: \u0023 \U0001F600" }`],
    ['quoted markers', 'locals { opener = "/*" }\nlocals { closer = "*/" }'],
    ['line comments', '# provider "bad" {\r\n// module "bad" {\r\nlocals { text = "https://host/#path" }'],
    ['block comments', '/* provider "bad" { module "bad" { terraform { */\nlocals { text = "*/" }'],
    ['token boundaries', 'locals/* comment */{/* comment */text/* comment */=/* comment */"/*"/* comment */}'],
    ['simple templates', 'locals { text = "${var.lab_id}-${each.key}-${role}" }'],
    ['escaped template markers', 'locals { text = "$${provider \\"x\\" {}} %%{if false} <<EOF" }'],
    ['quoted heredoc marker', 'locals { text = "<<-EOF" }'],
  ])('allows %s without treating string or comment contents as code', (_label, hcl) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\n${hcl}\n`); lexicalProbe(f);
  });
  it.each([
    ['unclosed quote', 'locals { text = "/*'],
    ['trailing escape', 'locals { text = "slash: \\'],
    ['unclosed block comment', '/* provider "cloudflare" {}'],
    ['stray block closer', '*/\nlocals {}'],
    ['nested block comment', '/* outer /* nested */ */'],
    ['multiline quoted string', 'locals { text = "first\nsecond" }'],
    ['invalid escape', String.raw`locals { text = "\q" }`],
    ['short unicode escape', String.raw`locals { text = "\u123" }`],
    ['invalid unicode point', String.raw`locals { text = "\U00110000" }`],
    ['unclosed brace', 'locals { text = "safe"'],
    ['unclosed bracket', 'locals { text = ["safe" }'],
    ['unclosed parenthesis', 'locals { text = toset(["safe"])'],
    ['mismatched delimiters', 'locals { text = (] }'],
    ['control byte', 'locals { text = "safe\u0000" }'],
    ['bare quote escape', String.raw`locals { text = \"safe\" }`],
    ['excessive nesting', 'locals { text = ' + '['.repeat(129) + '0' + ']'.repeat(129) + ' }'],
  ])('refuses ambiguous %s before every tool', (_label, hcl) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\n${hcl}`); lexicalProbe(f, 'invalid-hcl-lexeme');
  });
  it.each([
    ['plain heredoc', 'locals { text = <<EOF\n/*\nEOF\n}\nprovider "cloudflare" {}'],
    ['indented heredoc', 'locals { text = <<-EOF\n  */\n  EOF\n}\nmodule "x" {}'],
    ['unclosed heredoc', 'locals { text = <<EOF\n/*'],
    ['directive', 'locals { text = "%{if true}/*%{endif}" }'],
    ['nested template string', 'locals { text = "${format("/*")}" }\nprovider "cloudflare" {}'],
    ['template object', 'locals { text = "${{ x = "/*" }}" }'],
    ['unclosed template', 'locals { text = "${var.lab_id" }'],
    ['template marker newline', 'locals { text = "${\nvar.lab_id}" }'],
  ])('fails closed on unsupported %s before every tool', (_label, hcl) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\n${hcl}`); lexicalProbe(f, 'unsupported-hcl-');
  });
  it.each(forbiddenBlocks)('rejects %s beside a supported template and escaped quote', (_kind, block) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[2]!, 'main.tf'), `\nlocals { text = "${'${var.lab_id}'} \\" /*" }\n${block}\nlocals { text2 = "*/" }`);
    lexicalProbe(f, 'unsupported-static-root');
  });
  it.each(trusted)('allows copied trusted static source for %s through all three roots', source => {
    const f = fixture();
    for (const name of readdirSync(source).filter(name => name.endsWith('.tf'))) writeFileSync(join(f.project, source, name), readFileSync(join(source, name)));
    lexicalProbe(f);
  });
  it('keeps real comments separate from exact version and lock tokens', () => {
    const f = fixture(); const root = join(f.project, trusted[0]!);
    for (const name of ['versions.tf', '.terraform.lock.hcl']) {
      const input = readFileSync(join(root, name), 'utf8');
      writeFileSync(join(root, name), '# before\r\n' + input.replace(/\{/g, '/* start */ { /* end */').replace(/\n/g, '\r\n') + '\r\n// after');
    }
    lexicalProbe(f);
  });
  it('preserves comment characters inside a valid alternate lock hash', () => {
    const f = fixture(); const lock = join(f.project, trusted[0]!, '.terraform.lock.hcl');
    const alternate = 'h1:' + '//'.repeat(21) + 'A=';
    writeFileSync(lock, readFileSync(lock, 'utf8').replace('hashes = [', `hashes = ["${alternate}",`));
    lexicalProbe(f);
  });
  it.each(['versions.tf', '.terraform.lock.hcl'])('rejects hidden extra provider in %s rather than stripping quoted markers', name => {
    const f = fixture(); const path = join(f.project, trusted[0]!, name);
    appendFileSync(path, '\nlocals { opener = "/*" }\nprovider "cloudflare" { alias = "unreviewed" }\nlocals { closer = "*/" }');
    lexicalProbe(f, name === 'versions.tf' ? 'root-version-pin-mismatch' : 'lock-pin-mismatch');
  });
  it.each(['versions.tf', '.terraform.lock.hcl'])('rejects unclosed comments in %s', name => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, name), '\n/*'); lexicalProbe(f, 'invalid-hcl-lexeme');
  });
  it.each(['#', '//', '/* */'])('does not erase %s inside a version string', marker => {
    const f = fixture(); const path = join(f.project, trusted[0]!, 'versions.tf');
    writeFileSync(path, readFileSync(path, 'utf8').replace('= 1.17.1', `= 1.17.1${marker}`)); lexicalProbe(f, 'root-version-pin-mismatch');
  });
  it.each([
    ['versions.tf', '= 1.17.1', '= 1.17./* marker */1', 'root-version-pin-mismatch'],
    ['versions.tf', 'cloudflare/cloudflare', 'cloudflare/cloud/* marker */flare', 'root-version-pin-mismatch'],
    ['versions.tf', '= 5.28.1', '= 5.28./* marker */1', 'root-version-pin-mismatch'],
    ['.terraform.lock.hcl', 'cloudflare/cloudflare', 'cloudflare/cloud/* marker */flare', 'lock-pin-mismatch'],
    ['.terraform.lock.hcl', 'version = "5.28.1"', 'version = "5.28./* marker */1"', 'lock-pin-mismatch'],
    ['.terraform.lock.hcl', 'constraints = "5.28.1"', 'constraints = "5.28./* marker */1"', 'lock-pin-mismatch'],
    ['.terraform.lock.hcl', 'h1:', 'h1:/* marker */', 'lock-hashes-invalid'],
  ])('does not normalize quoted comment text in %s (%s)', (name, original, changed, blocker) => {
    const f = fixture(); const path = join(f.project, trusted[0]!, name);
    const input = readFileSync(path, 'utf8'); expect(input).toContain(original);
    writeFileSync(path, input.replace(original, changed)); lexicalProbe(f, blocker);
  });
  it.each(['leading-comma', 'double-comma', 'missing-comma', 'empty'])('rejects ambiguous lock hash list: %s', kind => {
    const f = fixture(); const path = join(f.project, trusted[0]!, '.terraform.lock.hcl');
    const input = readFileSync(path, 'utf8'); const hash = /"(h1:[^"]+)"/.exec(input)![0];
    const list = kind === 'leading-comma' ? `,${hash},` : kind === 'double-comma' ? `${hash},,` : kind === 'missing-comma' ? `${hash} ${hash}` : '';
    writeFileSync(path, input.replace(/hashes = \[[^\]]*\]/, `hashes = [${list}]`)); lexicalProbe(f, 'lock-hashes-invalid');
  });
  it('rejects invalid UTF-8 rather than scanning replacement characters', () => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), Buffer.from([0xff])); lexicalProbe(f, 'invalid-hcl-lexeme');
  });
});
describe('offline HCL block headers', () => {
  // Persistent copies of the independent review's two RED assertions.
  it.each([
    ['provider', 'provider cloudflare { alias = "unreviewed" }'],
    ['module', 'module remote { source = "unapproved/module/test" }'],
  ])('refuses original marker-wrapped bare %s before every tool', (_kind, block) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[1]!, 'main.tf'), `\nlocals { opener = "/*" }\n${block}\nlocals { closer = "*/" }\n`);
    lexicalProbe(f, 'unsupported-static-root');
  });
  const headers = [
    ['provider', 'cloudflare'], ['module', 'remote'], ['terraform', 'extra'],
  ] as const;
  it.each(headers.flatMap(([kind, label]) => [
    [`${kind}: bare`, `${kind} ${label} {}`],
    [`${kind}: quoted`, `${kind} "${label}" {}`],
    [`${kind}: no labels`, `${kind} {}`],
    [`${kind}: multiple bare labels`, `${kind} ${label} extra {}`],
    [`${kind}: mixed labels`, `${kind} ${label} "extra" {}`],
    [`${kind}: reverse mixed labels`, `${kind} "${label}" extra {}`],
    [`${kind}: comment-separated CRLF`, `${kind}/* label */\r\n${label}// body\r\n{}`],
    [`${kind}: adjacent block comment`, `${kind}/* label */${label}/* body */{}`],
    [`${kind}: hyphenated bare label`, `${kind} ${label}-extra {}`],
  ]))('refuses complete header %s before every tool', (_label, block) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[2]!, 'main.tf'), `\n${block}\n`); lexicalProbe(f, 'unsupported-static-root');
  });
  it.each(headers)('refuses nested bare %s blocks, not just root headers', (kind, label) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\nresource "synthetic" "probe" {\n${kind} ${label} {}\n}\n`);
    lexicalProbe(f, 'unsupported-static-root');
  });
  it.each(trusted)('refuses a bare provider in %s before version', source => {
    const f = fixture(); appendFileSync(join(f.project, source, 'main.tf'), '\nprovider cloudflare { alias = "unreviewed" }\n'); lexicalProbe(f, 'unsupported-static-root');
  });
  it.each([
    ['attributes', 'locals {\nprovider = "safe"\nmodule = 1\nterraform = true\n}'],
    ['attribute objects', 'locals {\nprovider = {}\nmodule = { provider = 1, module = 2, terraform = 3 }\nterraform = { provider: 1, module: 2, terraform: 3 }\n}'],
    ['traversals before sibling blocks', 'output "scope" {\nvalue = local.provider\nprecondition {\ncondition = true\nerror_message = "safe"\n}\n}'],
    ['traversal before bare sibling block', 'output "scope" {\nvalue = local.module\nprecondition { condition = true }\n}'],
    ['bare expression before sibling block', 'output "scope" {\nvalue = provider\nprecondition { condition = true }\n}'],
    ['keyword traversals', 'locals {\nx = module.remote.provider\ny = local.terraform\nz = var.module\n}'],
    ['comprehensions', 'locals {\nx = { for provider in { a = 1 } : provider => provider }\ny = [for module in [{ terraform = 1 }] : module.terraform]\nz = { for terraform, module in { a = 1 } : terraform => module }\n}'],
    ['multiline expressions', 'locals {\nprovider = (\ntrue ? { module = 1 } : { terraform = 2 }\n)\nmodule = [\n{ provider = 1 },\n{ terraform = 2 }\n]\n}'],
    ['functions and indexes', 'locals {\nx = lookup({ provider = "safe" }, "provider", "")\ny = { module = 1 }["module"]\n}'],
    ['bare unrelated labels', 'variable module { type = string }\nvariable provider { type = string }\nvariable terraform { type = string }'],
    ['quoted unrelated labels', 'variable "module" { type = string }\noutput "provider" { value = "safe" }'],
    ['mixed unrelated labels', 'resource synthetic "module" {}\nresource "synthetic" provider {}'],
    ['literal header text', String.raw`locals { text = "provider cloudflare {} module remote {} terraform {} /* */ \"" }`],
    ['comments and CRLF', '// provider cloudflare {}\r\n/* module remote {} */\r\n# terraform {}\r\nlocals { text = "safe" }'],
    ['multiline comment within expression', 'locals {\nx = local.provider /* keep expression\nacross comment */.alias\n}'],
    ['for-named traversal before forbidden-named attribute', 'locals {\nx = local.for\nprovider = "safe"\nmodule = "safe"\n}'],
  ])('keeps safe %s usable without confusing expressions or labels with blocks', (_label, hcl) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\n${hcl}\n`); lexicalProbe(f);
  });
  it.each([
    ['unfinished bare header', 'provider cloudflare'],
    ['unfinished quoted header', 'module "remote"'],
    ['nonlabel header expression', 'provider (cloudflare) {}'],
    ['numeric label', 'module 123 {}'],
    ['quoted block type', '"provider" "cloudflare" {}'],
    ['assignment without expression', 'locals {\nprovider =\n}'],
  ])('fails closed on structurally unsupported %s', (_label, hcl) => {
    const f = fixture(); appendFileSync(join(f.project, trusted[0]!, 'main.tf'), `\n${hcl}\n`); lexicalProbe(f, 'unsupported-static-root');
  });
});
describe('offline Terraform bootstrap', () => {
  it('initializes every trusted clean root from an explicit package, then validates and cleans owned work', () => {
    const f = fixture();
    expect(TERRAFORM_ROOTS.map((row: { path: string }) => row.path)).toEqual(trusted);
    for (const source of trusted) expect(existsSync(join(f.project, source, '.terraform'))).toBe(false);
    const results = f.run(); expect(results).toHaveLength(9); expect(results.every(row => row.status === 'passed')).toBe(true);
    const calls = f.calls(); expect(calls).toHaveLength(8);
    expect(calls.find(call => call.args.includes('fmt'))?.files).toContain('format-only-tests');
    expect(calls.map(call => call.args.find(arg => ['version', 'fmt', 'init', 'validate'].includes(arg)))).toEqual(['version', 'fmt', 'init', 'validate', 'init', 'validate', 'init', 'validate']);
    expect(new Set(calls.map(call => call.home)).size).toBe(8);
    for (const call of calls) {
      expect(existsSync(call.home)).toBe(false); expect(existsSync(call.cwd)).toBe(false);
      expect(call.config).toContain('filesystem_mirror'); expect(call.config).toContain('registry.terraform.io/cloudflare/cloudflare');
      expect(call.config).not.toMatch(/direct\s*\{|network_mirror\s*\{|plugin_cache_dir/);
      expect(call.args).not.toContain('plan'); expect(call.args).not.toContain('apply'); expect(call.args).not.toContain('providers');
      if (call.args.includes('init')) {
        expect(call.args.slice(2)).toEqual(['-backend=false', '-input=false', '-get=false', '-upgrade=false', '-lockfile=readonly', '-no-color']);
        expect(call.files).toEqual(['.terraform.lock.hcl', 'main.tf', 'versions.tf']);
        expect(call.data).toBe(join(call.cwd, '.terraform'));
      }
    }
    for (const result of results.filter(row => row.evidencePath)) expect(existsSync(result.evidencePath!)).toBe(true);
    expect(readdirSync(f.work).every(name => name.startsWith('terraform-logs-'))).toBe(true);
    expect(readFileSync(f.provider, 'utf8')).toBe('synthetic-provider-only-not-executed');
    for (const source of trusted) expect(existsSync(join(f.project, source, '.terraform'))).toBe(false);
  });
  it.each([undefined, '', 'relative/mirror'])('rejects absent/nonabsolute approved mirror %s before invoking tools', mirror => {
    const f = fixture(); assertNoInvoke(f, f.run({ mirror }), 'explicit-absolute-provider-mirror-required');
  });
  it('rejects missing provider package before invoking any tool', () => {
    const f = fixture(); rmSync(f.provider); assertNoInvoke(f, f.run(), 'provider-package-files-invalid');
  });
  it('rejects provider version mismatch before invoking any tool', () => {
    const f = fixture(); rmSync(f.provider); writeFileSync(join(f.packageDir, 'terraform-provider-cloudflare_v5.28.0'), 'wrong');
    assertNoInvoke(f, f.run(), 'provider-package-pin-mismatch');
  });
  it.each(trusted)('refuses missing readonly lock for %s before tool invocation', source => {
    const f = fixture(); rmSync(join(f.project, source, '.terraform.lock.hcl')); assertNoInvoke(f, f.run(), `${source}: root-or-lock-missing`);
  });
  it.each(['root-version', 'lock-version', 'hash', 'second-provider', 'remote-module', 'json-config'])('refuses %s before invoking tools', kind => {
    const f = fixture(); const root = join(f.project, trusted[1]!);
    if (kind === 'root-version') writeFileSync(join(root, 'versions.tf'), readFileSync(join(root, 'versions.tf'), 'utf8').replace('1.17.1', '1.17.0'));
    if (kind === 'lock-version') writeFileSync(join(root, '.terraform.lock.hcl'), readFileSync(join(root, '.terraform.lock.hcl'), 'utf8').replaceAll('5.28.1', '5.28.0'));
    if (kind === 'hash') appendFileSync(f.provider, 'tampered');
    if (kind === 'second-provider') appendFileSync(join(root, '.terraform.lock.hcl'), '\nprovider "registry.terraform.io/unapproved/provider" {}');
    if (kind === 'remote-module') appendFileSync(join(root, 'main.tf'), '\nmodule "network" { source = "unapproved/module/test" }');
    if (kind === 'json-config') writeFileSync(join(root, 'extra.tf.json'), '{}');
    const blocker = kind === 'root-version' ? 'root-version-pin-mismatch' : ['lock-version', 'second-provider'].includes(kind) ? 'lock-pin-mismatch' : kind === 'hash' ? 'provider-package-lock-hash-mismatch' : 'unsupported-static-root';
    assertNoInvoke(f, f.run(), blocker);
  });
  it.each(['version', 'bad-json'])('blocks init and validate after an actual %s tool mismatch', mode => {
    const f = fixture(mode); const results = f.run(); expect(f.calls()).toHaveLength(1);
    expect(results.find(row => row.name === 'terraform-version')).toMatchObject({ status: 'failed', versionMatch: false, blocker: 'terraform-version-pin-mismatch' });
    expect(results.filter(row => row.name.endsWith('-init')).every(row => row.status === 'blocked')).toBe(true);
  });
  it('keeps a missing Terraform tool nonpassing and names every blocked root', () => {
    const f = fixture(); const results = f.run({ terraform: join(f.base, 'missing-tool') });
    expect(results.find(row => row.name === 'terraform-version')).toMatchObject({ status: 'unexecuted', blocker: 'tool-ENOENT' });
    expect(results.filter(row => row.name.endsWith('-init')).every(row => row.status === 'blocked')).toBe(true); expect(f.calls()).toHaveLength(0);
  });
  it.each(['init', 'lock', 'output', 'unicode-output'])('blocks validate after %s failure but still checks unrelated roots', mode => {
    const f = fixture(mode); const results = f.run(); const name = mode === 'init' ? 'core-public' : 'core';
    expect(results.find(row => row.name === `terraform-${name}-init`)?.status).toBe('failed');
    expect(results.find(row => row.name === `terraform-${name}`)?.status).toBe('blocked');
    expect(f.calls().filter(call => call.args.includes('validate')).map(call => call.cwd.split('/').pop())).not.toContain(name);
    expect(results.find(row => row.name === 'terraform-routing')?.status).toBe('passed');
    if (mode === 'lock') expect(results.find(row => row.name === 'terraform-core-init')?.blocker).toBe('readonly-lock-changed');
    if (mode.endsWith('output')) for (const result of results.filter(row => row.evidencePath)) expect(readFileSync(result.evidencePath!).length).toBeLessThanOrEqual(65536);
  });
  it('does not turn a validate failure into a pass', () => {
    const f = fixture('validate'); expect(f.run().find(row => row.name === 'terraform-routing')?.status).toBe('failed');
  });
  it('checks readonly lock bytes after validate too', () => {
    const f = fixture('validate-lock'); const results = f.run();
    expect(results.find(row => row.name === 'terraform-core')).toMatchObject({ status: 'failed', blocker: 'readonly-lock-changed' });
    expect(results.find(row => row.name === 'terraform-routing')?.status).toBe('passed');
  });
  it.each([true, false])('uses explicit bootstrap inputs through the real tools CLI (mirror supplied: %s)', supplied => {
    const f = fixture(); mkdirSync(join(f.project, 'tests'));
    for (let index = 0; index < 6; index++) writeFileSync(join(f.project, 'tests', `t38-at11-14-${index}.test.ts`), '');
    writeFileSync(join(f.project, 'package.json'), JSON.stringify({ devDependencies: { wrangler: '4.157.0' } }));
    const bin = join(f.project, 'node_modules/wrangler/bin'); mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, 'wrangler.js'), 'console.log("4.157.0")');
    const run = spawnSync(process.execPath, [resolve('scripts/offline-gates.mjs'), '--tools'], { cwd: f.project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: f.base, KIROCREW_SCRATCH: f.work, OFFLINE_TF_PROVIDER_MIRROR: supplied ? f.mirror : '', OFFLINE_TERRAFORM_BIN: f.executable, CLOUDFLARE_API_TOKEN: 'synthetic-private-canary' }, timeout: 10000 });
    const report = JSON.parse(run.stdout) as { liveQualification: string; results: Result[] };
    expect(run.status).toBe(supplied ? 0 : 1); expect(report.liveQualification).toBe('not_run');
    expect(report.results).toHaveLength(10);
    expect(report.results.find(row => row.name === 'wrangler-version')?.status).toBe('passed');
    expect(report.results.some(row => row.name === 'frozen-install')).toBe(false);
    if (supplied) { expect(report.results.every(row => row.status === 'passed')).toBe(true); expect(f.calls()).toHaveLength(8); expect(JSON.stringify(f.calls())).not.toContain('synthetic-private-canary'); }
    else assertNoInvoke(f, report.results, 'explicit-absolute-provider-mirror-required');
  });
  it('passes hostile paths as argv and escapes HCL interpolation without a shell', () => {
    const f = fixture('', true); const result = f.run(); expect(result.every(row => row.status === 'passed')).toBe(true);
    expect(existsSync(join(f.base, 'NO_SHELL'))).toBe(false);
    const init = f.calls().find(call => call.args.includes('init'))!;
    expect(init.args[0]).toContain('$(touch NO_SHELL)'); expect(init.config).toContain('$${literal}'); expect(init.config).toContain('%%{literal}'); expect(init.config).toContain('\\"quote\\"');
  });
  it('never forwards auth, network, CLI overrides or caller HOME to Terraform', () => {
    const f = fixture();
    for (const key of ['CLOUDFLARE_API_TOKEN', 'TF_TOKEN_registry_terraform_io', 'AWS_ACCESS_KEY_ID', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'TF_CLI_ARGS', 'TF_CLI_ARGS_init', 'TF_PLUGIN_CACHE_DIR', 'TF_CLI_CONFIG_FILE', 'NODE_OPTIONS', 'HOME']) vi.stubEnv(key, 'synthetic-private-canary');
    expect(f.run().every(row => row.status === 'passed')).toBe(true);
    for (const call of f.calls()) {
      expect(JSON.stringify(call)).not.toContain('synthetic-private-canary');
      expect(Object.keys(call.env).sort()).toEqual(['CHECKPOINT_DISABLE', 'CI', 'COREPACK_ENABLE_NETWORK', 'HOME', 'KIROCREW_SCRATCH', 'LAB_TEST_SCRATCH', 'NO_COLOR', 'PATH', 'TF_CLI_CONFIG_FILE', ...(call.data ? ['TF_DATA_DIR'] : []), 'TF_INPUT', 'TF_IN_AUTOMATION', 'TMPDIR', 'WRANGLER_SEND_METRICS', 'npm_config_offline'].sort());
      expect(call.env).toMatchObject({ CHECKPOINT_DISABLE: '1', TF_INPUT: '0', TF_IN_AUTOMATION: 'true', WRANGLER_SEND_METRICS: 'false', COREPACK_ENABLE_NETWORK: '0' });
    }
  });
  it('enforces finite tool caps and treats timeout as a non-pass with cleanup', () => {
    const f = fixture(); const caps: number[] = [];
    const results = f.run({ spawn: (executable: string, args: string[], options: Parameters<typeof spawnSync>[2]) => {
      expect(options).toMatchObject({ shell: false, killSignal: 'SIGKILL', maxBuffer: 131072, stdio: ['ignore', 'pipe', 'pipe'] });
      caps.push(options?.timeout ?? 0);
      if (args.includes('init') && args[0]?.endsWith('/core')) return { status: null, error: { code: 'ETIMEDOUT' } };
      return spawnSync(executable, args, options!);
    } });
    expect(caps).toEqual([15000, 30000, 120000, 120000, 120000, 120000, 120000]);
    expect(results.find(row => row.name === 'terraform-core-init')).toMatchObject({ status: 'failed', blocker: 'tool-ETIMEDOUT' });
    expect(results.find(row => row.name === 'terraform-core')?.status).toBe('blocked');
    expect(readdirSync(f.work).every(name => name.startsWith('terraform-logs-'))).toBe(true);
  });
  it.each(['package-file', 'mirror-directory', 'source-file'])('rejects a %s symlink before invocation', kind => {
    const f = fixture();
    if (kind === 'package-file') { const target = join(f.base, 'provider'); writeFileSync(target, readFileSync(f.provider)); rmSync(f.provider); symlinkSync(target, f.provider); }
    if (kind === 'mirror-directory') { const target = join(f.base, 'linked-mirror'); symlinkSync(f.mirror, target); assertNoInvoke(f, f.run({ mirror: target }), 'Expected plain directory'); return; }
    if (kind === 'source-file') { const source = join(f.project, 'infra/terraform/main.tf'); rmSync(source); symlinkSync(join(f.project, 'infra/terraform/core-public/main.tf'), source); }
    assertNoInvoke(f, f.run(), 'Expected bounded regular file');
  });
  it('rechecks source STOP after version before every later command', () => {
    const f = fixture(); const spawn = vi.fn((_executable: string, args: string[]) => {
      expect(args).toEqual(['version', '-json']); writeFileSync(join(f.project, 'STOP'), 'synthetic stop after version');
      return { status: 0, stdout: '{"terraform_version":"1.17.1"}', stderr: '' };
    });
    const results = f.run({ spawn }); expect(spawn).toHaveBeenCalledTimes(1);
    expect(results.find(row => row.name === 'terraform-format')?.status).toBe('stopped');
    for (const name of ['core', 'core-public', 'routing']) {
      expect(results.find(row => row.name === `terraform-${name}-init`)?.status).toBe('stopped');
      expect(results.find(row => row.name === `terraform-${name}`)?.status).toBe('blocked');
    }
    expect(readdirSync(f.work).every(name => name.startsWith('terraform-logs-'))).toBe(true);
  });
  it('honors source STOP before invoking version, init, or validate', () => {
    const f = fixture(); writeFileSync(join(f.project, 'STOP'), 'synthetic stop'); const result = f.run();
    expect(f.calls()).toEqual([]); expect(result.find(row => row.name === 'terraform-version')?.status).toBe('stopped');
    expect(result.filter(row => row.name.endsWith('-init')).every(row => row.status === 'blocked')).toBe(true);
  });
});
