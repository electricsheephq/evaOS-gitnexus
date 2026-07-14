export interface RerankRequest {
  query: string;
  documents: string[];
  signal?: AbortSignal;
}

export interface RerankScore {
  index: number;
  score: number;
}

export interface RerankProvider {
  readonly id: string;
  rerank(request: RerankRequest): Promise<RerankScore[]>;
}

export type RerankFailurePolicy = 'fallback' | 'error';

export interface RerankRuntime {
  provider: RerankProvider;
  candidates: number;
  maxDocChars: number;
  failurePolicy: RerankFailurePolicy;
}

function malformed(providerId: string, detail: string): Error {
  return new Error(`Rerank provider ${providerId} returned malformed output: ${detail}`);
}

/**
 * Invoke a provider and normalize its output at the provider boundary.
 * Backends can therefore consume one deterministic, validated contract.
 */
export async function rerankDocuments(
  provider: RerankProvider,
  request: RerankRequest,
): Promise<RerankScore[]> {
  if (request.documents.length === 0) return [];

  const raw = await provider.rerank(request);
  if (!Array.isArray(raw)) {
    throw malformed(provider.id, 'expected an array');
  }

  const seen = new Set<number>();
  const validated = raw.map((item, position) => {
    if (!item || typeof item !== 'object') {
      throw malformed(provider.id, `result ${position} is not an object`);
    }
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= request.documents.length) {
      throw malformed(provider.id, `result ${position} has an out-of-range index`);
    }
    if (seen.has(item.index)) {
      throw malformed(provider.id, `result ${position} repeats index ${item.index}`);
    }
    if (typeof item.score !== 'number' || !Number.isFinite(item.score)) {
      throw malformed(provider.id, `result ${position} has a non-finite score`);
    }
    seen.add(item.index);
    return { index: item.index, score: item.score };
  });

  return validated.sort((a, b) => b.score - a.score || a.index - b.index);
}
