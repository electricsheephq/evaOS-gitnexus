import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  getStagedAnalyzePaths,
  prepareStagedWorkspace,
  promoteStagedGeneration,
  withStagedAnalyzeLock,
  type PromotionBoundary,
} from '../../src/core/staged-promotion.js';
import { loadMeta, saveMeta, type RepoMeta } from '../../src/storage/repo-manager.js';

const tempDirs: string[] = [];

const makeMeta = (generation: string): RepoMeta => ({
  repoPath: '/repo',
  lastCommit: generation,
  indexedAt: `2026-07-20T00:00:0${generation === 'old' ? '0' : '1'}.000Z`,
  stats: { nodes: generation === 'old' ? 1 : 2, edges: 0 },
});

const setup = async (withCanonical = true) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-'));
  tempDirs.push(root);
  const canonicalMetaDir = path.join(root, '.gitnexus');
  const canonicalLbugPath = path.join(canonicalMetaDir, 'lbug');
  await fs.mkdir(canonicalMetaDir, { recursive: true });
  const oldMeta = withCanonical ? makeMeta('old') : null;
  if (oldMeta) {
    await fs.writeFile(canonicalLbugPath, 'old-generation');
    await saveMeta(canonicalMetaDir, oldMeta);
  }
  const paths = getStagedAnalyzePaths(canonicalLbugPath, canonicalMetaDir);
  await prepareStagedWorkspace(paths, oldMeta);
  await fs.writeFile(paths.stagedLbugPath, 'new-generation');
  const newMeta = makeMeta('new');
  await saveMeta(paths.stagedMetaDir, newMeta);
  return { paths, canonicalLbugPath, canonicalMetaDir, newMeta };
};

const exists = async (filePath: string): Promise<boolean> =>
  fs
    .access(filePath)
    .then(() => true)
    .catch(() => false);

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('staged promotion journal', () => {
  for (const boundary of [
    'prepared',
    'old-backed-up',
    'new-installed',
    'metadata/registry-committed',
  ] as const) {
    it(`recovers after a crash at ${boundary}`, async () => {
      const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
      let commits = 0;
      const commit = async (meta: RepoMeta): Promise<string> => {
        commits++;
        await saveMeta(canonicalMetaDir, meta);
        return 'repo';
      };

      await expect(
        promoteStagedGeneration(paths, commit, {
          afterBoundary: (reached: PromotionBoundary) => {
            if (reached === boundary) throw new Error(`crash:${boundary}`);
          },
        }),
      ).rejects.toThrow(`crash:${boundary}`);

      expect((await exists(canonicalLbugPath)) || (await exists(paths.backupLbugPath))).toBe(true);

      await promoteStagedGeneration(paths, commit);
      expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
      expect((await loadMeta(canonicalMetaDir))?.lastCommit).toBe('new');
      expect(await exists(paths.backupLbugPath)).toBe(false);
      expect(await exists(paths.journalPath)).toBe(false);
      expect(commits).toBe(1);
    });
  }

  it('recovers a canonical-to-backup rename that happened before the journal advanced', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    const commit = async (meta: RepoMeta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    };
    await expect(
      promoteStagedGeneration(paths, commit, {
        afterBoundary: (boundary) => {
          if (boundary === 'prepared') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await fs.rename(canonicalLbugPath, paths.backupLbugPath);

    await promoteStagedGeneration(paths, commit);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
  });

  it('recovers a staged-to-canonical rename that happened before the journal advanced', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    const commit = async (meta: RepoMeta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    };
    await expect(
      promoteStagedGeneration(paths, commit, {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await fs.rename(paths.stagedLbugPath, canonicalLbugPath);

    await promoteStagedGeneration(paths, commit);
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
  });

  it('restores the old generation when the staged DB disappears after backup', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup();
    await expect(
      promoteStagedGeneration(
        paths,
        async (meta) => {
          await saveMeta(canonicalMetaDir, meta);
          return 'repo';
        },
        {
          afterBoundary: (boundary) => {
            if (boundary === 'old-backed-up') throw new Error('crash');
          },
        },
      ),
    ).rejects.toThrow('crash');
    await fs.rm(paths.stagedLbugPath, { force: true });

    await expect(promoteStagedGeneration(paths, async () => 'repo')).rejects.toThrow(
      'restored the canonical backup',
    );
    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('old-generation');
  });

  it('promotes the first generation without inventing an old backup', async () => {
    const { paths, canonicalLbugPath, canonicalMetaDir } = await setup(false);
    await promoteStagedGeneration(paths, async (meta) => {
      await saveMeta(canonicalMetaDir, meta);
      return 'repo';
    });

    expect(await fs.readFile(canonicalLbugPath, 'utf8')).toBe('new-generation');
    expect(await exists(paths.backupLbugPath)).toBe(false);
  });

  it('reuses an interrupted stage only while canonical source identity is unchanged', async () => {
    const { paths, canonicalLbugPath } = await setup();
    await fs.writeFile(paths.stagedLbugPath, 'partial-new-generation');
    const oldMeta = makeMeta('old');
    await expect(prepareStagedWorkspace(paths, oldMeta)).resolves.toMatchObject({ resumed: true });
    expect(await fs.readFile(paths.stagedLbugPath, 'utf8')).toBe('partial-new-generation');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(canonicalLbugPath, 'externally-changed-canonical');
    await expect(prepareStagedWorkspace(paths, oldMeta)).resolves.toMatchObject({ resumed: false });
    expect(await fs.readFile(paths.stagedLbugPath, 'utf8')).toBe('externally-changed-canonical');
  });

  it('refuses to copy a canonical DB with unresolved WAL state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-wal-'));
    tempDirs.push(root);
    const metaDir = path.join(root, '.gitnexus');
    const lbugPath = path.join(metaDir, 'lbug');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(lbugPath, 'canonical');
    await fs.writeFile(`${lbugPath}.wal`, 'pending');
    const meta = makeMeta('old');
    await saveMeta(metaDir, meta);

    await expect(
      prepareStagedWorkspace(getStagedAnalyzePaths(lbugPath, metaDir), meta),
    ).rejects.toThrow('unresolved LadybugDB sidecars');
    expect(await fs.readFile(lbugPath, 'utf8')).toBe('canonical');
  });
});

describe('staged analyze lock', () => {
  it('refuses a concurrent staged builder', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-'));
    tempDirs.push(root);
    let release!: () => void;
    const first = withStagedAnalyzeLock(
      root,
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(async () => {
      await expect(fs.access(path.join(root, 'analyze-staged.lock'))).resolves.toBeUndefined();
    });

    await expect(withStagedAnalyzeLock(root, async () => undefined)).rejects.toThrow(
      'Another staged analyze is active',
    );
    release();
    await first;
  });

  it('reclaims a lock whose owner process is gone', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-stage-lock-'));
    tempDirs.push(root);
    await fs.writeFile(
      path.join(root, 'analyze-staged.lock'),
      `${JSON.stringify({
        schema: 'gitnexus.staged-analyze-lock/v1',
        pid: 2_147_483_647,
        nonce: 'dead-owner',
        startedAt: '2026-07-20T00:00:00.000Z',
      })}\n`,
    );

    await expect(withStagedAnalyzeLock(root, async () => 'ok')).resolves.toBe('ok');
    await expect(fs.access(path.join(root, 'analyze-staged.lock'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
