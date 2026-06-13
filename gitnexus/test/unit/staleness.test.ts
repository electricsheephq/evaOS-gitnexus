/**
 * P2 Unit Tests: Staleness Check
 *
 * Tests: checkStaleness from staleness.ts
 * - HEAD matches → not stale
 * - HEAD differs → stale with commit count
 * - Git failure → fail open (not stale)
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkStaleness, checkStalenessAsync } from '../../src/core/git-staleness.js';

// We test checkStaleness with a real git repo (the project itself)
// since mocking execFileSync across ESM modules is complex.

describe('checkStaleness', () => {
  it('returns not stale when HEAD matches lastCommit', () => {
    // Get the actual HEAD commit of this repo
    let headCommit: string;
    try {
      headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      // If we can't get HEAD (e.g., not in a git repo), skip
      return;
    }

    const result = checkStaleness(process.cwd(), headCommit);
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('returns stale when lastCommit is behind HEAD', () => {
    // Use HEAD~1 — works in shallow clones (GitHub Actions) unlike rev-list --max-parents=0
    let previousCommit: string;
    try {
      previousCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return; // Not in a git repo or only 1 commit
    }

    if (!previousCommit) return;

    const result = checkStaleness(process.cwd(), previousCommit);
    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBeGreaterThan(0);
    expect(result.hint).toContain('behind HEAD');
  });

  it('fails open when git command fails (e.g., invalid path)', () => {
    const result = checkStaleness('/nonexistent/path', 'abc123');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('fails open with invalid commit hash', () => {
    const result = checkStaleness(process.cwd(), 'not-a-real-commit-hash');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });
});

describe('checkStalenessAsync', () => {
  it('returns not stale when HEAD matches lastCommit', async () => {
    let headCommit: string;
    try {
      headCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return;
    }

    const result = await checkStalenessAsync(process.cwd(), headCommit);
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.hint).toBeUndefined();
  });

  it('returns stale when lastCommit is behind HEAD', async () => {
    let previousCommit: string;
    try {
      previousCommit = execFileSync('git', ['rev-parse', 'HEAD~1'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return;
    }

    if (!previousCommit) return;

    const result = await checkStalenessAsync(process.cwd(), previousCommit);
    expect(result.isStale).toBe(true);
    expect(result.commitsBehind).toBeGreaterThan(0);
    expect(result.hint).toContain('behind HEAD');
  });

  it('fails open when git command fails (e.g., invalid path)', async () => {
    const result = await checkStalenessAsync('/nonexistent/path', 'abc123');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('fails open with invalid commit hash', async () => {
    const result = await checkStalenessAsync(process.cwd(), 'not-a-real-commit-hash');
    expect(result.isStale).toBe(false);
    expect(result.commitsBehind).toBe(0);
  });

  it('parallel calls complete faster than sequential', async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-staleness-'));
    const fakeGitJs = path.join(tempDir, 'fake-git.js');
    const fakeGitSource = `
setTimeout(() => {
  process.stdout.write('0\\n');
}, Number(process.env.FAKE_GIT_DELAY_MS || 80));
`;
    writeFileSync(fakeGitJs, fakeGitSource, 'utf8');

    if (process.platform === 'win32') {
      writeFileSync(
        path.join(tempDir, 'git.cmd'),
        `@echo off\r\nnode "%~dp0fake-git.js" %*\r\n`,
        'utf8',
      );
    } else {
      const fakeGit = path.join(tempDir, 'git');
      writeFileSync(fakeGit, `#!/usr/bin/env sh\nnode "${fakeGitJs}" "$@"\n`, 'utf8');
      chmodSync(fakeGit, 0o755);
    }

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${tempDir}${path.delimiter}${originalPath ?? ''}`;
      process.env.FAKE_GIT_DELAY_MS = '80';

      const cwd = tempDir;
      const N = 6;

      const t0 = performance.now();
      const parallelResults = await Promise.all(
        Array.from({ length: N }, () => checkStalenessAsync(cwd, 'HEAD')),
      );
      const parallelMs = performance.now() - t0;

      const t1 = performance.now();
      const sequentialResults = Array.from({ length: N }, () => checkStaleness(cwd, 'HEAD'));
      const sequentialMs = performance.now() - t1;

      expect(parallelResults).toEqual(sequentialResults);
      // The fake git command has a fixed delay, so this asserts actual
      // concurrent child-process behavior without relying on real git speed.
      expect(parallelMs).toBeLessThan(sequentialMs * 0.75);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      delete process.env.FAKE_GIT_DELAY_MS;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
