import process from 'node:process';

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
