import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRepositoryRemote } from '../../src/storage/git.js';
import {
  getGlobalRegistryPath,
  readRegistry,
  registerRepo,
  RepositoryRemoteCollisionError,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';
import { createTempDir } from '../helpers/test-db.js';

describe('canonical repository remote identity (#133)', () => {
  it.each([
    'https://github.com/ElectricSheepHQ/EVAOS-GitNexus.git',
    'http://GITHUB.COM/electricsheephq/evaos-gitnexus/',
    'git@github.com:ElectricSheepHQ/evaOS-gitnexus.git',
    'ssh://git@GitHub.com/ElectricSheepHQ/evaOS-gitnexus.git',
    'git://github.com/electricsheephq/evaos-gitnexus',
  ])('collapses GitHub transport, suffix, and case for %s', (remote) => {
    expect(normalizeRepositoryRemote(remote)).toBe('github.com/electricsheephq/evaos-gitnexus');
  });

  it('keeps transport and path case for non-GitHub remotes', () => {
    expect(normalizeRepositoryRemote('https://Forge.Example/Owner/Repo.git')).toBe(
      'https://forge.example/Owner/Repo',
    );
    expect(normalizeRepositoryRemote('git@Forge.Example:Owner/Repo.git')).toBe(
      'ssh://forge.example/Owner/Repo',
    );
  });

  it.each([undefined, null, '', '/srv/repos/local.git', 'file:///srv/repos/local.git', 'C:\\repo'])(
    'does not promote local-only remote %s to a fleet identity',
    (remote) => {
      expect(normalizeRepositoryRemote(remote)).toBeUndefined();
    },
  );
});

describe('registry canonical remote enforcement (#133)', () => {
  let tmpHome: Awaited<ReturnType<typeof createTempDir>>;
  let repoA: Awaited<ReturnType<typeof createTempDir>>;
  let repoB: Awaited<ReturnType<typeof createTempDir>>;
  let savedHome: string | undefined;

  const meta = (repoPath: string, remoteUrl?: string): RepoMeta => ({
    repoPath,
    lastCommit: 'abc123',
    indexedAt: '2026-07-20T00:00:00.000Z',
    remoteUrl,
    stats: { nodes: 1, edges: 0, embeddings: 0 },
  });

  beforeEach(async () => {
    tmpHome = await createTempDir('gitnexus-canonical-home-');
    repoA = await createTempDir('gitnexus-canonical-a-');
    repoB = await createTempDir('gitnexus-canonical-b-');
    savedHome = process.env.GITNEXUS_HOME;
    process.env.GITNEXUS_HOME = tmpHome.dbPath;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = savedHome;
    await repoA.cleanup();
    await repoB.cleanup();
    await tmpHome.cleanup();
  });

  it('refuses a second top-level index and preserves the first canonical row', async () => {
    await registerRepo(
      repoA.dbPath,
      meta(repoA.dbPath, 'https://github.com/ElectricSheepHQ/EVAOS-GitNexus.git'),
    );

    let error: unknown;
    try {
      await registerRepo(
        repoB.dbPath,
        meta(repoB.dbPath, 'git@github.com:electricsheephq/evaos-gitnexus.git'),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(RepositoryRemoteCollisionError);
    expect(error).toMatchObject({
      code: 'repository_remote_collision',
      canonicalPath: path.resolve(repoA.dbPath),
      requestedPath: path.resolve(repoB.dbPath),
    });
    expect((error as Error).message).toContain(path.resolve(repoA.dbPath));

    const registry = await readRegistry();
    expect(registry).toHaveLength(1);
    expect(registry[0]?.path).toBe(path.resolve(repoA.dbPath));
  });

  it('allows re-registration of the canonical path', async () => {
    const remote = 'https://github.com/electricsheephq/evaos-gitnexus.git';
    await registerRepo(repoA.dbPath, meta(repoA.dbPath, remote));
    await expect(registerRepo(repoA.dbPath, meta(repoA.dbPath, remote))).resolves.toBeDefined();
    expect(await readRegistry()).toHaveLength(1);
  });

  it('keeps repositories without a normalized remote path-based and local-only', async () => {
    await registerRepo(repoA.dbPath, meta(repoA.dbPath));
    await registerRepo(repoB.dbPath, meta(repoB.dbPath));
    expect(await readRegistry()).toHaveLength(2);
  });

  it('fails analyze before creating index state for a second clone', async () => {
    const canonicalRemote = 'https://github.com/ElectricSheepHQ/EVAOS-GitNexus.git';
    await registerRepo(repoA.dbPath, meta(repoA.dbPath, canonicalRemote));
    const registryPath = getGlobalRegistryPath();
    const registryBefore = await fs.readFile(registryPath, 'utf8');

    execFileSync('git', ['init', '-q'], { cwd: repoB.dbPath });
    execFileSync(
      'git',
      ['remote', 'add', 'origin', 'git@github.com:electricsheephq/evaos-gitnexus.git'],
      {
        cwd: repoB.dbPath,
      },
    );
    const result = spawnSync(
      process.execPath,
      [...CLI_SPAWN_PREFIX, 'analyze', repoB.dbPath, '--skip-agents-md'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GITNEXUS_HOME: tmpHome.dbPath,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --max-old-space-size=4096`.trim(),
        },
      },
    );

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('repository_remote_collision');
    expect(`${result.stdout}${result.stderr}`).toContain(path.resolve(repoA.dbPath));
    await expect(fs.stat(path.join(repoB.dbPath, '.gitnexus'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await fs.readFile(registryPath, 'utf8')).toBe(registryBefore);
  });
});
