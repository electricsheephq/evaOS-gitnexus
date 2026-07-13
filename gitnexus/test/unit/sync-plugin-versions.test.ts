import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT_PATH = path.join(REPO_ROOT, 'gitnexus', 'scripts', 'sync-plugin-versions.mjs');
const temporaryRoots: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function createFixture(options: { duplicateCodexEntry?: boolean } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-version-sync-'));
  temporaryRoots.push(root);

  await writeJson(path.join(root, 'gitnexus', 'package.json'), {
    name: 'gitnexus',
    version: '2.3.4-rc.5',
  });
  await writeJson(path.join(root, 'gitnexus-claude-plugin', '.claude-plugin', 'plugin.json'), {
    name: 'gitnexus',
    version: '1.0.0',
    preserved: true,
  });
  await writeJson(path.join(root, 'gitnexus-claude-plugin', '.codex-plugin', 'plugin.json'), {
    name: 'gitnexus',
    version: '1.0.0',
    preserved: true,
  });
  await writeJson(path.join(root, '.claude-plugin', 'marketplace.json'), {
    plugins: [
      { name: 'unrelated', version: '9.9.9' },
      { name: 'gitnexus', version: '1.0.0', source: './gitnexus-claude-plugin' },
    ],
  });
  await writeJson(path.join(root, '.agents', 'plugins', 'marketplace.json'), {
    plugins: [
      { name: 'gitnexus', version: '1.0.0', source: './gitnexus-claude-plugin' },
      ...(options.duplicateCodexEntry ? [{ name: 'gitnexus', version: '0.9.0' }] : []),
    ],
  });

  return root;
}

function runSync(repoRoot: string) {
  return spawnSync(process.execPath, [SCRIPT_PATH, '--repo-root', repoRoot], {
    encoding: 'utf8',
  });
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true })));
});

describe('sync-plugin-versions', () => {
  it('updates exactly one GitNexus entry on every plugin surface and preserves other fields', async () => {
    const root = await createFixture();

    const result = runSync(root);

    expect(result.status, result.stderr).toBe(0);
    for (const relativePath of [
      'gitnexus-claude-plugin/.claude-plugin/plugin.json',
      'gitnexus-claude-plugin/.codex-plugin/plugin.json',
    ]) {
      const manifest = JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8')) as {
        version: string;
        preserved: boolean;
      };
      expect(manifest).toMatchObject({ version: '2.3.4-rc.5', preserved: true });
    }

    for (const relativePath of [
      '.claude-plugin/marketplace.json',
      '.agents/plugins/marketplace.json',
    ]) {
      const marketplace = JSON.parse(await fs.readFile(path.join(root, relativePath), 'utf8')) as {
        plugins: Array<{ name: string; version: string }>;
      };
      const entries = marketplace.plugins.filter((plugin) => plugin.name === 'gitnexus');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.version).toBe('2.3.4-rc.5');
    }
  });

  it('fails before writing any manifest when a marketplace has duplicate GitNexus entries', async () => {
    const root = await createFixture({ duplicateCodexEntry: true });
    const claudePluginPath = path.join(
      root,
      'gitnexus-claude-plugin',
      '.claude-plugin',
      'plugin.json',
    );
    const before = await fs.readFile(claudePluginPath, 'utf8');

    const result = runSync(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('exactly one gitnexus entry');
    expect(await fs.readFile(claudePluginPath, 'utf8')).toBe(before);
  });

  it('runs and verifies synchronization before the RC tag while staging every manifest', async () => {
    const workflow = await fs.readFile(
      path.join(REPO_ROOT, '.github', 'workflows', 'publish.yml'),
      'utf8',
    );
    const syncPosition = workflow.indexOf('node scripts/sync-plugin-versions.mjs');
    const tagPosition = workflow.indexOf('- name: Create and push rc tags');

    expect(syncPosition).toBeGreaterThan(-1);
    expect(workflow).toContain('test/unit/sync-plugin-versions.test.ts');
    expect(syncPosition).toBeLessThan(tagPosition);
    for (const stagedPath of [
      '../gitnexus-claude-plugin/.claude-plugin/plugin.json',
      '../.claude-plugin/marketplace.json',
      '../gitnexus-claude-plugin/.codex-plugin/plugin.json',
      '../.agents/plugins/marketplace.json',
    ]) {
      expect(workflow).toContain(stagedPath);
    }
  });
});
