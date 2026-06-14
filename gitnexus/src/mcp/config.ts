import process from 'node:process';
import path from 'node:path';

export function mcpReadOnlyMode(): boolean {
  return process.env.OPENCLAW_CODE_INDEX_MCP === '1' || process.env.GITNEXUS_MCP_READ_ONLY === '1';
}

export function defaultRepo(): string {
  return (
    process.env.OPENCLAW_CODE_INDEX_DEFAULT_REPO || process.env.GITNEXUS_MCP_DEFAULT_REPO || ''
  );
}

export function mcpDefaultRepo(): string | undefined {
  return defaultRepo() || undefined;
}

export function configuredAllowedRepos(): Set<string> | null {
  const raw =
    process.env.GITNEXUS_MCP_ALLOWED_REPOS || process.env.OPENCLAW_CODE_INDEX_ALLOWED_REPOS || '';
  const names = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return names.length ? new Set(names) : null;
}

export function repoAllowed(repo: string): boolean {
  const allowed = configuredAllowedRepos();
  if (allowed) return allowed.has(repo);
  if (process.env.OPENCLAW_CODE_INDEX_MCP === '1') return /^openclaw(?:-|$)/u.test(repo);
  return true;
}

function isAbsolutePathSpecifier(repo: string): boolean {
  return path.isAbsolute(repo) || path.win32.isAbsolute(repo);
}

export function validateMcpConfig(): void {
  if (!mcpReadOnlyMode()) return;
  const repo = defaultRepo();
  if (repo && !isAbsolutePathSpecifier(repo) && !repoAllowed(repo)) {
    throw new Error(
      `GitNexus MCP default repo "${repo}" is not in the read-only allow-list. ` +
        'Update GITNEXUS_MCP_DEFAULT_REPO or GITNEXUS_MCP_ALLOWED_REPOS.',
    );
  }
}
