/**
 * HTTP Embedding Client
 *
 * Shared fetch+retry logic for OpenAI-compatible /v1/embeddings endpoints.
 * Imported by both the core embedder (batch) and MCP embedder (query).
 *
 * Network resilience is delegated to `resilientFetch` from
 * `gitnexus-shared` — bounded retries with exponential-backoff jitter,
 * `Retry-After` honored on 429, and an in-process circuit breaker that
 * fails fast on a flapping endpoint. Per-attempt timeout is enforced
 * via `AbortSignal.timeout` on the underlying fetch.
 */

import { CircuitOpenError, ResilientFetchExhaustedError, resilientFetch } from 'gitnexus-shared';

const HTTP_TIMEOUT_MS = 30_000;
const HTTP_MAX_RETRIES = 2;
const HTTP_RETRY_BACKOFF_MS = 1_000;
const HTTP_RETRY_CAP_MS = 5_000;
const VOYAGE_HTTP_RETRY_CAP_MS = 30_000;
const HTTP_BATCH_SIZE = 64;
const DEFAULT_DIMS = 384;
const HTTP_BREAKER_KEY = 'embeddings-http';
const HTTP_RESPONSE_BODY_SNIPPET_CHARS = 500;

interface HttpConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  dimensions?: number;
  maxAttempts: number;
  minIntervalMs: number;
}

let lastHttpRequestStartedAt: number | undefined;
let httpPaceQueue: Promise<void> = Promise.resolve();

const parsePositiveIntegerEnv = (
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new Error(`${name} must be a positive integer <= ${max}, got "${raw}"`);
  }
  return parsed;
};

const parseNonNegativeIntegerEnv = (
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    throw new Error(`${name} must be a non-negative integer <= ${max}, got "${raw}"`);
  }
  return parsed;
};

/**
 * Build config from the current process.env snapshot.
 * Returns null when GITNEXUS_EMBEDDING_URL + GITNEXUS_EMBEDDING_MODEL are unset.
 * Not cached — env vars are read fresh so late configuration takes effect.
 */
const readConfig = (): HttpConfig | null => {
  const baseUrl = process.env.GITNEXUS_EMBEDDING_URL;
  const model = process.env.GITNEXUS_EMBEDDING_MODEL;
  if (!baseUrl || !model) return null;

  const rawDims = process.env.GITNEXUS_EMBEDDING_DIMS;
  let dimensions: number | undefined;
  if (rawDims !== undefined) {
    if (!/^\d+$/.test(rawDims)) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    const parsed = parseInt(rawDims, 10);
    if (parsed <= 0) {
      throw new Error(`GITNEXUS_EMBEDDING_DIMS must be a positive integer, got "${rawDims}"`);
    }
    dimensions = parsed;
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    apiKey: process.env.GITNEXUS_EMBEDDING_API_KEY ?? 'unused',
    dimensions,
    maxAttempts: parsePositiveIntegerEnv(
      'GITNEXUS_EMBEDDING_MAX_ATTEMPTS',
      HTTP_MAX_RETRIES + 1,
      20,
    ),
    minIntervalMs: parseNonNegativeIntegerEnv('GITNEXUS_EMBEDDING_MIN_INTERVAL_MS', 0, 300_000),
  };
};

/**
 * Check whether HTTP embedding mode is active (env vars are set).
 */
export const isHttpMode = (): boolean => readConfig() !== null;

export const isVoyageHttpMode = (): boolean => {
  const config = readConfig();
  if (!config) return false;
  try {
    const host = new URL(config.baseUrl).hostname.toLowerCase();
    return host === 'voyageai.com' || host.endsWith('.voyageai.com');
  } catch {
    return false;
  }
};

/**
 * Return the configured embedding dimensions for HTTP mode, or undefined
 * if HTTP mode is not active or no explicit dimensions are set.
 */
export const getHttpDimensions = (): number | undefined => readConfig()?.dimensions;

/**
 * Return a safe representation of a URL for error messages.
 * Strips query string (may contain tokens) and userinfo.
 */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<invalid-url>';
  }
};

const isVoyageUrl = (url: string): boolean => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'voyageai.com' || host.endsWith('.voyageai.com');
  } catch {
    return false;
  }
};

