import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  createEmbeddingSnapshot,
  readEmbeddingSnapshot,
  validateEmbeddingSnapshot,
} from '../../src/core/embeddings/cache-snapshot.js';
import type { CachedEmbedding } from '../../src/core/embeddings/types.js';

const tempDirs: string[] = [];

const makeRows = (count: number): CachedEmbedding[] =>
  Array.from({ length: count }, (_, index) => ({
    nodeId: `node-${index}`,
    chunkIndex: 0,
    startLine: index + 1,
    endLine: index + 1,
    embedding: [index, index + 0.25, index + 0.5, index + 0.75],
    contentHash: `hash-${index}`,
  }));

const makePath = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-embedding-snapshot-'));
  tempDirs.push(dir);
  return path.join(dir, 'snapshot.jsonl');
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('bounded embedding preservation snapshot', () => {
  it('streams 600 vectors through batches of at most 256', async () => {
    const snapshotPath = await makePath();
    const rows = makeRows(600);
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => {
      await emit(rows.slice(0, 256));
      await emit(rows.slice(256, 512));
      await emit(rows.slice(512));
    });

    await expect(validateEmbeddingSnapshot(snapshotPath, source, 600)).resolves.toEqual({
      count: 600,
      dimensions: 4,
    });
    const batchSizes: number[] = [];
    const restored: CachedEmbedding[] = [];
    await readEmbeddingSnapshot(snapshotPath, source, async (batch) => {
      batchSizes.push(batch.length);
      restored.push(...batch);
    });
    expect(batchSizes).toEqual([256, 256, 88]);
    expect(restored).toHaveLength(600);
    expect(restored[599]).toMatchObject({ nodeId: 'node-599', contentHash: 'hash-599' });
    expect(restored[599].embedding).toEqual(rows[599].embedding);
  });

  it('rejects tampering before invoking the restore callback', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(3)));
    const raw = await fs.readFile(snapshotPath, 'utf8');
    await fs.writeFile(snapshotPath, raw.replace('node-1', 'node-x'));
    const onBatch = vi.fn();

    await expect(validateEmbeddingSnapshot(snapshotPath, source)).resolves.toBeUndefined();
    await expect(readEmbeddingSnapshot(snapshotPath, source, onBatch)).rejects.toThrow(
      'failed validation',
    );
    expect(onBatch).not.toHaveBeenCalled();
  });

  it('binds a reusable snapshot to its source generation', async () => {
    const snapshotPath = await makePath();
    const source = { lastCommit: 'abc', indexedAt: '2026-07-20T00:00:00.000Z' };
    await createEmbeddingSnapshot(snapshotPath, source, async (emit) => emit(makeRows(1)));

    await expect(
      validateEmbeddingSnapshot(snapshotPath, { ...source, lastCommit: 'different' }),
    ).resolves.toBeUndefined();
  });

  it('rejects a producer batch above the 256-vector cap and removes its temp file', async () => {
    const snapshotPath = await makePath();
    await expect(
      createEmbeddingSnapshot(snapshotPath, {}, async (emit) => emit(makeRows(257))),
    ).rejects.toThrow('exceeds 256 vectors');
    await expect(fs.access(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      (await fs.readdir(path.dirname(snapshotPath))).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
  });
});
