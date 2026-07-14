import { execFileSync } from 'child_process';
import { writeFileSync } from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { readResource } from '../../src/mcp/resources.js';
import type { RepoMeta } from '../../src/storage/repo-manager.js';
import { getStoragePaths, registerRepo, saveMeta } from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' }).trim();
}

describe('context resource after an out-of-process analysis', () => {
  let temp: Awaited<ReturnType<typeof createTempDir>>;
  let repoPath: string;
  let storagePath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    temp = await createTempDir('gitnexus-context-resource-');
    repoPath = temp.dbPath;
    previousHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = path.join(repoPath, '.registry');
    storagePath = getStoragePaths(repoPath).storagePath;

    git(repoPath, 'init');
    git(repoPath, 'config', 'user.name', 'GitNexus Test');
    git(repoPath, 'config', 'user.email', 'gitnexus@example.com');
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = previousHome;
    await temp.cleanup();
  });

  it('refreshes the staleness banner and stats without restarting MCP', async () => {
    writeFileSync(path.join(repoPath, 'a.ts'), 'export const a = 1;\n');
    git(repoPath, 'add', 'a.ts');
    git(repoPath, 'commit', '-m', 'first');
    const firstCommit = git(repoPath, 'rev-parse', 'HEAD');

    writeFileSync(path.join(repoPath, 'b.ts'), 'export const b = 2;\n');
    git(repoPath, 'add', 'b.ts');
    git(repoPath, 'commit', '-m', 'second');
    const secondCommit = git(repoPath, 'rev-parse', 'HEAD');

    const initial: RepoMeta = {
      repoPath,
      lastCommit: firstCommit,
      indexedAt: '2026-07-14T00:00:00.000Z',
      stats: { files: 1, nodes: 1, processes: 1 },
    };
    await saveMeta(storagePath, initial);
    await registerRepo(repoPath, initial, { name: 'context-fixture' });

    const backend = new LocalBackend();
    await backend.init();
    const before = await readResource('gitnexus://repo/context-fixture/context', backend);
    expect(before).toContain('1 commit behind');
    expect(before).toContain('files: 1');

    await saveMeta(storagePath, {
      repoPath,
      lastCommit: secondCommit,
      indexedAt: '2026-07-14T01:00:00.000Z',
      stats: { files: 2, nodes: 2, processes: 2 },
    });

    const after = await readResource('gitnexus://repo/context-fixture/context', backend);
    expect(after).not.toContain('staleness:');
    expect(after).toContain('files: 2');
    expect(after).toContain('symbols: 2');
    expect(after).toContain('processes: 2');
  });
});
