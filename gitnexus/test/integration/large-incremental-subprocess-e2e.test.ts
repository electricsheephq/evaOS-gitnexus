import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import {
  readEmbeddingNodeIds,
  readEmbeddingRowFingerprints,
  seedEmbeddingsForFiles,
  stampEmbeddingCount,
} from '../helpers/embedding-seed.js';
import {
  createHermeticProcessEnv,
  RECOVERY_BOUNDARY_CASES,
  selectRecoveryBoundaries,
  startReadyProcess,
  terminateChild,
} from '../helpers/large-incremental-contract.js';
import { getStoragePaths, loadMeta } from '../../src/storage/repo-manager.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const childRunner = path.resolve(testDir, '../fixtures/large-incremental-child.mjs');
const embeddingServerRunner = path.resolve(
  testDir,
  '../fixtures/deterministic-embedding-server.mjs',
);

type HarnessResult = {
  stats: Record<string, number>;
  capabilities: Record<string, unknown>;
  logs: string[];
  sidecars: string[];
  lastCommit: string;
  ftsSearch?: {
    query: string;
    ftsAvailable: boolean;
    results: Array<{ filePath: string; score: number; rank: number }>;
  };
};

const childEnv = (gitnexusHome: string, embeddingUrl: string): NodeJS.ProcessEnv => {
  return createHermeticProcessEnv(process.env, gitnexusHome, {
    CI: '1',
    NODE_ENV: 'test',
    GITNEXUS_HOME: gitnexusHome,
    // The R09 contract requires FTS but must never install during the child
    // process. CI and local setup preinstall the extension; load-only fails
    // closed when that prerequisite is absent.
    GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
    GITNEXUS_WORKER_POOL_SIZE: '2',
    GITNEXUS_PARSE_CHUNK_CONCURRENCY: '1',
    // Recovery may need to regenerate embeddings after a destructive phase.
    // Keep that proof real but hermetic: a local deterministic endpoint means
    // no model download, credentials, or external network can affect the test.
    GITNEXUS_EMBEDDING_URL: embeddingUrl,
    GITNEXUS_EMBEDDING_MODEL: 'gitnexus-test-deterministic-v1',
    GITNEXUS_EMBEDDING_DIMS: '384',
    GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '1',
    GITNEXUS_EMBEDDING_RETRY_CAP_MS: '1',
    GITNEXUS_EMBEDDING_MIN_INTERVAL_MS: '0',
  });
};

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
  const installedExtensions = path.join(os.homedir(), '.lbdb', 'extension');
  if (!fs.existsSync(installedExtensions)) {
    throw new Error(
      `large incremental test requires preinstalled extensions: ${installedExtensions}`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-large-incremental-'));
  const repoPath = path.join(root, 'repo');
  const gitnexusHome = path.join(root, 'home');
  const src = path.join(repoPath, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(gitnexusHome, { recursive: true });
  fs.cpSync(installedExtensions, path.join(gitnexusHome, '.lbdb', 'extension'), {
    recursive: true,
  });

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

const runChild = (
  repoPath: string,
  gitnexusHome: string,
  embeddingUrl: string,
  args: string[] = [],
): HarnessResult => {
  const result = spawnSync(process.execPath, [childRunner, repoPath, ...args], {
    encoding: 'utf8',
    timeout: 300_000,
    env: childEnv(gitnexusHome, embeddingUrl),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(result.error).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return parseHarnessResult(result.stdout);
};

const startEmbeddingServer = async (
  isolatedHome: string,
): Promise<{ child: ChildProcess; url: string }> => {
  const ready = await startReadyProcess({
    command: process.execPath,
    args: [embeddingServerRunner],
    env: createHermeticProcessEnv(process.env, isolatedHome, { NODE_ENV: 'test' }),
    readyPrefix: 'EMBEDDING_SERVER=',
  });
  return { child: ready.child, url: ready.value };
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
    expect(
      fs.existsSync(embeddingServerRunner),
      `missing embedding server: ${embeddingServerRunner}`,
    ).toBe(true);
    const fixture = setupLargeRepo();
    let embeddingServer: Awaited<ReturnType<typeof startEmbeddingServer>> | undefined;
    try {
      embeddingServer = await startEmbeddingServer(fixture.gitnexusHome);
      const initial = runChild(fixture.repoPath, fixture.gitnexusHome, embeddingServer.url);
      expect(initial.stats.files).toBe(61);
      expect(initial.stats.nodes).toBeGreaterThan(61);

      // Exercise active FTS deletion below the escalation threshold before
      // the wide importer-closure scenario. A rename is represented as an
      // old-path delete plus a new-path insert, so LadybugDB must remove the
      // indexed File/Function rows without entering its historical FTS delete
      // crash or silently leaving stale derived state.
      const src = path.join(fixture.repoPath, 'src');
      fs.renameSync(path.join(src, 'spoke-059.ts'), path.join(src, 'r09-small-renamed.ts'));
      fs.writeFileSync(
        path.join(src, 'r09-small-renamed.ts'),
        "import { hubValue } from './hub';\nexport function r09SmallFtsNeedle(): number { return hubValue(59); }\n",
      );
      commitAll(fixture.repoPath, 'exercise active FTS row deletion');

      const smallIncremental = runChild(
        fixture.repoPath,
        fixture.gitnexusHome,
        embeddingServer.url,
        ['--fts-query', 'r09SmallFtsNeedle'],
      );
      expect(smallIncremental.logs.join('\n')).not.toContain('switching to a full DB write');
      expect(smallIncremental.stats.files).toBe(61);
      expect(smallIncremental.ftsSearch?.ftsAvailable).toBe(true);
      expect(smallIncremental.ftsSearch?.results.map((result) => result.filePath)).toContain(
        'src/r09-small-renamed.ts',
      );

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

      fs.appendFileSync(path.join(src, 'hub.ts'), '\n// importer-closure edit\n');
      fs.renameSync(path.join(src, 'spoke-002.ts'), path.join(src, 'renamed-spoke.ts'));
      fs.rmSync(path.join(src, 'spoke-001.ts'));
      fs.writeFileSync(
        path.join(src, 'added.ts'),
        "import { hubValue } from './hub';\nexport function r09FtsNeedle(): number { return hubValue(99); }\n",
      );
      commitAll(fixture.repoPath, 'exercise incremental write set');

      const selectedBoundaries = new Set(
        selectRecoveryBoundaries(process.env.GITNEXUS_RECOVERY_BOUNDARIES),
      );
      const boundaries = RECOVERY_BOUNDARY_CASES.filter(([boundary]) =>
        selectedBoundaries.has(boundary),
      );
      let recovered: HarnessResult | undefined;
      for (const [index, [boundary, expectedDirtyPhase]] of boundaries.entries()) {
        if (index > 0) {
          fs.appendFileSync(path.join(src, 'hub.ts'), `\n// ${boundary} interruption\n`);
          commitAll(fixture.repoPath, `prepare ${boundary} interruption`);
        }
        const readyFile = path.join(fixture.root, `pause-ready-${boundary}.json`);
        const interrupted = spawn(
          process.execPath,
          [childRunner, fixture.repoPath, '--pause-at', boundary, '--pause-ready', readyFile],
          {
            env: childEnv(fixture.gitnexusHome, embeddingServer.url),
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        await waitForFile(readyFile, interrupted);
        const pauseState = JSON.parse(fs.readFileSync(readyFile, 'utf8')) as {
          boundary: string;
          details: { phase?: string; removedPath?: string; table?: string };
          dirty: { phase?: string; effectiveWriteCount?: number; deleteCount?: number };
        };
        expect(pauseState.boundary).toBe(boundary);
        expect(pauseState.details.phase).toBe(expectedDirtyPhase);
        expect(pauseState.dirty.phase).toBe(expectedDirtyPhase);
        expect(pauseState.dirty.effectiveWriteCount).toBeGreaterThanOrEqual(50);
        expect(pauseState.dirty.deleteCount).toBeGreaterThanOrEqual(50);
        if (boundary === 'during-delete') {
          expect(pauseState.details.removedPath).toMatch(/lbug$/);
        }
        if (boundary === 'during-insert') {
          expect(pauseState.details.table).toBeTruthy();
        }

        const stopped = await terminateChild(interrupted);
        expect(stopped.code).not.toBe(0);
        expect(stopped.signal).toBe('SIGTERM');
        const dirtyMeta = await loadMeta(storagePath);
        expect(dirtyMeta?.incrementalInProgress?.phase).toBe(expectedDirtyPhase);

        recovered = runChild(fixture.repoPath, fixture.gitnexusHome, embeddingServer.url, [
          '--embeddings',
          '--fts-query',
          'r09FtsNeedle',
        ]);
        expect(recovered.logs.join('\n')).toContain(
          'Previous analyze run did not complete cleanly (incrementalInProgress flag set)',
        );
        expect((await loadMeta(storagePath))?.incrementalInProgress).toBeUndefined();

        const recoveredEmbeddingIds = await readEmbeddingNodeIds(fixture.repoPath);
        expect(
          recoveredEmbeddingIds.length,
          `${boundary} recovery silently lost every preserved or regenerated embedding`,
        ).toBeGreaterThanOrEqual(4);
        expect(recovered.stats.embeddings).toBe(recoveredEmbeddingIds.length);
        const recoveredEmbeddingRows = await readEmbeddingRowFingerprints(fixture.repoPath);
        const forced = runChild(fixture.repoPath, fixture.gitnexusHome, embeddingServer.url, [
          '--force',
          '--embeddings',
          '--drop-embeddings',
          '--fts-query',
          'r09FtsNeedle',
        ]);
        expect(forced.stats).toEqual(recovered.stats);
        expect(forced.ftsSearch).toEqual(recovered.ftsSearch);
        expect((await readEmbeddingNodeIds(fixture.repoPath)).toSorted()).toEqual(
          recoveredEmbeddingIds.toSorted(),
        );
        expect(await readEmbeddingRowFingerprints(fixture.repoPath)).toEqual(
          recoveredEmbeddingRows,
        );
      }
      if (!recovered) throw new Error('recovery matrix produced no successful run');
      const finalRecovered = recovered;
      const recoveredMeta = await loadMeta(storagePath);
      expect(recoveredMeta?.incrementalInProgress).toBeUndefined();
      expect(finalRecovered.stats.files).toBe(61);
      expect(finalRecovered.stats.nodes).toBeGreaterThan(61);
      expect(finalRecovered.capabilities).toHaveProperty('fts');
      expect(finalRecovered.capabilities).toHaveProperty('vectorSearch');
      expect(Array.isArray(finalRecovered.sidecars)).toBe(true);
      expect(finalRecovered.ftsSearch?.ftsAvailable).toBe(true);
      expect(finalRecovered.ftsSearch?.results.map((result) => result.filePath)).toContain(
        'src/added.ts',
      );

      const survivingEmbeddingIds = await readEmbeddingNodeIds(fixture.repoPath);
      expect(survivingEmbeddingIds.length).toBeGreaterThanOrEqual(4);
      expect(finalRecovered.stats.embeddings).toBe(survivingEmbeddingIds.length);
      expect(survivingEmbeddingIds).not.toContain(seeded.get('src/spoke-001.ts')?.[0]);
      expect(survivingEmbeddingIds).not.toContain(seeded.get('src/spoke-002.ts')?.[0]);
      expect(await readEmbeddingDimensions(fixture.repoPath)).toEqual([384]);
    } finally {
      try {
        if (
          embeddingServer &&
          embeddingServer.child.exitCode === null &&
          embeddingServer.child.signalCode === null
        ) {
          await terminateChild(embeddingServer.child);
        }
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }, 2_400_000);
});
