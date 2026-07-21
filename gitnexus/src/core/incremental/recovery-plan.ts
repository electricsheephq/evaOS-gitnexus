import fs from 'node:fs/promises';
import path from 'node:path';
import { getStoragePaths, loadMeta, type RepoMeta } from '../../storage/repo-manager.js';

export interface RecoveryPlan {
  repoPath: string;
  state: 'unindexed' | 'clean' | 'interrupted';
  lastSuccessfulCommit: string | null;
  attemptedTargetCommit: string | null;
  dirty: RepoMeta['incrementalInProgress'] | null;
  graph: { path: string; exists: boolean; bytes: number | null };
  wal: { sidecars: string[] };
  fts: { recordedStatus: string };
  metadata: { path: string; exists: boolean };
  embeddings: { recordedCount: number | null };
}

async function regularFileSize(filePath: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

export async function buildRecoveryPlan(repoPath: string): Promise<RecoveryPlan> {
  const resolvedRepoPath = path.resolve(repoPath);
  const { storagePath, metaPath, lbugPath } = getStoragePaths(resolvedRepoPath);
  const meta = await loadMeta(storagePath);
  const graphBytes = await regularFileSize(lbugPath);
  let sidecars: string[] = [];
  try {
    const graphName = path.basename(lbugPath);
    sidecars = (await fs.readdir(path.dirname(lbugPath)))
      .filter((name) => name.startsWith(`${graphName}.`))
      .sort();
  } catch {
    sidecars = [];
  }

  const dirty = meta?.incrementalInProgress ?? null;
  return {
    repoPath: resolvedRepoPath,
    state: !meta ? 'unindexed' : dirty ? 'interrupted' : 'clean',
    lastSuccessfulCommit: meta?.lastCommit || null,
    attemptedTargetCommit:
      dirty && typeof dirty === 'object' && typeof dirty.targetCommit === 'string'
        ? dirty.targetCommit
        : null,
    dirty,
    graph: { path: lbugPath, exists: graphBytes !== null, bytes: graphBytes },
    wal: { sidecars },
    fts: { recordedStatus: meta?.capabilities?.fts?.status ?? 'unknown' },
    metadata: { path: metaPath, exists: meta !== null },
    embeddings: { recordedCount: meta?.stats?.embeddings ?? null },
  };
}

const dirtySummary = (dirty: RepoMeta['incrementalInProgress'] | null): string => {
  if (!dirty) return 'none';
  if (typeof dirty !== 'object') return 'legacy marker';
  return [
    dirty.phase ? `phase=${dirty.phase}` : 'phase=unknown',
    `toWrite=${dirty.toWriteCount}`,
    dirty.effectiveWriteCount === undefined ? null : `effectiveWrite=${dirty.effectiveWriteCount}`,
    dirty.deleteCount === undefined ? null : `deleteCount=${dirty.deleteCount}`,
  ]
    .filter((value): value is string => value !== null)
    .join(', ');
};

export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const embeddingCount = plan.embeddings.recordedCount ?? 'unknown';
  const sidecarCount = plan.wal.sidecars.length;
  const lines = [
    'GitNexus recovery plan (read-only)',
    `Repository: ${plan.repoPath}`,
    `State: ${plan.state}`,
    `Last successful commit: ${plan.lastSuccessfulCommit ?? 'unknown'}`,
    `Attempted target commit: ${plan.attemptedTargetCommit ?? 'unknown (legacy marker)'}`,
    `Dirty marker: ${dirtySummary(plan.dirty)}`,
    `Graph: preserve ${plan.graph.path}; ${plan.graph.exists ? `${plan.graph.bytes} bytes recorded` : 'graph file missing'}; do not wipe or open in plan mode.`,
    `WAL: leave ${sidecarCount} sidecar${sidecarCount === 1 ? '' : 's'} untouched (${plan.wal.sidecars.join(', ') || 'none observed'}); do not checkpoint, replay, quarantine, or delete in plan mode.`,
    `FTS: preserve derived indexes (recorded status: ${plan.fts.recordedStatus}); verify only after a safe recovery completes.`,
    `Metadata: ${plan.dirty ? 'retain the dirty marker until recovery is verified' : 'leave clean metadata unchanged'} at ${plan.metadata.path}.`,
    `Embeddings: preserve ${embeddingCount} recorded rows; do not drop or regenerate them in plan mode.`,
  ];
  if (plan.state === 'interrupted') {
    lines.push(
      'Next action: keep the original index untouched, test recovery on a disposable copy, or run normal analyze only when a full rebuild is explicitly acceptable. `analyze --incremental-only` will refuse this dirty state.',
    );
  } else if (plan.state === 'unindexed') {
    lines.push('Next action: no existing index is available for preservation-only recovery.');
  } else {
    lines.push('Next action: no interrupted-analysis recovery is required.');
  }
  return lines.join('\n');
}
