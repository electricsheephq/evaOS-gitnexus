import path from 'node:path';
import type { LocalBackend, RepoListing } from './local/local-backend.js';
import { parseListReposPagination } from './local/local-backend.js';
import { LIST_REPOS_DEFAULT_LIMIT, LIST_REPOS_MAX_LIMIT } from './tools.js';
import type { GITNEXUS_TOOLS } from './tools.js';

type GitNexusTool = (typeof GITNEXUS_TOOLS)[number];

const CANONICAL_ALLOWED = 'GITNEXUS_MCP_ALLOWED_REPOS';
const CANONICAL_DEFAULT = 'GITNEXUS_MCP_DEFAULT_REPO';
const OPENCLAW_ALLOWED = 'OPENCLAW_CODE_INDEX_ALLOWED_REPOS';
const OPENCLAW_DEFAULT = 'OPENCLAW_CODE_INDEX_DEFAULT_REPO';

interface RawRepositoryPolicy {
  allowed?: string[];
  defaultRepo?: string;
}

interface ResolvedRepository {
  name: string;
  path: string;
  pathKey: string;
}

function configuredValue(
  env: NodeJS.ProcessEnv,
  canonical: string,
  compatibilityAlias: string,
): { key: string; value: string } | undefined {
  const canonicalValue = env[canonical];
  if (canonicalValue !== undefined) return { key: canonical, value: canonicalValue };
  const compatibilityValue = env[compatibilityAlias];
  if (compatibilityValue !== undefined)
    return { key: compatibilityAlias, value: compatibilityValue };
  return undefined;
}