const retryCapMsForUrl = (url: string): number =>
  parsePositiveIntegerEnv(
    'GITNEXUS_EMBEDDING_RETRY_CAP_MS',
    isVoyageUrl(url) ? VOYAGE_HTTP_RETRY_CAP_MS : HTTP_RETRY_CAP_MS,
    300_000,
  );

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const paceHttpRequest = async (minIntervalMs: number): Promise<void> => {
  if (minIntervalMs <= 0) return;

  const waitTurn = httpPaceQueue.then(async () => {
    const now = Date.now();
    const waitMs =
      lastHttpRequestStartedAt === undefined
        ? 0
        : Math.max(0, lastHttpRequestStartedAt + minIntervalMs - now);
    if (waitMs > 0) await sleep(waitMs);
    lastHttpRequestStartedAt = Date.now();
  });
  httpPaceQueue = waitTurn.catch(() => undefined);
  await waitTurn;
};

const safeResponseSnippet = async (resp: Response): Promise<string | undefined> => {
  try {
    const clone = typeof resp.clone === 'function' ? resp.clone() : resp;
    if (typeof clone.text !== 'function') return undefined;
    const text = await clone.text();
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (!normalized) return undefined;
    return normalized.slice(0, HTTP_RESPONSE_BODY_SNIPPET_CHARS);
  } catch {
    return undefined;
  }
};

const responseDiagnostics = async (resp: Response): Promise<string> => {
  const parts: string[] = [];
  const retryAfter =
    typeof resp.headers?.get === 'function' ? resp.headers.get('Retry-After') : null;
  if (retryAfter) parts.push(`Retry-After: ${retryAfter}`);
  const requestId =
    typeof resp.headers?.get === 'function'
      ? (resp.headers.get('x-request-id') ?? resp.headers.get('x-requestid'))
      : null;
  if (requestId) parts.push(`request id: ${requestId}`);
  const snippet = await safeResponseSnippet(resp);
  if (snippet) parts.push(`body: ${snippet}`);
  return parts.length ? `; ${parts.join('; ')}` : '';
};

interface EmbeddingItem {
  embedding: number[];
}

/**
 * Send a single batch of texts to the embedding endpoint with retry.
 *
 * @param url - Full endpoint URL (e.g. https://host/v1/embeddings)
 * @param batch - Texts to embed
 * @param model - Model name for the request body
 * @param apiKey - Bearer token (only used in Authorization header)
 * @param batchIndex - Logical batch number (for error context)
 * @param dimensions - Optional output-vector size. When provided, sent as
 *   the appropriate Matryoshka field for the host:
 *     - `dimensions` for OpenAI-compatible endpoints
 *     - `output_dimension` for Voyage (voyageai.com)
 *   Leave `GITNEXUS_EMBEDDING_DIMS` unset for strict backends that reject
 *   unknown fields.
 */
