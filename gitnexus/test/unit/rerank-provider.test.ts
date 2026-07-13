import { describe, expect, it, vi } from 'vitest';

import {
  rerankDocuments,
  type RerankProvider,
} from '../../src/core/rerank/provider.js';

const documents = ['first', 'second', 'third'];

describe('rerankDocuments', () => {
  it('normalizes a deterministic provider result by score and index', async () => {
    const provider: RerankProvider = {
      id: 'deterministic-test',
      rerank: vi.fn().mockResolvedValue([
        { index: 0, score: 0.2 },
        { index: 2, score: 0.9 },
        { index: 1, score: 0.9 },
      ]),
    };

    await expect(rerankDocuments(provider, { query: 'needle', documents })).resolves.toEqual([
      { index: 1, score: 0.9 },
      { index: 2, score: 0.9 },
      { index: 0, score: 0.2 },
    ]);
  });

  it.each([
    ['non-array response', null],
    ['out-of-range index', [{ index: 3, score: 0.5 }]],
    ['duplicate index', [{ index: 1, score: 0.5 }, { index: 1, score: 0.4 }]],
    ['non-finite score', [{ index: 0, score: Number.NaN }]],
  ])('rejects malformed provider output: %s', async (_label, output) => {
    const provider = {
      id: 'malformed-test',
      rerank: vi.fn().mockResolvedValue(output),
    } as unknown as RerankProvider;

    await expect(rerankDocuments(provider, { query: 'needle', documents })).rejects.toThrow(
      /malformed/i,
    );
  });

  it('returns the original documents without invoking a provider when the list is empty', async () => {
    const provider: RerankProvider = {
      id: 'unused-test',
      rerank: vi.fn(),
    };

    await expect(rerankDocuments(provider, { query: 'needle', documents: [] })).resolves.toEqual(
      [],
    );
    expect(provider.rerank).not.toHaveBeenCalled();
  });
});
