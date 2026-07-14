#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXPECTED_LADYBUG_VERSION = '0.18.1';
const PACKAGED_CLI_TIMEOUT_MS = 60_000;
const ARGUMENT_KEYS = new Set(['asset', 'checksums', 'prefix', 'expected-version']);
const USAGE =
  'usage: verify-electric-package.mjs --asset <tarball> --checksums <file> --prefix <dir> --expected-version <version>';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--'))
      throw new Error(`unexpected argument: ${key ?? '<missing>'}\n${USAGE}`);
    const name = key.slice(2);
    if (!ARGUMENT_KEYS.has(name)) throw new Error(`unexpected argument: ${key}\n${USAGE}`);
    if (Object.hasOwn(values, name)) throw new Error(`duplicate argument: ${key}`);
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${key}\n${USAGE}`);
    values[name] = value;
  }
  for (const key of ARGUMENT_KEYS) {
    if (!values[key]) throw new Error(`missing --${key}`);
  }
  return values;
}

function requireRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size <= 0)
    throw new Error(`expected a non-empty regular file: ${file}`);
}

function verifyChecksum(assetPath, checksumPath) {
  requireRegularFile(assetPath);
  requireRegularFile(checksumPath);
  const filename = path.basename(assetPath);
  const matches = fs
    .readFileSync(checksumPath, 'utf8')
    .split(/\n/u)
    .map((line) => line.replace(/\r$/u, ''))
    .filter(Boolean)
    .map((line) => line.match(/^([0-9a-f]{64})\s+\*?(.+)$/u))
    .filter((match) => match?.[2] === filename);
  if (matches.length !== 1) {
    throw new Error(`SHA256SUMS must contain exactly one lowercase SHA-256 entry for ${filename}`);
  }
  const actual = createHash('sha256').update(fs.readFileSync(assetPath)).digest('hex');
  if (actual !== matches[0][1]) throw new Error(`SHA-256 mismatch for ${filename}`);
  return actual;
}

function locateInstalledPackage(prefix) {
  const candidates = [
    path.join(prefix, 'lib', 'node_modules', 'gitnexus'),
    path.join(prefix, 'node_modules', 'gitnexus'),
  ];
  const installed = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'package.json')),
  );
  if (!installed) throw new Error(`installed gitnexus package not found under ${prefix}`);
  return installed;
}

export function runCli(prefix, args, timeoutMs = PACKAGED_CLI_TIMEOUT_MS) {
  for (const arg of args) {
    if (!/^[a-z0-9-]+$/iu.test(arg)) {
      throw new Error(`unsafe packaged CLI argument: ${arg}`);
    }
  }
  const executable =
    process.platform === 'win32'
      ? path.join(prefix, 'gitnexus.cmd')
      : path.join(prefix, 'bin', 'gitnexus');
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    killSignal: 'SIGKILL',
    shell: process.platform === 'win32',
    timeout: timeoutMs,
  });
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`gitnexus ${args.join(' ')} timed out after ${timeoutMs}ms`);
  }
  if (result.error || result.status !== 0) {
    throw new Error(
      `gitnexus ${args.join(' ')} failed: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function verifyVendorTree(installed) {
  const vendorRoot = path.join(installed, 'vendor');
  const forbidden = [];
  if (fs.existsSync(vendorRoot)) {
    const pending = [vendorRoot];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const entryPath = path.join(current, entry.name);
        if (entry.name === 'node_modules' || entry.name === 'build') forbidden.push(entryPath);
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryPath);
      }
    }
  }
  if (forbidden.length > 0) {
    throw new Error(`vendor tree contains forbidden build artifacts: ${forbidden.join(', ')}`);
  }

  for (const name of ['tree-sitter-dart', 'tree-sitter-proto', 'tree-sitter-swift']) {
    const entry = path.join(installed, 'node_modules', name);
    if (!fs.existsSync(entry)) continue;
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) {
      throw new Error(`materialized grammar must not be a symlink or junction: ${entry}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`materialized grammar must be a directory: ${entry}`);
    }
  }
}

export function verifyElectricPackage({ asset, checksums, prefix, expectedVersion }) {
  const digest = verifyChecksum(asset, checksums);
  const installed = locateInstalledPackage(prefix);
  const packageJson = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
  if (packageJson.name !== 'gitnexus' || packageJson.version !== expectedVersion) {
    throw new Error(
      `installed package identity is ${packageJson.name}@${packageJson.version}, expected gitnexus@${expectedVersion}`,
    );
  }
  verifyVendorTree(installed);

  const ladybugPackagePath = path.join(
    installed,
    'node_modules',
    '@ladybugdb',
    'core',
    'package.json',
  );
  const ladybugPackage = JSON.parse(fs.readFileSync(ladybugPackagePath, 'utf8'));
  if (ladybugPackage.version !== EXPECTED_LADYBUG_VERSION) {
    throw new Error(
      `installed @ladybugdb/core is ${ladybugPackage.version}, expected ${EXPECTED_LADYBUG_VERSION}`,
    );
  }

  const requireFromPackage = createRequire(path.join(installed, 'package.json'));
  const loaded = requireFromPackage('@ladybugdb/core');
  const api = loaded?.default ?? loaded;
  if (typeof api?.Database !== 'function' || typeof api?.Connection !== 'function') {
    throw new Error('@ladybugdb/core loaded without Database and Connection constructors');
  }

  const versionOutput = runCli(prefix, ['--version']);
  if (versionOutput !== expectedVersion) {
    throw new Error(`packaged CLI version is ${versionOutput}, expected ${expectedVersion}`);
  }
  runCli(prefix, ['--help']);
  runCli(prefix, ['mcp', '--help']);

  return {
    package: `gitnexus@${expectedVersion}`,
    ladybug: `@ladybugdb/core@${EXPECTED_LADYBUG_VERSION}`,
    sha256: digest,
    nativeImport: 'ok',
    vendorTree: 'ok',
    cli: 'ok',
    mcpHelp: 'ok',
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = verifyElectricPackage({
      asset: path.resolve(args.asset),
      checksums: path.resolve(args.checksums),
      prefix: path.resolve(args.prefix),
      expectedVersion: args['expected-version'],
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
