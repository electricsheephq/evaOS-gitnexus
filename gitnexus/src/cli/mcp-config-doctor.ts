import {
  preflightMcpRepositoryPolicy,
  type McpRepositoryPolicyPreflightResult,
  type RepositoryPolicyRegistryBackend,
} from '../mcp/repository-policy.js';
import { readRegistry, type RegistryEntry } from '../storage/repo-manager.js';

export type McpConfigDoctorReport = {
  mode: 'mcp-config';
  readOnly: true;
} & McpRepositoryPolicyPreflightResult;

/**
 * Read the registry without validation/pruning and run the production MCP
 * parser/resolver against an in-memory list adapter. No LocalBackend is
 * initialized, so the preflight cannot open an index, recover sidecars, bind a
 * transport, or mutate registry state.
 */
export async function buildMcpConfigDoctorReport(
  env: NodeJS.ProcessEnv = process.env,
  entries?: readonly RegistryEntry[],
): Promise<McpConfigDoctorReport> {
  const registry = entries ? [...entries] : await readRegistry();
  const backend: RepositoryPolicyRegistryBackend = {
    listRepos: async () =>
      registry.map((entry) => ({
        name: entry.name,
        path: entry.path,
        indexedAt: entry.indexedAt,
        lastCommit: entry.lastCommit,
      })),
  };
  const result = await preflightMcpRepositoryPolicy(backend, env);
  return { mode: 'mcp-config', readOnly: true, ...result };
}
