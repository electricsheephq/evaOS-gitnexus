/**
 * Tests that MCP semantic search surfaces a pruned/unloadable optional embedding
 * stack once instead of silently degrading to BM25 (#2372) — the silent-
 * degradation mode #2370 exists to fix. executeQuery is mocked to report a
 * populated embedding table so execution reaches the embedder import, which is
 * mocked to throw the missing-stack message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { _captureLogger, type LoggerCapture } from '../../src/core/logger.js';
import { localEmbeddingStackMissingMessage } from '../../src/core/embeddings/runtime-support.js';

const executeQueryMock = vi.fn();
const embedQueryMock = vi.fn();

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>()),
  executeQuery: (...args: unknown[]) => executeQueryMock(...args),
}));
vi.mock('../../src/mcp/core/embedder.js', () => ({
  embedQuery: (...args: unknown[]) => embedQueryMock(...args),
  getEmbeddingDims: () => 384,
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';

interface SemanticSearchOutcome {
  results: unknown[];
  mode: string;
  embeddingCount: number | null;
  reason: string | null;
  exactScanLimit: number;
  omitted: boolean;
}

interface SemanticSearchable {
  semanticSearch(
    repo: { lbugPath: string },
    query: string,
    limit: number,
  ): Promise<SemanticSearchOutcome>;
}
const callSemanticSearch = (b: LocalBackend): Promise<SemanticSearchOutcome> =>
  (b as unknown as SemanticSearchable).semanticSearch({ lbugPath: '/tmp/x' }, 'q', 5);

const unavailableEmbeddingQuery = {
  results: [],
  mode: 'unavailable',
  embeddingCount: 5,
  reason: 'embedding-query-failed',
  exactScanLimit: expect.any(Number),
  omitted: true,
};

const stackWarns = (cap: LoggerCapture): number =>
  cap
    .records()
    .filter(
      (r) =>
        typeof r.msg === 'string' &&
        r.msg.includes('query:vector') &&
        r.msg.includes('optional embedding stack'),
    ).length;

describe('LocalBackend.semanticSearch — missing-stack warning (#2372)', () => {
  beforeEach(() => {
    executeQueryMock.mockReset().mockResolvedValue([{ cnt: 5 }]);
    embedQueryMock.mockReset();
  });

  it('warns once with the actionable message and reports omission on a pruned stack', async () => {
    embedQueryMock.mockRejectedValue(new Error(localEmbeddingStackMissingMessage()));
    const backend = new LocalBackend();
    const cap = _captureLogger();
    try {
      expect(await callSemanticSearch(backend)).toMatchObject(unavailableEmbeddingQuery);
      expect(await callSemanticSearch(backend)).toMatchObject(unavailableEmbeddingQuery);
      expect(stackWarns(cap)).toBe(1); // once per LocalBackend instance
    } finally {
      cap.restore();
    }
  });

  it('stays silent for an unrelated error', async () => {
    embedQueryMock.mockRejectedValue(new Error('some unrelated failure'));
    const backend = new LocalBackend();
    const cap = _captureLogger();
    try {
      expect(await callSemanticSearch(backend)).toMatchObject(unavailableEmbeddingQuery);
      expect(stackWarns(cap)).toBe(0);
    } finally {
      cap.restore();
    }
  });
});