const httpEmbedBatch = async (
  url: string,
  batch: string[],
  model: string,
  apiKey: string,
  batchIndex = 0,
  dimensions?: number,
  maxAttempts = HTTP_MAX_RETRIES + 1,
  minIntervalMs = 0,
): Promise<EmbeddingItem[]> => {
  const requestBody: {
    input: string[];
    model: string;
    dimensions?: number;
    output_dimension?: number;
  } = {
    input: batch,
    model,
  };
  if (dimensions !== undefined) {
    if (isVoyageUrl(url)) {
      requestBody.output_dimension = dimensions;
    } else {
      requestBody.dimensions = dimensions;
    }
  }

  let resp: Response;
  try {
    const retryCapMs = retryCapMsForUrl(url);
    resp = await resilientFetch(
      url,
      {
        method: 'POST',
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      {
        fetchImpl: async (input, init) => {
          await paceHttpRequest(minIntervalMs);
          return globalThis.fetch(input, init);
        },
        breakerKey: HTTP_BREAKER_KEY,
        retry: {
          maxAttempts,
          baseDelayMs: HTTP_RETRY_BACKOFF_MS,
          capDelayMs: retryCapMs,
          retryAfterCapMs: retryCapMs,
        },
      },
    );
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new Error(
        `Embedding endpoint circuit open (${safeUrl(url)}, batch ${batchIndex}): retry in ${Math.ceil(err.retryAfterMs / 1000)}s`,
      );
    }
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(
        `Embedding request timed out after ${HTTP_TIMEOUT_MS}ms (${safeUrl(url)}, batch ${batchIndex})`,
      );
    }
    if (err instanceof ResilientFetchExhaustedError) {
      throw new Error(
        `Embedding endpoint returned ${err.response.status} ` +
          `(${safeUrl(url)}, batch ${batchIndex})${await responseDiagnostics(err.response)}`,
      );
    }
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Embedding request failed (${safeUrl(url)}, batch ${batchIndex}): ${reason}`);
  }

  if (!resp.ok) {
    // resilientFetch already retried 5xx/429; any non-OK response here is
    // a terminal client error (4xx other than 429).
    throw new Error(
      `Embedding endpoint returned ${resp.status} ` +
        `(${safeUrl(url)}, batch ${batchIndex})${await responseDiagnostics(resp)}`,
    );
  }

  const data = (await resp.json()) as { data: EmbeddingItem[] };
  return data.data;
};

/**
 * Embed texts via the HTTP backend, splitting into batches.
 * Reads config from env vars on every call.
 *
 * @param texts - Array of texts to embed
 * @returns Array of Float32Array embedding vectors
 */
export const httpEmbed = async (texts: string[]): Promise<Float32Array[]> => {
  if (texts.length === 0) return [];

  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const allVectors: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += HTTP_BATCH_SIZE) {
    const batch = texts.slice(i, i + HTTP_BATCH_SIZE);
    const batchIndex = Math.floor(i / HTTP_BATCH_SIZE);
    const items = await httpEmbedBatch(
      url,
      batch,
      config.model,
      config.apiKey,
      batchIndex,
      config.dimensions,
      config.maxAttempts,
      config.minIntervalMs,
    );

    if (items.length !== batch.length) {
      throw new Error(
        `Embedding endpoint returned ${items.length} vectors for ${batch.length} texts ` +
          `(${safeUrl(url)}, batch ${batchIndex})`,
      );
    }

    for (const item of items) {
      const vec = new Float32Array(item.embedding);
      // Fail fast on dimension mismatch rather than inserting bad vectors
      // into the FLOAT[N] column which would cause a cryptic Kuzu error.
      const expected = config.dimensions ?? DEFAULT_DIMS;
      if (vec.length !== expected) {
        const hint = config.dimensions
          ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
          : `Set GITNEXUS_EMBEDDING_DIMS=${vec.length} to match your model output.`;
        throw new Error(
          `Embedding dimension mismatch: endpoint returned ${vec.length}d vector, ` +
            `but expected ${expected}d. ${hint}`,
        );
      }

      allVectors.push(vec);
    }
  }

  return allVectors;
};

/**
 * Embed a single query text via the HTTP backend.
 * Convenience for MCP search where only one vector is needed.
 *
 * @param text - Query text to embed
 * @returns Embedding vector as number array
 */
export const httpEmbedQuery = async (text: string): Promise<number[]> => {
  const config = readConfig();
  if (!config) throw new Error('HTTP embedding not configured');

  const url = `${config.baseUrl}/embeddings`;
  const items = await httpEmbedBatch(
    url,
    [text],
    config.model,
    config.apiKey,
    0,
    config.dimensions,
    config.maxAttempts,
    config.minIntervalMs,
  );
  if (!items.length) {
    throw new Error(`Embedding endpoint returned empty response (${safeUrl(url)})`);
  }

  const embedding = items[0].embedding;
  // Same dimension checks as httpEmbed — catch mismatches before they
  // reach the Kuzu FLOAT[N] cast in search queries.
  const expected = config.dimensions ?? DEFAULT_DIMS;
  if (embedding.length !== expected) {
    const hint = config.dimensions
      ? 'Update GITNEXUS_EMBEDDING_DIMS to match your model output.'
      : `Set GITNEXUS_EMBEDDING_DIMS=${embedding.length} to match your model output.`;
    throw new Error(
      `Embedding dimension mismatch: endpoint returned ${embedding.length}d vector, ` +
        `but expected ${expected}d. ${hint}`,
    );
  }
  return embedding;
};
