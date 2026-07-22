export const CLAUDE_HOOK_ADAPTER = 'gitnexus-hook.cjs';

export const CLAUDE_HOOK_HELPERS = [
  'hook-lock.cjs',
  'hook-db-lock-probe.cjs',
  'win-rm-list-json.ps1',
  'resolve-analyze-cmd.cjs',
] as const;

export const BEST_EFFORT_CLAUDE_HOOK_HELPERS = new Set<string>(['win-rm-list-json.ps1']);

// Exact source line shipped by the adapter and replaced during installation.
export const CLAUDE_HOOK_CLI_PATH_LITERAL =
  "let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');";

export function patchClaudeHookCliPath(
  source: string,
  absoluteCliPath: string,
): { content: string; sourceLiteralFound: boolean } {
  const normalizedCli = absoluteCliPath.replace(/\\/g, '/');
  return {
    content: source.replace(
      CLAUDE_HOOK_CLI_PATH_LITERAL,
      `let cliPath = ${JSON.stringify(normalizedCli)};`,
    ),
    sourceLiteralFound: source.includes(CLAUDE_HOOK_CLI_PATH_LITERAL),
  };
}
