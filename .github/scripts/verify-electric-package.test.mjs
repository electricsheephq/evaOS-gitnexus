import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'verify-electric-package.mjs',
);
const temporaryRoots = [];

function fixture({ ladybugVersion = '0.18.1' } = {}) {
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
    JSON.stringify({ name: 'gitnexus', version: '1.6.10-electric.2' }),
  );
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
  if (process.platform === 'win32') {
    const cliScript = path.join(prefix, 'gitnexus-test.cjs');
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(cliScript, cliSource);
    fs.writeFileSync(path.join(prefix, 'gitnexus.cmd'), '@node "%~dp0\\gitnexus-test.cjs" %*\r\n');
  } else {
    const bin = path.join(prefix, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const executable = path.join(bin, 'gitnexus');
    fs.writeFileSync(executable, cliSource);
    fs.chmodSync(executable, 0o755);
  }

  const asset = path.join(root, 'gitnexus-1.6.10-electric.2.tgz');
  fs.writeFileSync(asset, 'deterministic tarball fixture');
  const digest = createHash('sha256').update(fs.readFileSync(asset)).digest('hex');
  const checksums = path.join(root, 'SHA256SUMS');
  fs.writeFileSync(checksums, `${digest}  ${path.basename(asset)}\n`);
  return { root, prefix, asset, checksums };
}

function run(values) {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--asset',
      values.asset,
      '--checksums',
      values.checksums,
      '--prefix',
      values.prefix,
      '--expected-version',
      '1.6.10-electric.2',
    ],
    { encoding: 'utf8' },
  );
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
    cli: 'ok',
    mcpHelp: 'ok',
  });
});

test('fails closed when the installed LadybugDB version drifts', () => {
  const result = run(fixture({ ladybugVersion: '0.18.0' }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /expected 0\.18\.1/u);
});
