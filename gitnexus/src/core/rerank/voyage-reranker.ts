import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';

const DEFAULT_RERANK_URL = 'https://api.voyageai.com/v1';
const DEFAULT_RERANK_MODEL = 'rerank-2.5';
const DEFAULT_RERANK_CANDIDATES = 40;
const DEFAULT_RERANK_MAX_DOC_CHARS = 3000;
const RERANK_TIMEOUT_MS = 30_000;
const RERANK_MAX_RETRIES = 1;
const RERANK_RETRY_BACKOFF_MS = 750;
const RERANK_BREAKER_KEY = 'voyage-rerank';

export interface RerankConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  candidates: number;
  maxDocChars: number;
}

export interface RerankResult {
  index: number;
  relevance_score: number;
}

function normalizePremiumRepoName(name: string): string {
  return name.trim().toLowerCase();
}

export function premiumRepoAllowed(repoName: string): boolean {
  const raw = process.env.GITNEXUS_PREMIUM_REPO_ALLOWLIST ?? '';
  const normalizedRepoName = normalizePremiumRepoName(repoName);
  const names = raw.split(',').map(normalizePremiumRepoName).filter(Boolean);
  return names.includes(normalizedRepoName);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

export function resolveRerankConfig(repoName: string): RerankConfig | null {
  if (process.env.GITNEXUS_RERANK_ENABLED !== '1') return null;
  if (!premiumRepoAllowed(repoName)) return null;

  const apiKey = process.env.GITNEXUS_RERANK_API_KEY || process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('rerank is enabled for this repo, but no Voyage rerank API key is configured');
  }

  return {
    baseUrl: (process.env.GITNEXUS_RERANK_URL || DEFAULT_RERANK_URL).replace(/\/+$/, ''),
    model: process.env.GITNEXUS_RERANK_MODEL || DEFAULT_RERANK_MODEL,
    apiKey,
    candidates: positiveIntegerEnv('GITNEXUS_RERANK_CANDIDATES', DEFAULT_RERANK_CANDIDATES),
    maxDocChars: positiveIntegerEnv('GITNEXUS_RERANK_MAX_DOC_CHARS', DEFAULT_RERANK_MAX_DOC_CHARS),
  };
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

export async function rerankDocuments(
  query: string,
  documents: string[],
  config: RerankConfig,
): Promise<RerankResult[]> {
  if (documents.length === 0) return [];

  const url = `${config.baseUrl}/rerank`;
  let resp: Response;
  try {
    resp = await resilientFetch(
      url,
      {
        method: 'POST',
        signal: AbortSignal.timeout(RERANK_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          query,
          documents,
          model: config.model,
          top_k: documents.length,
          return_documents: false,
          truncation: true,
        }),
      },
      {
        breakerKey: RERANK_BREAKER_KEY,
        retry: { maxAttempts: RERANK_MAX_RETRIES + 1, baseDelayMs: RERANK_RETRY_BACKOFF_MS },
      },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new Error(
        `Rerank endpoint circuit open (${safeUrl(url)}): retry in ${Math.ceil(err.retryAfterMs / 1000)}s`,
      );
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Rerank request timed out after ${RERANK_TIMEOUT_MS}ms (${safeUrl(url)})`);
    }
    if (err instanceof ResilientFetchExhaustedError) {
      throw new Error(`Rerank endpoint returned ${err.response.status} (${safeUrl(url)})`);
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Rerank request failed (${safeUrl(url)}): ${reason}`);
  }

  if (!resp.ok) {
    throw new Error(`Rerank endpoint returned ${resp.status} (${safeUrl(url)})`);
  }

  const payload = (await resp.json()) as {
    data?: RerankResult[];
    results?: RerankResult[];
  };
  const results = payload.data ?? payload.results ?? [];
  return results.filter(
    (result) =>
      Number.isInteger(result.index) &&
      result.index >= 0 &&
      result.index < documents.length &&
      typeof result.relevance_score === 'number',
  );
}
