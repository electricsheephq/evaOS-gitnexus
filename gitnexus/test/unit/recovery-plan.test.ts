import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../../src/cli/doctor.js';
import { buildRecoveryPlan, formatRecoveryPlan } from '../../src/core/incremental/recovery-plan.js';
import { getStoragePaths, loadMeta, saveMeta } from '../../src/storage/repo-manager.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('recovery plan', () => {
  it('reports dirty graph, WAL, FTS, metadata, and embedding actions without writing', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-recovery-plan-'));
    temporaryRoots.push(repoPath);
    const { storagePath, metaPath, lbugPath } = getStoragePaths(repoPath);
    await fs.mkdir(storagePath, { recursive: true });
    await fs.writeFile(lbugPath, 'graph-bytes', 'utf8');
    await fs.writeFile(`${lbugPath}.wal`, 'wal-bytes', 'utf8');
    await saveMeta(storagePath, {
      repoPath,
      lastCommit: 'last-good-commit',
      indexedAt: '2026-07-13T00:00:00.000Z',
      stats: { files: 61, nodes: 244, embeddings: 61 },
      incrementalInProgress: {
        startedAt: 1_700_000_000_000,
        updatedAt: 1_700_000_001_000,
        targetCommit: 'attempted-target-commit',
        toWriteCount: 12,
        phase: 'delete-nodes',
        effectiveWriteCount: 17,
        deleteCount: 19,
      },
    });
    const metadataBefore = await fs.readFile(metaPath, 'utf8');
    const walBefore = await fs.readFile(`${lbugPath}.wal`, 'utf8');

    const plan = await buildRecoveryPlan(repoPath);
    const rendered = formatRecoveryPlan(plan);

    expect(plan.state).toBe('interrupted');
    expect(plan.attemptedTargetCommit).toBe('attempted-target-commit');
    expect(plan.graph.exists).toBe(true);
    expect(plan.wal.sidecars).toEqual([path.basename(`${lbugPath}.wal`)]);
    expect(plan.embeddings.recordedCount).toBe(61);
    expect(rendered).toContain('phase=delete-nodes');
    expect(rendered).toContain('Attempted target commit: attempted-target-commit');
    expect(rendered).toContain('Graph: preserve');
    expect(rendered).toContain('WAL: leave 1 sidecar');
    expect(rendered).toContain('FTS: preserve derived indexes');
    expect(rendered).toContain('Metadata: retain the dirty marker');
    expect(rendered).toContain('Embeddings: preserve 61 recorded rows');
    expect(await fs.readFile(metaPath, 'utf8')).toBe(metadataBefore);
    expect(await fs.readFile(`${lbugPath}.wal`, 'utf8')).toBe(walBefore);
  });

  it('doctor prints the recovery plan and returns before native probes', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-doctor-plan-'));
    temporaryRoots.push(repoPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(doctorCommand(repoPath, { recoveryPlan: true })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain('GitNexus recovery plan (read-only)');
    expect(log.mock.calls[0]?.[0]).toContain(`Repository: ${repoPath}`);
    expect(log.mock.calls[0]?.[0]).toContain('State: unindexed');
  });

  it('treats a missing nested FTS capability in legacy metadata as unknown', async () => {
    const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-recovery-legacy-'));
    temporaryRoots.push(repoPath);
    const { storagePath, metaPath } = getStoragePaths(repoPath);
    await fs.mkdir(storagePath, { recursive: true });
    const rawLegacyMeta = JSON.stringify({
      repoPath,
      lastCommit: 'legacy-commit',
      indexedAt: '2026-07-21T00:00:00.000Z',
      stats: { files: 20_492, nodes: 275_835, embeddings: 84_501 },
      capabilities: {
        vectorSearch: {
          provider: 'ladybugdb-vector',
          status: 'vector-index',
        },
      },
    });
    await fs.writeFile(metaPath, rawLegacyMeta, 'utf8');

    const loaded = await loadMeta(storagePath);
    expect(loaded?.capabilities).toEqual({
      graph: { provider: 'legacy-metadata', status: 'unavailable' },
      fts: { provider: 'legacy-metadata', status: 'unavailable' },
      vectorSearch: {
        provider: 'ladybugdb-vector',
        status: 'vector-index',
        exactScanLimit: 0,
      },
    });

    const plan = await buildRecoveryPlan(repoPath);

    expect(plan.state).toBe('clean');
    expect(plan.fts.recordedStatus).toBe('unknown');
    expect(formatRecoveryPlan(plan)).toContain(
      'FTS: preserve derived indexes (recorded status: unknown)',
    );
    expect(await fs.readFile(metaPath, 'utf8')).toBe(rawLegacyMeta);
  });
});
