import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import fsSync from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';
import {
  getStagedAnalyzePaths,
  prepareStagedWorkspace,
  promoteStagedGeneration,
} from '../../src/core/staged-promotion.js';

const tempDirs: string[] = [];

describe('runFullAnalysis --staged', () => {
  let priorHome: string | undefined;
  let priorInstallPolicy: string | undefined;

  beforeEach(() => {
    priorHome = process.env.GITNEXUS_HOME;
    priorInstallPolicy = process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = 'never';
  });

  afterEach(async () => {
    if (priorHome === undefined) delete process.env.GITNEXUS_HOME;
    else process.env.GITNEXUS_HOME = priorHome;
    if (priorInstallPolicy === undefined) delete process.env.GITNEXUS_LBUG_EXTENSION_INSTALL;
    else process.env.GITNEXUS_LBUG_EXTENSION_INSTALL = priorInstallPolicy;
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it('keeps the canonical DB inode unchanged until validated promotion', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-run-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );

    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });
    const canonical = getStoragePaths(repo);
    const before = fsSync.statSync(canonical.lbugPath);

    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 2;\n');
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'change'],
      { cwd: repo },
    );

    let sawPrePromotion = false;
    const result = await runFullAnalysis(
      repo,
      { staged: true, skipAgentsMd: true, skipSkills: true },
      {
        onProgress: (_phase, percent) => {
          if (percent >= 99) return;
          sawPrePromotion = true;
          const during = fsSync.statSync(canonical.lbugPath);
          expect(during.ino).toBe(before.ino);
          expect(during.mtimeMs).toBe(before.mtimeMs);
        },
      },
    );

    expect(sawPrePromotion).toBe(true);
    expect(result.alreadyUpToDate).not.toBe(true);
    const after = fsSync.statSync(canonical.lbugPath);
    expect(after.ino).not.toBe(before.ino);
    const finalMeta = await loadMeta(canonical.storagePath);
    expect(finalMeta?.lastCommit).toBe(
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    );

    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.backupLbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a missing canonical pathname before rejecting a branch mismatch', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-recover-'));
    tempDirs.push(repo);
    process.env.GITNEXUS_HOME = path.join(repo, '.registry-home');
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    const originalBranch = execFileSync('git', ['branch', '--show-current'], {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta);
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-20T12:00:00.000Z',
    });
    await expect(
      promoteStagedGeneration(staged, async () => 'repo', {
        afterBoundary: (boundary) => {
          if (boundary === 'old-backed-up') throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    await expect(fs.access(canonical.lbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    execFileSync('git', ['switch', '-c', 'other'], { cwd: repo, stdio: 'pipe' });

    await expect(
      runFullAnalysis(
        repo,
        { staged: true, branch: originalBranch, skipAgentsMd: true, skipSkills: true },
        { onProgress: () => {} },
      ),
    ).rejects.toThrow('does not match the checked-out branch');
    await expect(fs.access(canonical.lbugPath)).resolves.toBeUndefined();
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('promotes a completed resumed stage when the process died before journaling', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-prejournal-'));
    tempDirs.push(repo);
    const registryHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-staged-registry-'));
    tempDirs.push(registryHome);
    process.env.GITNEXUS_HOME = registryHome;
    await fs.writeFile(path.join(repo, 'index.ts'), 'export const value = 1;\n');
    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['add', 'index.ts'], { cwd: repo });
    execFileSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'initial'],
      { cwd: repo },
    );
    await runFullAnalysis(repo, { skipAgentsMd: true, skipSkills: true }, { onProgress: () => {} });

    const canonical = getStoragePaths(repo);
    const canonicalMeta = await loadMeta(canonical.storagePath);
    if (!canonicalMeta) throw new Error('expected canonical metadata');
    const before = await fs.stat(canonical.lbugPath);
    const staged = getStagedAnalyzePaths(canonical.lbugPath, canonical.storagePath);
    await prepareStagedWorkspace(staged, canonicalMeta);
    await saveMeta(staged.stagedMetaDir, {
      ...canonicalMeta,
      indexedAt: '2026-07-20T12:00:00.000Z',
    });

    const result = await runFullAnalysis(
      repo,
      { staged: true, skipAgentsMd: true, skipSkills: true },
      { onProgress: () => {} },
    );

    expect(result.alreadyUpToDate).toBe(true);
    expect((await fs.stat(canonical.lbugPath)).ino).not.toBe(before.ino);
    expect((await loadMeta(canonical.storagePath))?.indexedAt).toBe('2026-07-20T12:00:00.000Z');
    await expect(fs.access(staged.stageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.backupLbugPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(staged.journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
