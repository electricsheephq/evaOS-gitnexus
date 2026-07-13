import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ALL_RECOVERY_BOUNDARIES,
  createHermeticProcessEnv,
  selectRecoveryBoundaries,
  startReadyProcess,
  terminateChild,
} from '../helpers/large-incremental-contract.js';

const temporaryRoots: string[] = [];

const makeTemporaryRoot = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-large-contract-'));
  temporaryRoots.push(root);
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('large incremental subprocess isolation', () => {
  it('passes only portable process keys into an isolated home', () => {
    const home = makeTemporaryRoot();
    const env = createHermeticProcessEnv(
      {
        PATH: '/safe/bin',
        LANG: 'C.UTF-8',
        SSH_AUTH_SOCK: '/private/agent.sock',
        GITHUB_TOKEN: 'must-not-leak',
        NODE_OPTIONS: '--require private-hook.cjs',
        HTTPS_PROXY: 'http://user:secret@example.invalid',
      },
      home,
      { NODE_ENV: 'test', GITNEXUS_HOME: path.join(home, '.gitnexus') },
      'linux',
    );

    expect(env).toMatchObject({
      PATH: '/safe/bin',
      LANG: 'C.UTF-8',
      HOME: home,
      USERPROFILE: home,
      CI: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      NODE_ENV: 'test',
      GITNEXUS_HOME: path.join(home, '.gitnexus'),
    });
    expect(env).not.toHaveProperty('SSH_AUTH_SOCK');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env).not.toHaveProperty('HTTPS_PROXY');
  });

  it.skipIf(process.platform === 'win32')(
    'kills and reaps a child that never emits readiness',
    async () => {
      const home = makeTemporaryRoot();
      const pidFile = path.join(home, 'child.pid');
      const script =
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); " +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

      await expect(
        startReadyProcess({
          command: process.execPath,
          args: ['-e', script, pidFile],
          env: createHermeticProcessEnv(process.env, home, {}, process.platform),
          readyPrefix: 'READY=',
          timeoutMs: 100,
          terminateGraceMs: 100,
        }),
      ).rejects.toThrow('did not become ready');

      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it.skipIf(process.platform === 'win32')(
    'escalates a signal-resistant child to SIGKILL',
    async () => {
      const home = makeTemporaryRoot();
      const readyScript =
        "process.on('SIGTERM', () => {}); process.stdout.write('READY=ok\\n'); " +
        'setInterval(() => {}, 1000);';
      const ready = await startReadyProcess({
        command: process.execPath,
        args: ['-e', readyScript],
        env: createHermeticProcessEnv(process.env, home, {}, process.platform),
        readyPrefix: 'READY=',
        timeoutMs: 1_000,
      });

      await expect(terminateChild(ready.child, 100)).resolves.toEqual({
        code: null,
        signal: 'SIGKILL',
      });
      const pid = ready.child.pid;
      expect(pid).toBeDefined();
      if (!pid) throw new Error('ready child did not expose a pid');
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );
});

describe('large incremental recovery boundary selection', () => {
  it('runs every durable interruption boundary by default', () => {
    expect(selectRecoveryBoundaries(undefined)).toEqual(ALL_RECOVERY_BOUNDARIES);
  });

  it('accepts an explicit bounded subset for the cross-platform matrix', () => {
    expect(selectRecoveryBoundaries('during-delete,before-finalize,during-delete')).toEqual([
      'during-delete',
      'before-finalize',
    ]);
  });

  it('rejects empty or unknown boundary configuration', () => {
    expect(() => selectRecoveryBoundaries('  ')).toThrow('must name at least one');
    expect(() => selectRecoveryBoundaries('during-delete,unknown')).toThrow('unknown');
  });
});
