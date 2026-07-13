import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  VoyageRerankProvider,
  resolveRerankRuntime,
} from '../../src/core/rerank/voyage-provider.js';

const baseConfig = {
  baseUrl: 'https://api.voyageai.com/v1',
  model: 'rerank-2.5',
  apiKey: 'test-api-secret',
  timeoutMs: 100,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveRerankRuntime', () => {
  it('is absent by default and does not require credentials', () => {
    expect(resolveRerankRuntime('repo', {})).toBeNull();
  });

  it('keeps a configured provider disabled outside the repository allowlist', () => {
    expect(
      resolveRerankRuntime('repo', {
        GITNEXUS_RERANK_PROVIDER: 'voyage',
        GITNEXUS_RERANK_ALLOWED_REPOS: 'other',
      }),
    ).toBeNull();
  });

  it('resolves the provider with canonical configuration and an explicit failure policy', () => {
    const runtime = resolveRerankRuntime('repo', {
      GITNEXUS_RERANK_PROVIDER: 'voyage',
      GITNEXUS_RERANK_ALLOWED_REPOS: ' REPO ',
      GITNEXUS_RERANK_API_KEY: 'key',
      GITNEXUS_RERANK_FAILURE_POLICY: 'error',
      GITNEXUS_RERANK_CANDIDATES: '12',
      GITNEXUS_RERANK_MAX_DOC_CHARS: '900',
    });

    expect(runtime).toMatchObject({
      candidates: 12,
      maxDocChars: 900,
      failurePolicy: 'error',
      provider: { id: 'voyage' },
    });
  });

  it('preserves the legacy enable and allowlist names as fork compatibility', () => {
    const runtime = resolveRerankRuntime('repo', {
      GITNEXUS_RERANK_ENABLED: '1',
      GITNEXUS_PREMIUM_REPO_ALLOWLIST: 'repo',
      VOYAGE_API_KEY: 'legacy-key',
    });

    expect(runtime?.provider.id).toBe('voyage');
  });

  it.each([
    [{ GITNEXUS_RERANK_PROVIDER: 'unknown', GITNEXUS_RERANK_ALLOWED_REPOS: 'repo' }, /provider/i],
    [{ GITNEXUS_RERANK_PROVIDER: 'voyage', GITNEXUS_RERANK_ALLOWED_REPOS: 'repo' }, /api key/i],
    [
      {
        GITNEXUS_RERANK_PROVIDER: 'voyage',
        GITNEXUS_RERANK_ALLOWED_REPOS: 'repo',
        GITNEXUS_RERANK_API_KEY: 'key',
        GITNEXUS_RERANK_FAILURE_POLICY: 'maybe',
      },
      /failure policy/i,
    ],
  ])('fails explicitly for invalid enabled configuration', (env, message) => {
    expect(() => resolveRerankRuntime('repo', env)).toThrow(message);
  });
});

describe('VoyageRerankProvider', () => {
  it('maps a valid response without requiring a real network credential', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ index: 1, relevance_score: 0.8 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new VoyageRerankProvider(baseConfig, fetchImpl as typeof fetch);

    await expect(provider.rerank({ query: 'needle', documents: ['a', 'b'] })).resolves.toEqual([
      { index: 1, score: 0.8 },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces timeout without retrying', async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const provider = new VoyageRerankProvider(
      { ...baseConfig, timeoutMs: 5 },
      fetchImpl as typeof fetch,
    );

    await expect(provider.rerank({ query: 'needle', documents: ['a'] })).rejects.toThrow(
      /timed out/i,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed provider payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: 'wrong' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const provider = new VoyageRerankProvider(baseConfig, fetchImpl as typeof fetch);

    await expect(provider.rerank({ query: 'needle', documents: ['a'] })).rejects.toThrow(
      /unexpected response shape/i,
    );
  });

  it('redacts URL credentials and API keys from surfaced transport errors', async () => {
    const credentialUrl = 'https://url-user:url-secret@example.test/v1';
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(
        new Error(`request ${credentialUrl}/rerank failed with ${baseConfig.apiKey}`),
      );
    const provider = new VoyageRerankProvider(
      { ...baseConfig, baseUrl: credentialUrl },
      fetchImpl as typeof fetch,
    );

    let caught: unknown;
    try {
      await provider.rerank({ query: 'needle', documents: ['a'] });
    } catch (error) {
      caught = error;
    }

    const serialized = String(caught);
    expect(serialized).toContain('example.test/v1/rerank');
    expect(serialized).not.toContain('url-secret');
    expect(serialized).not.toContain(baseConfig.apiKey);
  });
});
