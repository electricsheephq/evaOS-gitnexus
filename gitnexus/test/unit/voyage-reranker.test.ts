import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = [
  'GITNEXUS_RERANK_ENABLED',
  'GITNEXUS_RERANK_URL',
  'GITNEXUS_RERANK_MODEL',
  'GITNEXUS_RERANK_API_KEY',
  'VOYAGE_API_KEY',
  'GITNEXUS_RERANK_CANDIDATES',
  'GITNEXUS_RERANK_MAX_DOC_CHARS',
  'GITNEXUS_PREMIUM_REPO_ALLOWLIST',
] as const;

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe('Voyage reranker config', () => {
  it('stays disabled unless rerank and the premium repo allowlist both match', async () => {
    const { resolveRerankConfig } = await import('../../src/core/rerank/voyage-reranker.js');

    expect(resolveRerankConfig('gitnexus')).toBeNull();

    process.env.GITNEXUS_RERANK_ENABLED = '1';
    process.env.GITNEXUS_RERANK_API_KEY = 'test-rerank-key';
    expect(resolveRerankConfig('gitnexus')).toBeNull();

    process.env.GITNEXUS_PREMIUM_REPO_ALLOWLIST = 'lossless-claw,gitnexus';
    const config = resolveRerankConfig('gitnexus');
    expect(config).toMatchObject({
      baseUrl: 'https://api.voyageai.com/v1',
      model: 'rerank-2.5',
      candidates: 40,
      maxDocChars: 3000,
    });
  });

  it('requires a key only after rerank is enabled for an allowlisted repo', async () => {
    process.env.GITNEXUS_RERANK_ENABLED = '1';
    process.env.GITNEXUS_PREMIUM_REPO_ALLOWLIST = 'gitnexus';

    const { resolveRerankConfig } = await import('../../src/core/rerank/voyage-reranker.js');
    expect(() => resolveRerankConfig('gitnexus')).toThrow(/no Voyage rerank API key/i);
  });
});

describe('Voyage reranker client', () => {
  it('posts Voyage-compatible payload and returns ranked indices', async () => {
    const redactionProbeKey = 'test-rerank-key-redaction-check';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerankDocuments } = await import('../../src/core/rerank/voyage-reranker.js');
    const results = await rerankDocuments('query', ['doc a', 'doc b'], {
      baseUrl: 'https://api.voyageai.com/v1',
      model: 'rerank-2.5',
      apiKey: redactionProbeKey,
      candidates: 40,
      maxDocChars: 3000,
    });

    expect(results.map((result) => result.index)).toEqual([1, 0]);
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({
      query: 'query',
      documents: ['doc a', 'doc b'],
      model: 'rerank-2.5',
      top_k: 2,
      return_documents: false,
      truncation: true,
    });
    expect((request.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${redactionProbeKey}`,
    );
  });

  it('does not include the bearer token in endpoint errors', async () => {
    const redactionProbeKey = 'test-rerank-key-redaction-check';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { rerankDocuments } = await import('../../src/core/rerank/voyage-reranker.js');
    try {
      await rerankDocuments('query', ['doc'], {
        baseUrl: 'https://api.voyageai.com/v1',
        model: 'rerank-2.5',
        apiKey: redactionProbeKey,
        candidates: 40,
        maxDocChars: 3000,
      });
      throw new Error('expected rerankDocuments to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(redactionProbeKey);
      expect(message).not.toContain('Authorization');
    }
  });
});
