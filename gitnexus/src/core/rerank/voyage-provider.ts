import {
  CircuitOpenError,
  ResilientFetchExhaustedError,
  resilientFetch,
} from 'gitnexus-shared';

import {
  type RerankFailurePolicy,
  type RerankProvider,
  type RerankRequest,
  type RerankRuntime,
  type RerankScore,
} from './provider.js';

const DEFAULT_URL = 'https://api.voyageai.com/v1';
const DEFAULT_MODEL = 'rerank-2.5';
const DEFAULT_CANDIDATES = 40;
const DEFAULT_MAX_DOC_CHARS = 3000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONFIGURED_VALUE = 300_000;

interface VoyageConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
}

type RerankEnvironment = Record<string, string | undefined>;

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return '<invalid-url>';
  }
}

function sanitizeReason(reason: string, url: string, apiKey: string): string {
  return reason
    .split(url)
    .join(safeUrl(url))
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, '$1')
    .split(apiKey)
    .join('[redacted]');
}

function positiveInteger(
  env: RerankEnvironment,
  name: string,
  fallback: number,
  maximum = MAX_CONFIGURED_VALUE,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

function allowedForRepo(repoName: string, env: RerankEnvironment): boolean {
  const raw = env.GITNEXUS_RERANK_ALLOWED_REPOS ?? env.GITNEXUS_PREMIUM_REPO_ALLOWLIST ?? '';
  const normalized = repoName.trim().toLowerCase();
  return raw
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .some((name) => name === '*' || name === normalized);
}

function resolveFailurePolicy(env: RerankEnvironment): RerankFailurePolicy {
  const value = (env.GITNEXUS_RERANK_FAILURE_POLICY ?? 'fallback').trim().toLowerCase();
  if (value === 'fallback' || value === 'error') return value;
  throw new Error(
    'Rerank failure policy GITNEXUS_RERANK_FAILURE_POLICY must be "fallback" or "error"',
  );
}

function combineSignals(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class VoyageRerankProvider implements RerankProvider {
  readonly id = 'voyage';

  constructor(
    private readonly config: VoyageConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async rerank(request: RerankRequest): Promise<RerankScore[]> {
    if (request.documents.length === 0) return [];

    const url = `${this.config.baseUrl.replace(/\/+$/, '')}/rerank`;
    let response: Response;
    try {
      response = await resilientFetch(
        url,
        {
          method: 'POST',
          signal: combineSignals(this.config.timeoutMs, request.signal),
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: JSON.stringify({
            query: request.query,
            documents: request.documents,
            model: this.config.model,
            top_k: request.documents.length,
            return_documents: false,
            truncation: true,
          }),
        },
        {
          fetchImpl: this.fetchImpl,
          breakerKey: `rerank:voyage:${safeUrl(url)}`,
          retry: { maxAttempts: 2, baseDelayMs: 750, capDelayMs: 750 },
        },
      );
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new Error(
          `Rerank endpoint circuit open (${safeUrl(url)}): retry in ${Math.ceil(error.retryAfterMs / 1000)}s`,
        );
      }
      if (
        error instanceof DOMException &&
        (error.name === 'TimeoutError' || error.name === 'AbortError')
      ) {
        const action = request.signal?.aborted ? 'cancelled' : `timed out after ${this.config.timeoutMs}ms`;
        throw new Error(`Rerank request ${action} (${safeUrl(url)})`);
      }
      if (error instanceof ResilientFetchExhaustedError) {
        throw new Error(`Rerank endpoint returned ${error.response.status} (${safeUrl(url)})`);
      }
      const reason = sanitizeReason(
        error instanceof Error ? error.message : String(error),
        url,
        this.config.apiKey,
      );
      throw new Error(`Rerank request failed (${safeUrl(url)}): ${reason}`);
    }

    if (!response.ok) {
      throw new Error(`Rerank endpoint returned ${response.status} (${safeUrl(url)})`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Rerank endpoint returned an unparseable response (${safeUrl(url)})`);
    }

    if (!payload || typeof payload !== 'object') {
      throw new Error(`Rerank endpoint returned an unexpected response shape (${safeUrl(url)})`);
    }
    const source = (payload as { data?: unknown; results?: unknown }).data ??
      (payload as { results?: unknown }).results;
    if (!Array.isArray(source)) {
      throw new Error(`Rerank endpoint returned an unexpected response shape (${safeUrl(url)})`);
    }

    return source.map((item) => {
      const row = item as { index?: unknown; relevance_score?: unknown };
      return { index: row.index as number, score: row.relevance_score as number };
    });
  }
}

export function resolveRerankRuntime(
  repoName: string,
  env: RerankEnvironment = process.env,
): RerankRuntime | null {
  const configured = env.GITNEXUS_RERANK_PROVIDER?.trim().toLowerCase();
  const legacyEnabled = env.GITNEXUS_RERANK_ENABLED === '1';
  const providerName = configured || (legacyEnabled ? 'voyage' : '');
  if (!providerName || providerName === 'none' || providerName === 'off') return null;
  if (providerName !== 'voyage') {
    throw new Error(`Unsupported GITNEXUS_RERANK_PROVIDER "${providerName}"`);
  }
  if (!allowedForRepo(repoName, env)) return null;

  const apiKey = env.GITNEXUS_RERANK_API_KEY || env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('Voyage rerank is enabled for this repository, but no API key is configured');
  }

  const config: VoyageConfig = {
    baseUrl: (env.GITNEXUS_RERANK_URL || DEFAULT_URL).replace(/\/+$/, ''),
    model: env.GITNEXUS_RERANK_MODEL || DEFAULT_MODEL,
    apiKey,
    timeoutMs: positiveInteger(env, 'GITNEXUS_RERANK_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };

  return {
    provider: new VoyageRerankProvider(config),
    candidates: positiveInteger(env, 'GITNEXUS_RERANK_CANDIDATES', DEFAULT_CANDIDATES, 1000),
    maxDocChars: positiveInteger(
      env,
      'GITNEXUS_RERANK_MAX_DOC_CHARS',
      DEFAULT_MAX_DOC_CHARS,
      1_000_000,
    ),
    failurePolicy: resolveFailurePolicy(env),
  };
}
