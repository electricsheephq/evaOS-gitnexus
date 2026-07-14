import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { EXPECTED_LADYBUG_VERSION, runCli } from './verify-electric-package.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'verify-electric-package.mjs',
);
const temporaryRoots = [];

test('keeps the release verifier synchronized with the exact package pin', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        'gitnexus',
        'package.json',
      ),
      'utf8',
    ),
  );
  assert.equal(packageJson.dependencies['@ladybugdb/core'], EXPECTED_LADYBUG_VERSION);
});

function fixture({ ladybugVersion = '0.18.1', checksumLineEnding = '\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-electric-package-'));
  temporaryRoots.push(root);
  const prefix = path.join(root, 'prefix');
  const installed = path.join(
    prefix,
    process.platform === 'win32' ? '' : 'lib',
    'node_modules',
    'gitnexus',
  );
  const ladybug = path.join(installed, 'node_modules', '@ladybugdb', 'core');
  fs.mkdirSync(ladybug, { recursive: true });
  fs.writeFileSync(
    path.join(installed, 'package.json'),
    JSON.stringify({
      name: 'gitnexus',
      version: '1.6.10-electric.2',
      bin: { gitnexus: 'dist/cli/index.js' },
    }),
  );
  fs.mkdirSync(path.join(installed, 'vendor', 'tree-sitter-typescript'), { recursive: true });
  for (const name of ['tree-sitter-dart', 'tree-sitter-proto', 'tree-sitter-swift']) {
    fs.mkdirSync(path.join(installed, 'node_modules', name), { recursive: true });
  }
  fs.writeFileSync(
    path.join(ladybug, 'package.json'),
    JSON.stringify({ name: '@ladybugdb/core', version: ladybugVersion, main: 'index.cjs' }),
  );
  fs.writeFileSync(
    path.join(ladybug, 'index.cjs'),
    'module.exports = { Database: class Database {}, Connection: class Connection {} };\n',
  );

  const cliSource = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.6.10-electric.2');
else if (args[0] === '--help' || (args[0] === 'mcp' && args[1] === '--help')) process.exit(0);
else process.exit(2);
`;
  const cliScript = path.join(installed, 'dist', 'cli', 'index.js');
  fs.mkdirSync(path.dirname(cliScript), { recursive: true });
  fs.writeFileSync(cliScript, cliSource);

  const asset = path.join(root, 'gitnexus-1.6.10-electric.2.tgz');
  fs.writeFileSync(asset, 'deterministic tarball fixture');
  const digest = createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
  const checksums = path.join(root, 'SHA256SUMS');
  fs.writeFileSync(checksums, `${digest}  ${path.basename(asset)}${checksumLineEnding}`);
  return { root, prefix, installed, cliScript, asset, checksums };
}

function runArgs(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function run(values, trailingArgs = []) {
  return runArgs([
    '--asset',
    values.asset,
    '--checksums',
    values.checksums,
    '--prefix',
    values.prefix,
    '--expected-version',
    '1.6.10-electric.2',
    ...trailingArgs,
  ]);
}

test.after(() => {
  for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true });
});

test('verifies checksum, package identity, native import, CLI, and MCP help', () => {
  const result = run(fixture());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    package: 'gitnexus@1.6.10-electric.2',
    ladybug: '@ladybugdb/core@0.18.1',
    sha256: createHash('sha256').update('deterministic tarball fixture').digest('hex'),
    nativeImport: 'ok',
    vendorTree: 'ok',
    cli: 'ok',
    mcpHelp: 'ok',
  });
});

test('accepts CRLF checksum files', () => {
  const result = run(fixture({ checksumLineEnding: '\r\n' }));
  assert.equal(result.status, 0, result.stderr);
});

test('fails fast when the packaged CLI hangs', () => {
  const values = fixture();
  fs.writeFileSync(
    values.cliScript,
    "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {});\nsetTimeout(() => {}, 10_000);\n",
  );
  if (process.platform !== 'win32') fs.chmodSync(values.cliScript, 0o755);
  const started = Date.now();
  assert.throws(() => runCli(values.prefix, ['--help'], 1_000), /timed out after 1000ms/u);
  assert.ok(Date.now() - started < 5_000, 'hard timeout must not wait for natural child exit');
});

test('fails closed on vendor build artifacts', () => {
  const values = fixture();
  fs.mkdirSync(path.join(values.installed, 'vendor', 'tree-sitter-typescript', 'build'));
  const result = run(values);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /vendor tree contains forbidden build artifacts/u);
});

test('fails closed when a materialized grammar is a symlink or junction', () => {
  const values = fixture();
  const grammar = path.join(values.installed, 'node_modules', 'tree-sitter-dart');
  const target = path.join(values.root, 'grammar-target');
  fs.rmSync(grammar, { recursive: true });
  fs.mkdirSync(target);
  fs.symlinkSync(target, grammar, process.platform === 'win32' ? 'junction' : 'dir');
  const result = run(values);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symlink or junction/u);
});

test('fails closed when the installed LadybugDB version drifts', () => {
  const result = run(fixture({ ladybugVersion: '0.18.0' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 0\.18\.1/u);
});

test('rejects unknown and duplicate release-gate arguments', () => {
  const values = fixture();
  const unknown = run(values, ['--verbose', 'true']);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unexpected argument: --verbose/u);

  const duplicate = run(values, ['--asset', values.asset]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /duplicate argument: --asset/u);
});

test('rejects a following flag as a missing argument value', () => {
  const result = runArgs(['--asset', '--checksums', 'SHA256SUMS']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing value for --asset/u);
});
