import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const helperPath = path.resolve(__dirname, '..', '..', 'hooks', 'claude', 'hook-lock.cjs');

describe('Claude hook machine-global concurrency cap', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('admits no more than eight of 64 simultaneous calls across repositories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-hook-global-cap-'));
    roots.push(root);
    const globalDir = path.join(root, 'global-locks');
    const repos = Array.from({ length: 24 }, (_, index) => {
      const gitnexusDir = path.join(root, `repo-${index}`, '.gitnexus');
      fs.mkdirSync(gitnexusDir, { recursive: true });
      return gitnexusDir;
    });
    const script = `
      const { acquireHookSlot } = require(${JSON.stringify(helperPath)});
      const release = acquireHookSlot(process.argv[1]);
      if (!release) { process.stdout.write('denied\\n'); process.exit(0); }
      process.stdout.write('acquired\\n');
      // Keep the admitted wave alive long enough for all 64 processes to
      // contend at once, while remaining below Claude's 10-second hook timeout.
      setTimeout(() => { release(); process.exit(0); }, 6000);
    `;

    const children: ChildProcessWithoutNullStreams[] = [];
    for (let index = 0; index < 64; index++) {
      children.push(
        spawn(process.execPath, ['-e', script, repos[index % repos.length]], {
          env: { ...process.env, GITNEXUS_HOOK_GLOBAL_LOCK_DIR: globalDir },
          stdio: ['pipe', 'pipe', 'pipe'],
        }),
      );
    }

    const outcomes = await Promise.all(
      children.map(
        (child) =>
          new Promise<string>((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => (stdout += String(chunk)));
            child.stderr.on('data', (chunk) => (stderr += String(chunk)));
            child.on('error', reject);
            child.on('exit', (code) => {
              if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
              else resolve(stdout.trim());
            });
          }),
      ),
    );

    const acquired = outcomes.filter((outcome) => outcome === 'acquired').length;
    expect(acquired).toBeGreaterThan(0);
    expect(acquired).toBeLessThanOrEqual(8);
    expect(outcomes.filter((outcome) => outcome === 'denied')).toHaveLength(64 - acquired);
    const remainingLocks = fs.existsSync(globalDir)
      ? fs.readdirSync(globalDir).filter((entry) => entry.endsWith('.lock'))
      : [];
    expect(remainingLocks).toEqual([]);
    for (const repo of repos) {
      const perRepo = path.join(repo, '.hook-locks');
      const orphaned = fs.existsSync(perRepo)
        ? fs.readdirSync(perRepo).filter((entry) => entry.endsWith('.lock'))
        : [];
      expect(orphaned).toEqual([]);
    }
  }, 20_000);
});