function parseRepositoryPolicy(env: NodeJS.ProcessEnv): RawRepositoryPolicy {
  const allowedRaw = configuredValue(env, CANONICAL_ALLOWED, OPENCLAW_ALLOWED);
  const defaultRaw = configuredValue(env, CANONICAL_DEFAULT, OPENCLAW_DEFAULT);

  let allowed: string[] | undefined;
  if (allowedRaw) {
    allowed = allowedRaw.value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (allowed.length === 0) throw new Error(`${allowedRaw.key} must not be blank.`);
  }

  let defaultRepo: string | undefined;
  if (defaultRaw) {
    defaultRepo = defaultRaw.value.trim();
    if (!defaultRepo) throw new Error(`${defaultRaw.key} must not be blank.`);
  }

  return { allowed, defaultRepo };
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function resolveSpecifier(
  specifier: string,
  registry: readonly ResolvedRepository[],
): { repo?: ResolvedRepository; reason?: 'invalid' | 'ambiguous' } {
  const trimmed = specifier.trim();
  const matches = isAbsolutePath(trimmed)
    ? registry.filter((repo) => repo.pathKey === normalizedPath(trimmed))
    : registry.filter((repo) => repo.name.toLowerCase() === trimmed.toLowerCase());

  if (matches.length === 0) return { reason: 'invalid' };
  if (matches.length > 1) return { reason: 'ambiguous' };
  return { repo: matches[0] };
}

function startupResolutionError(reason: 'invalid' | 'ambiguous'): Error {
  return new Error(
    reason === 'ambiguous'
      ? 'MCP repository configuration contains an ambiguous repository selection.'
      : 'MCP repository configuration contains an invalid repository selection.',
  );
}

function unavailableRepositoryError(): Error {
  return new Error('Repository is not available through this MCP server.');
}

export class McpRepositoryPolicy {
  readonly restricted: boolean;
  readonly configured: boolean;

  private readonly registry: readonly ResolvedRepository[];
  private readonly allowed: readonly ResolvedRepository[];
  private readonly allowedPathKeys: ReadonlySet<string>;
  private readonly defaultRepo?: ResolvedRepository;
  private readonly uniqueAllowedContextNames: ReadonlySet<string>;

  static unrestricted(): McpRepositoryPolicy {
    return new McpRepositoryPolicy([], undefined, undefined);
  }

  constructor(
    registry: readonly ResolvedRepository[],
    allowed: readonly ResolvedRepository[] | undefined,
    defaultRepo: ResolvedRepository | undefined,
  ) {
    this.registry = registry;
    this.restricted = allowed !== undefined;
    this.configured = this.restricted || defaultRepo !== undefined;
    this.allowed = allowed ?? registry;
    this.allowedPathKeys = new Set(this.allowed.map((repo) => repo.pathKey));
    this.defaultRepo = defaultRepo;

    const registryNameCounts = new Map<string, number>();
    for (const repo of registry) {
      const name = repo.name.toLowerCase();
      registryNameCounts.set(name, (registryNameCounts.get(name) ?? 0) + 1);
    }
    this.uniqueAllowedContextNames = new Set(
      this.allowed
        .map((repo) => repo.name.toLowerCase())
        .filter((name) => registryNameCounts.get(name) === 1),
    );
  }

  private resolveRuntimeRepo(specifier: string): ResolvedRepository {
    const result = resolveSpecifier(specifier, this.registry);
    if (!result.repo || (this.restricted && !this.allowedPathKeys.has(result.repo.pathKey))) {
      throw unavailableRepositoryError();
    }
    return result.repo;
  }

  private repoForArgs(args: Record<string, unknown> | undefined): ResolvedRepository | undefined {
    const explicit = args?.repo;
    if (explicit !== undefined) {
      if (typeof explicit !== 'string') throw unavailableRepositoryError();
      if (explicit.trim().startsWith('@')) {
        if (this.restricted) {
          throw new Error('Group routing is unavailable when an MCP repository allowlist is set.');
        }
        return undefined;
      }
      return this.resolveRuntimeRepo(explicit);
    }

    if (this.defaultRepo) return this.defaultRepo;
    if (this.restricted && this.allowed.length === 1) return this.allowed[0];
    if (this.restricted && this.allowed.length > 1) {
      throw new Error('Specify an explicit repo because multiple repositories are allowed.');
    }
    return undefined;
  }

  private normalizeToolArgs(
    args: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!this.configured) return args;
    if (!this.restricted && args?.repo !== undefined) return args;
    const selected = this.repoForArgs(args);
    if (!selected) return args;
    return { ...(args ?? {}), repo: selected.path };
  }

  private async listAllowedRepos(backend: LocalBackend): Promise<RepoListing[]> {
    const current = await backend.listRepos();
    if (!this.restricted) return current;
    return current
      .filter((repo) => this.allowedPathKeys.has(normalizedPath(repo.path)))
      .map((repo) => {
        const siblings = repo.siblings?.filter((sibling) =>
          this.allowedPathKeys.has(normalizedPath(sibling.path)),
        );
        return {
          ...repo,
          siblings: siblings && siblings.length > 0 ? siblings : undefined,
        };
      });
  }

  private async listReposPage(
    backend: LocalBackend,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    const { limit, offset } = parseListReposPagination(params, {
      defaultLimit: LIST_REPOS_DEFAULT_LIMIT,
      maxLimit: LIST_REPOS_MAX_LIMIT,
    });
    const repositories = await this.listAllowedRepos(backend);
    repositories.sort((a, b) => {
      const an = a.name.toLowerCase();
      const bn = b.name.toLowerCase();
      if (an !== bn) return an < bn ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    const total = repositories.length;
    const page = repositories.slice(offset, offset + limit);
    const returned = page.length;
    const hasMore = offset + returned < total;
    return {
      repositories: page,
      pagination: {
        total,
        limit,
        offset,
        returned,
        hasMore,
        ...(hasMore && { nextOffset: offset + returned }),
      },
    };
  }

  private async callTool(
    backend: LocalBackend,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (!this.configured) return backend.callTool(method, params);
    if (method === 'list_repos') return this.listReposPage(backend, params);
    if (this.restricted && method.startsWith('group_')) {
      throw new Error('Group tools are unavailable when an MCP repository allowlist is set.');
    }
    return backend.callTool(method, this.normalizeToolArgs(params));
  }

  private async resolveRepo(
    backend: LocalBackend,
    repo?: string,
    branch?: string,
  ): Promise<Awaited<ReturnType<LocalBackend['resolveRepo']>>> {
    if (!this.configured) return backend.resolveRepo(repo, branch);
    if (!this.restricted) return backend.resolveRepo(repo ?? this.defaultRepo?.path, branch);
    const selected = this.repoForArgs(repo === undefined ? undefined : { repo });
    return backend.resolveRepo(selected?.path, branch);
  }

  assertResourceUri(uri: string): void {
    if (!this.restricted) return;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return;
    }
    if (parsed.protocol !== 'gitnexus:') return;
    if (parsed.hostname === 'group') {
      throw new Error('Group resources are unavailable when an MCP repository allowlist is set.');
    }
    if (parsed.hostname !== 'repo') return;
    const repoName = parsed.pathname.split('/').filter(Boolean)[0];
    if (!repoName) return;
    this.resolveRuntimeRepo(decodeURIComponent(repoName));
  }

  resourceTemplateAllowed(uriTemplate: string): boolean {
    return !this.restricted || !uriTemplate.startsWith('gitnexus://group/');
  }

  toolAllowed(toolName: string): boolean {
    return !this.restricted || !toolName.startsWith('group_');
  }

  toolForMcp(tool: GitNexusTool): GitNexusTool {
    if (!this.restricted) return tool;
    const properties = { ...tool.inputSchema.properties };
    const repo = properties.repo;
    if (repo && typeof repo === 'object') {
      properties.repo = {
        ...repo,
        description: 'Allowed indexed repository name or path. Group-mode values are unavailable.',
      };
    }
    delete properties.subgroup;
    delete properties.crossDepth;
    const description = tool.description
      .replace(/\nGROUP MODE:[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
      .replace(/\nCROSS-REPO \(experimental\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '')
      .replace(/\nDESTINATION TRACE \(cross-repo\):[\s\S]*?(?=\n\n[A-Z][A-Z ()-]*:|$)/gu, '');
    return { ...tool, description, inputSchema: { ...tool.inputSchema, properties } };
  }

  scopeBackend(backend: LocalBackend): LocalBackend {
    const policy = this;
    return new Proxy(backend, {
      get(target, property, receiver) {
        if (property === 'callTool') {
          return (method: string, params: Record<string, unknown> | undefined) =>
            policy.callTool(target, method, params);
        }
        if (property === 'listRepos') return () => policy.listAllowedRepos(target);
        if (property === 'resolveRepo') {
          return (repo?: string, branch?: string) => policy.resolveRepo(target, repo, branch);
        }
        if (property === 'getContext' && policy.restricted) {
          return (repoId?: string) => {
            if (!repoId || !policy.uniqueAllowedContextNames.has(repoId.toLowerCase())) return null;
            return target.getContext(repoId);
          };
        }
        if (
          policy.restricted &&
          (property === 'readGroupContractsResource' || property === 'readGroupStatusResource')
        ) {
          return async () => {
            throw new Error(
              'Group resources are unavailable when an MCP repository allowlist is set.',
            );
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}

export function mcpRepositoryPolicyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = parseRepositoryPolicy(env);
  return raw.allowed !== undefined || raw.defaultRepo !== undefined;
}

export async function createMcpRepositoryPolicy(
  backend: LocalBackend,
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpRepositoryPolicy> {
  const raw = parseRepositoryPolicy(env);
  if (!raw.allowed && !raw.defaultRepo) {
    return McpRepositoryPolicy.unrestricted();
  }

  const registry = (await backend.listRepos()).map((repo) => ({
    name: repo.name,
    path: repo.path,
    pathKey: normalizedPath(repo.path),
  }));

  let allowed: ResolvedRepository[] | undefined;
  if (raw.allowed) {
    const byPath = new Map<string, ResolvedRepository>();
    for (const specifier of raw.allowed) {
      const result = resolveSpecifier(specifier, registry);
      if (!result.repo) throw startupResolutionError(result.reason ?? 'invalid');
      byPath.set(result.repo.pathKey, result.repo);
    }
    allowed = [...byPath.values()];
  }

  let defaultRepo: ResolvedRepository | undefined;
  if (raw.defaultRepo) {
    const result = resolveSpecifier(raw.defaultRepo, registry);
    if (!result.repo) throw startupResolutionError(result.reason ?? 'invalid');
    defaultRepo = result.repo;
  }

  const defaultPathKey = defaultRepo?.pathKey;
  if (defaultPathKey && allowed && !allowed.some((repo) => repo.pathKey === defaultPathKey)) {
    throw new Error('The MCP default repository is not in the configured allowlist.');
  }

  return new McpRepositoryPolicy(registry, allowed, defaultRepo);
}
