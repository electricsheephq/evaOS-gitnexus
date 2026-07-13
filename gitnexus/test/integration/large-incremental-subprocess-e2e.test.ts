import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  readEmbeddingNodeIds,
  seedEmbeddingsForFiles,
  stampEmbeddingCount,
} from '../helpers/embedding-seed.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const childRunner = path.resolve(testDir, '../fixtures/large-incremental-child.mjs');

type HarnessResult = {
  stats: Record<string, number>;
  capabilities: Record<string, unknown>;
  logs: string[];
  sidecars: string[];
  lastCommit: string;
};

const childEnv = (gitnexusHome: string): NodeJS.ProcessEnv => ({
  ...process.env,
  CI: '1',
  NODE_ENV: 'test',
  GITNEXUS_HOME: gitnexusHome,
  GITNEXUS_LBUG_EXTENSION_INSTALL: 'never',
  GITNEXUS_WORKER_POOL_SIZE: '2',
  GITNEXUS_PARSE_CHUNK_CONCURRENCY: '1',
});

const commitAll = (repoPath: string, message: string): void => {
  for (const args of [
    ['add', '-A'],
    [
      '-c',
      'user.name=GitNexus Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    ],
  ]) {
    const result = spawnSync('git', args, { cwd: repoPath, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }
};

const setupLargeRepo = (): { root: string; repoPath: string; gitnexusHome: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-large-incremental-'));
  const repoPath = path.join(root, 'repo');
  const gitnexusHome = path.join(root, 'home');
  const src = path.join(repoPath, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(gitnexusHome, { recursive: true });

  fs.writeFileSync(
    path.join(src, 'hub.ts'),
    'export function hubValue(value: number): number {\n  return value + 1;\n}\n',
  );
  for (let index = 0; index < 60; index++) {
    const suffix = String(index).padStart(3, '0');
    fs.writeFileSync(
      path.join(src, `spoke-${suffix}.ts`),
      `import { hubValue } from './hub';\n\nexport function spoke${index}(): number {\n  return hubValue(${index});\n}\n`,
    );
  }

  expect(spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath }).status).toBe(0);
  commitAll(repoPath, 'initial large fixture');
  return { root, repoPath, gitnexusHome };
};

const parseHarnessResult = (stdout: string): HarnessResult => {
  const line = stdout
    .split(/\r?\n/)
    .findLast((candidate) => candidate.startsWith('HARNESS_RESULT='));
  if (!line) throw new Error(`child produced no HARNESS_RESULT payload:\n${stdout}`);
  return JSON.parse(line.slice('HARNESS_RESULT='.length)) as HarnessResult;
};

const runChild = (repoPath: string, gitnexusHome: string, args: string[] = []): HarnessResult => {
  const result = spawnSync(process.execPath, [childRunner, repoPath, ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    env: childEnv(gitnexusHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(result.error).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return parseHarnessResult(result.stdout);
};

const waitForFile = async (filePath: string, child: ChildProcess): Promise<void> => {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`child exited before reaching the pause point: ${child.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for the incremental pause point');
};

const stopChild = async (
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('child did not terminate after SIGTERM')),
      30_000,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill('SIGTERM');
  });

const readEmbeddingDimensions = async (repoPath: string): Promise<number[]> => {
  const adapter = await import('../../src/core/lbug/lbug-adapter.js');
  const { lbugPath } = getStoragePaths(repoPath);
  await adapter.initLbug(lbugPath);
  try {
    const rows = (await adapter.executeQuery(
      'MATCH (e:CodeEmbedding) RETURN DISTINCT size(e.embedding) AS dimensions ORDER BY dimensions',
    )) as Array<{ dimensions: number | bigint }>;
    return rows.map((row) => Number(row.dimensions));
  } finally {
    await adapter.closeLbug();
  }
};

describe('large incremental analysis subprocess contract', () => {
  it('surfaces process failure and recovers add/edit/rename/delete plus importer closure and embeddings', async () => {
    expect(fs.existsSync(childRunner), `missing child runner: ${childRunner}`).toBe(true);
    const fixture = setupLargeRepo();
    try {
      const initial = runChild(fixture.repoPath, fixture.gitnexusHome);
      expect(initial.stats.files).toBe(61);
      expect(initial.stats.nodes).toBeGreaterThan(61);

      const seedFiles = [
        'src/hub.ts',
        'src/spoke-000.ts',
        'src/spoke-001.ts',
        'src/spoke-002.ts',
        'src/spoke-003.ts',
        'src/spoke-004.ts',
      ];
      const seeded = await seedEmbeddingsForFiles(fixture.repoPath, seedFiles, 1);
      const seededIds = [...seeded.values()].flat();
      expect(seededIds).toHaveLength(seedFiles.length);
      const { storagePath } = getStoragePaths(fixture.repoPath);
      await stampEmbeddingCount(storagePath, seededIds.length);

      const src = path.join(fixture.repoPath, 'src');
      fs.appendFileSync(path.join(src, 'hub.ts'), '\n// importer-closure edit\n');
      fs.renameSync(path.join(src, 'spoke-002.ts'), path.join(src, 'renamed-spoke.ts'));
      fs.rmSync(path.join(src, 'spoke-001.ts'));
      fs.writeFileSync(
        path.join(src, 'added.ts'),
        "import { hubValue } from './hub';\nexport const added = hubValue(99);\n",
      );
      commitAll(fixture.repoPath, 'exercise incremental write set');

      const readyFile = path.join(fixture.root, 'pause-ready.json');
      const interrupted = spawn(
        process.execPath,
        [childRunner, fixture.repoPath, '--pause-on-escalation', readyFile],
        {
          env: childEnv(fixture.gitnexusHome),
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      await waitForFile(readyFile, interrupted);
      const pauseState = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as {
        message: string;
        dirty: { phase?: string; effectiveWriteCount?: number; deleteCount?: number };
      };
      expect(pauseState.message).toContain('switching to a full DB write');
      expect(pauseState.dirty.phase).toBe('effective-write-set');
      expect(pauseState.dirty.effectiveWriteCount).toBeGreaterThanOrEqual(50);
      expect(pauseState.dirty.deleteCount).toBeGreaterThanOrEqual(50);

      const stopped = await stopChild(interrupted);
      expect(stopped.code).not.toBe(0);
      expect(stopped.signal).toBe('SIGTERM');
      const dirtyMeta = await loadMeta(storagePath);
      expect(dirtyMeta?.incrementalInProgress).toBeDefined();

      const recovered = runChild(fixture.repoPath, fixture.gitnexusHome);
      expect(recovered.logs.join('\n')).toContain(
        'Previous analyze run did not complete cleanly (incrementalInProgress flag set)',
      );
      const recoveredMeta = await loadMeta(storagePath);
      expect(recoveredMeta?.incrementalInProgress).toBeUndefined();
      expect(recovered.stats.files).toBe(61);
      expect(recovered.stats.nodes).toBeGreaterThan(61);
      expect(recovered.capabilities).toHaveProperty('fts');
      expect(recovered.capabilities).toHaveProperty('vectorSearch');
      expect(Array.isArray(recovered.sidecars)).toBe(true);

      const survivingEmbeddingIds = await readEmbeddingNodeIds(fixture.repoPath);
      expect(survivingEmbeddingIds.length).toBeGreaterThanOrEqual(4);
      expect(recovered.stats.embeddings).toBe(survivingEmbeddingIds.length);
      expect(survivingEmbeddingIds).not.toContain(seeded.get('src/spoke-001.ts')?.[0]);
      expect(survivingEmbeddingIds).not.toContain(seeded.get('src/spoke-002.ts')?.[0]);
      expect(await readEmbeddingDimensions(fixture.repoPath)).toEqual([384]);

      const forced = runChild(fixture.repoPath, fixture.gitnexusHome, ['--force']);
      expect(forced.stats).toEqual(recovered.stats);
      expect(await readEmbeddingNodeIds(fixture.repoPath)).toEqual(survivingEmbeddingIds);
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 600_000);
});
