#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
const PLUGIN_MANIFESTS = [
  'gitnexus-claude-plugin/.claude-plugin/plugin.json',
  'gitnexus-claude-plugin/.codex-plugin/plugin.json',
];
const MARKETPLACE_MANIFESTS = [
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
];

function parseRepoRoot(argv) {
  if (argv.length === 0) return DEFAULT_REPO_ROOT;
  if (argv.length === 2 && argv[0] === '--repo-root' && argv[1]) {
    return path.resolve(argv[1]);
  }
  throw new Error('usage: sync-plugin-versions.mjs [--repo-root <path>]');
}

async function readJson(filePath) {
  const value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object`);
  }
  return value;
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function prepareUpdates(repoRoot) {
  const packagePath = path.join(repoRoot, 'gitnexus', 'package.json');
  const packageJson = await readJson(packagePath);
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new Error(`${packagePath} must contain a non-empty version`);
  }

  const updates = [];
  for (const relativePath of PLUGIN_MANIFESTS) {
    const filePath = path.join(repoRoot, relativePath);
    const manifest = await readJson(filePath);
    if (typeof manifest.version !== 'string') {
      throw new Error(`${relativePath} must contain a string version`);
    }
    manifest.version = packageJson.version;
    updates.push({ filePath, manifest });
  }

  for (const relativePath of MARKETPLACE_MANIFESTS) {
    const filePath = path.join(repoRoot, relativePath);
    const manifest = await readJson(filePath);
    if (!Array.isArray(manifest.plugins)) {
      throw new Error(`${relativePath} must contain a plugins array`);
    }
    const entries = manifest.plugins.filter(
      (plugin) => plugin && typeof plugin === 'object' && plugin.name === 'gitnexus',
    );
    if (entries.length !== 1) {
      throw new Error(`${relativePath} must contain exactly one gitnexus entry`);
    }
    if (typeof entries[0].version !== 'string') {
      throw new Error(`${relativePath} gitnexus entry must contain a string version`);
    }
    entries[0].version = packageJson.version;
    updates.push({ filePath, manifest });
  }

  return { updates, version: packageJson.version };
}

async function main() {
  const repoRoot = parseRepoRoot(process.argv.slice(2));
  const { updates, version } = await prepareUpdates(repoRoot);
  for (const { filePath, manifest } of updates) {
    await writeJsonAtomic(filePath, manifest);
  }
  process.stdout.write(`Synchronized plugin manifests to ${version}.\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sync-plugin-versions: ${message}\n`);
  process.exitCode = 1;
});
