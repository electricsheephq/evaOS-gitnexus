import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSafeContainedDirectory,
  openArtifactLogs,
  selectSafeTrackedFiles,
  writeJsonArtifact,
} from '../../scripts/reconciliation/canary-safety.mjs';

const temporaryRoots: string[] = [];

const makeTemporaryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-canary-safety-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe('reconciliation canary filesystem safety', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a preexisting evidence symlink without truncating its target',
    () => {
      const root = makeTemporaryRoot();
      const source = path.join(root, 'source');
      const evidence = path.join(root, 'evidence');
      const commands = path.join(evidence, 'commands');
      const extensionSource = path.join(root, 'extension');
      const fakeCli = path.join(root, 'fake-cli.mjs');
      const victim = path.join(root, 'victim.txt');
      const worktree = path.join(root, 'worktree');

      fs.mkdirSync(source);
      fs.mkdirSync(commands, { recursive: true });
      fs.mkdirSync(extensionSource);
      fs.writeFileSync(path.join(source, 'README.md'), 'fixture\n');
      fs.writeFileSync(path.join(extensionSource, 'extension.bin'), 'fixture\n');
      fs.writeFileSync(fakeCli, 'process.exit(1);\n');
      fs.writeFileSync(victim, 'preserve-me\n');
      fs.symlinkSync(victim, path.join(commands, 'clone.stdout.log'));

      execFileSync('git', ['init', '-q'], { cwd: source });
      execFileSync('git', ['add', 'README.md'], { cwd: source });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Canary Test',
          '-c',
          'user.email=canary-test@example.invalid',
          'commit',
          '-q',
          '-m',
          'fixture',
        ],
        { cwd: source },
      );
      const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: source,
        encoding: 'utf8',
      }).trim();

      const result = spawnSync(
        process.execPath,
        [
          'scripts/reconciliation/large-repository-canary.mjs',
          '--source',
          source,
          '--source-sha',
          sourceSha,
          '--public-origin',
          'https://example.invalid/repository.git',
          '--worktree',
          worktree,
          '--evidence',
          evidence,
          '--gitnexus-cli',
          fakeCli,
          '--incremental-child',
          fakeCli,
          '--extension-source',
          extensionSource,
          '--run-id',
          'symlink-safety-test',
        ],
        { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('symbolic link');
      expect(fs.readFileSync(victim, 'utf8')).toBe('preserve-me\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked fixture-directory component outside the worktree',
    () => {
      const root = makeTemporaryRoot();
      const worktree = path.join(root, 'worktree');
      const victimDirectory = path.join(root, 'victim');
      fs.mkdirSync(worktree);
      fs.mkdirSync(victimDirectory);
      fs.symlinkSync(victimDirectory, path.join(worktree, 'src'));

      expect(() => createSafeContainedDirectory(worktree, 'src/r19-canary')).toThrow(
        'symbolic link',
      );
      expect(fs.readdirSync(victimDirectory)).toEqual([]);
    },
  );

  it('preserves prior command logs and snapshots across retry attempts', () => {
    const root = makeTemporaryRoot();
    const commands = path.join(root, 'commands');
    const snapshots = path.join(root, 'snapshots');
    fs.mkdirSync(commands);
    fs.mkdirSync(snapshots);
    fs.writeFileSync(path.join(commands, 'clone.stdout.log'), 'first stdout\n');
    fs.writeFileSync(path.join(commands, 'clone.stderr.log'), 'first stderr\n');
    fs.writeFileSync(path.join(snapshots, 'initial.json'), '{"attempt":1}\n');

    const logs = openArtifactLogs(commands, 'clone');
    fs.writeSync(logs.stdout, 'second stdout\n');
    fs.writeSync(logs.stderr, 'second stderr\n');
    fs.closeSync(logs.stdout);
    fs.closeSync(logs.stderr);
    const retrySnapshot = writeJsonArtifact(snapshots, 'initial', { attempt: 2 });

    expect(path.basename(logs.stdoutPath)).toBe('clone-attempt-2.stdout.log');
    expect(path.basename(logs.stderrPath)).toBe('clone-attempt-2.stderr.log');
    expect(path.basename(retrySnapshot)).toBe('initial-attempt-2.json');
    expect(fs.readFileSync(path.join(commands, 'clone.stdout.log'), 'utf8')).toBe('first stdout\n');
    expect(fs.readFileSync(path.join(commands, 'clone.stderr.log'), 'utf8')).toBe('first stderr\n');
    expect(fs.readFileSync(path.join(snapshots, 'initial.json'), 'utf8')).toBe('{"attempt":1}\n');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a tracked TypeScript symlink without modifying its target',
    () => {
      const root = makeTemporaryRoot();
      const worktree = path.join(root, 'worktree');
      const victim = path.join(root, 'victim.ts');
      fs.mkdirSync(worktree);
      fs.writeFileSync(victim, 'export const preserve = true;\n');
      fs.symlinkSync(victim, path.join(worktree, 'linked.ts'));

      expect(() => selectSafeTrackedFiles(worktree, ['linked.ts'], 1)).toThrow('symbolic link');
      expect(fs.readFileSync(victim, 'utf8')).toBe('export const preserve = true;\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'forwards an orchestrator signal to its owned child process tree',
    async () => {
      const root = makeTemporaryRoot();
      const pidFile = path.join(root, 'pids.json');
      const childScript = path.join(root, 'child.mjs');
      const wrapperScript = path.join(root, 'wrapper.mjs');
      const safetyModule = path.resolve(
        import.meta.dirname,
        '../../scripts/reconciliation/canary-safety.mjs',
      );
      fs.writeFileSync(
        childScript,
        `import { spawn } from 'node:child_process';\n` +
          `import fs from 'node:fs';\n` +
          `const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);\n` +
          `fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));\n` +
          `setInterval(() => {}, 1000);\n`,
      );
      fs.writeFileSync(
        wrapperScript,
        `import { once } from 'node:events';\n` +
          `import { ChildSupervisor } from ${JSON.stringify(pathToFileURL(safetyModule).href)};\n` +
          `const supervisor = new ChildSupervisor({ killTimeoutMs: 200 });\n` +
          `supervisor.installSignalHandlers();\n` +
          `const child = supervisor.spawn(process.execPath, [${JSON.stringify(childScript)}], { stdio: 'ignore' });\n` +
          `await once(child, 'close');\n` +
          `supervisor.disposeSignalHandlers();\n`,
      );

      const wrapper = spawn(process.execPath, [wrapperScript], { stdio: 'ignore' });
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(pidFile) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(fs.existsSync(pidFile)).toBe(true);
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as {
        child: number;
        grandchild: number;
      };

      wrapper.kill('SIGTERM');
      await once(wrapper, 'close');

      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const exitDeadline = Date.now() + 5_000;
      while ((isAlive(pids.child) || isAlive(pids.grandchild)) && Date.now() < exitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(isAlive(pids.child)).toBe(false);
      expect(isAlive(pids.grandchild)).toBe(false);
    },
  );
});
