/**
 * MCP Server (Multi-Repo)
 *
 * Model Context Protocol server that runs on stdio.
 * External AI tools (Cursor, Claude) spawn this process and
 * communicate via stdin/stdout using the MCP protocol.
 *
 * Supports multiple indexed repositories via the global registry.
 *
 * Tools: list_repos, query, cypher, context, impact, detect_changes, rename
 * Resources: repos, repo/{name}/context, repo/{name}/clusters, ...
 */

import { createRequire } from 'module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CompatibleStdioServerTransport } from './compatible-stdio-transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { GITNEXUS_TOOLS } from './tools.js';
import { installGlobalStdoutSentinel } from './stdio-context.js';
import type { LocalBackend } from './local/local-backend.js';
import { getResourceDefinitions, getResourceTemplates, readResource } from './resources.js';
import { parseMaxTokens, truncateToTokenBudget } from '../cli/token-budget.js';
import { defaultRepo, mcpReadOnlyMode, repoAllowed } from './config.js';

const MCP_READ_ONLY_TOOLS = new Set([
  'list_repos',
  'query',
  'context',
  'impact',
  'detect_changes',
  'cypher',
]);
const BUDGETED_TOOLS = new Set(['query', 'context', 'impact']);
const MCP_QUERY_LIMIT_MAX = 20;
const MCP_QUERY_SYMBOLS_MAX = 50;
const MCP_IMPACT_DEPTH_MAX = 8;
const MCP_IMPACT_TIMEOUT_MAX = 60_000;

function normalizeArgsForMcp(toolName: string, args: any): any {
  const normalized = { ...(args || {}) };
  if (toolName !== 'list_repos' && !normalized.repo && defaultRepo()) {
    normalized.repo = defaultRepo();
  }
  if (toolName === 'query') {
    normalized.limit = clampPositiveInteger(normalized.limit, MCP_QUERY_LIMIT_MAX);
    normalized.max_symbols = clampPositiveInteger(normalized.max_symbols, MCP_QUERY_SYMBOLS_MAX);
  }
  if (toolName === 'impact') {
    normalized.maxDepth = clampPositiveInteger(normalized.maxDepth, MCP_IMPACT_DEPTH_MAX);
    normalized.crossDepth = clampPositiveInteger(normalized.crossDepth, MCP_IMPACT_DEPTH_MAX);
    normalized.timeoutMs = clampPositiveInteger(
      normalized.timeoutMs ?? normalized.timeout,
      MCP_IMPACT_TIMEOUT_MAX,
    );
    normalized.timeout = undefined;
  }
  return normalized;
}

function assertMcpReadOnlyResource(uri: string): void {
  if (!mcpReadOnlyMode()) return;
  const match = /^gitnexus:\/\/repo\/([^/]+)/u.exec(uri);
  if (match && !repoAllowed(decodeURIComponent(match[1]!))) {
    throw new Error(
      `Resource repo "${decodeURIComponent(match[1]!)}" is not in the GitNexus MCP allow-list.`,
    );
  }
  if (/^gitnexus:\/\/group\//u.test(uri)) {
    throw new Error('Group resources are not available in GitNexus MCP read-only mode.');
  }
}

function clampPositiveInteger(raw: unknown, max: number): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) return undefined;
  return Math.min(value, max);
}

function toolForMcp(tool: (typeof GITNEXUS_TOOLS)[number]): (typeof GITNEXUS_TOOLS)[number] {
  if (!mcpReadOnlyMode()) return tool;
  if (!['query', 'context', 'impact', 'detect_changes', 'cypher'].includes(tool.name)) return tool;
  const repoText = defaultRepo()
    ? `This read-only MCP defaults omitted repo parameters to ${defaultRepo()}.`
    : 'This read-only MCP requires an explicit repo parameter when more than one repo is allowed.';
  return {
    ...tool,
    description: `${tool.description}\n\nGITNEXUS MCP: ${repoText} Use maxTokens on query/context/impact for bounded retrieval slices.`,
  };
}

function applyTokenBudget(toolName: string, args: any, text: string): string {
  if (!BUDGETED_TOOLS.has(toolName)) return text;
  const parsed = parseMaxTokens(args?.maxTokens);
  if (parsed.error) throw new Error(`maxTokens ${parsed.error}`);
  return parsed.value ? truncateToTokenBudget(text, parsed.value) : text;
}

/**
 * Next-step hints appended to tool responses.
 *
 * Agents often stop after one tool call. These hints guide them to the
 * logical next action, creating a self-guiding workflow without hooks.
 *
 * Design: Each hint is a short, actionable instruction (not a suggestion).
 * The hint references the specific tool/resource to use next.
 */
function getNextStepHint(toolName: string, args: Record<string, any> | undefined): string {
  const repo = args?.repo;
  const repoParam = repo ? `, repo: "${repo}"` : '';
  const repoPath = repo || '{name}';

  switch (toolName) {
    case 'list_repos':
      return `\n\n---\n**Next:** READ gitnexus://repo/{name}/context for any repo above to get its overview and check staleness.`;

    case 'query':
      return `\n\n---\n**Next:** To understand a specific symbol in depth, use context({name: "<symbol_name>"${repoParam}}) to see categorized refs and process participation.`;

    case 'context':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "${args?.name || '<name>'}", direction: "upstream"${repoParam}}) to check blast radius. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'impact':
      return `\n\n---\n**Next:** Review d=1 items first (WILL BREAK). To check affected execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    case 'detect_changes':
      return `\n\n---\n**Next:** Review affected processes. Use context() on high-risk changed symbols. READ gitnexus://repo/${repoPath}/process/{name} for full execution traces.`;

    case 'rename':
      return `\n\n---\n**Next:** Run detect_changes(${repoParam ? `{repo: "${repo}"}` : ''}) to verify no unexpected side effects from the rename.`;

    case 'cypher':
      return `\n\n---\n**Next:** To explore a result symbol, use context({name: "<name>"${repoParam}}). For schema reference, READ gitnexus://repo/${repoPath}/schema.`;

    // Legacy tool names — still return useful hints
    case 'search':
      return `\n\n---\n**Next:** To understand a result in context, use context({name: "<symbol_name>"${repoParam}}).`;
    case 'explore':
      return `\n\n---\n**Next:** If planning changes, use impact({target: "<name>", direction: "upstream"${repoParam}}).`;
    case 'overview':
      return `\n\n---\n**Next:** To drill into an area, READ gitnexus://repo/${repoPath}/cluster/{name}. To see execution flows, READ gitnexus://repo/${repoPath}/processes.`;

    default:
      return '';
  }
}

/**
 * Create a configured MCP Server with all handlers registered.
 * Transport-agnostic — caller connects the desired transport.
 */
export function createMCPServer(backend: LocalBackend): Server {
  const require = createRequire(import.meta.url);
  const pkgVersion: string = require('../../package.json').version;
  const server = new Server(
    {
      name: 'gitnexus',
      version: pkgVersion,
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // Handle list resources request
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = getResourceDefinitions();
    return {
      resources: resources.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType,
      })),
    };
  });

  // Handle list resource templates request (for dynamic resources)
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    const templates = getResourceTemplates();
    return {
      resourceTemplates: templates.map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  // Handle read resource request
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    try {
      assertMcpReadOnlyResource(uri);
      const content = await readResource(uri, backend);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/yaml',
            text: content,
          },
        ],
      };
    } catch (err: any) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `Error: ${err.message}`,
          },
        ],
      };
    }
  });

  // Handle list tools request
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: GITNEXUS_TOOLS.filter((tool) => !mcpReadOnlyMode() || MCP_READ_ONLY_TOOLS.has(tool.name))
      .map((tool) => toolForMcp(tool))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      })),
  }));

  // Handle tool calls — append next-step hints to guide agent workflow
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const normalizedArgs = normalizeArgsForMcp(name, args);
      const result = await backend.callTool(name, normalizedArgs);
      const resultText = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      const hint = getNextStepHint(name, normalizedArgs as Record<string, any> | undefined);
      const responseText = applyTokenBudget(name, normalizedArgs, resultText + hint);

      return {
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${message}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Handle list prompts request
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'detect_impact',
        description:
          'Analyze the impact of your current changes before committing. Guides through scope selection, change detection, process analysis, and risk assessment.',
        arguments: [
          {
            name: 'scope',
            description: 'What to analyze: unstaged, staged, all, or compare',
            required: false,
          },
          { name: 'base_ref', description: 'Branch/commit for compare scope', required: false },
        ],
      },
      {
        name: 'generate_map',
        description:
          'Generate architecture documentation from the knowledge graph. Creates a codebase overview with execution flows and mermaid diagrams.',
        arguments: [
          {
            name: 'repo',
            description: 'Repository name (omit if only one indexed)',
            required: false,
          },
        ],
      },
    ],
  }));

  // Handle get prompt request
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === 'detect_impact') {
      const scope = args?.scope || 'all';
      const baseRef = args?.base_ref || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Analyze the impact of my current code changes before committing.

Follow these steps:
1. Run \`detect_changes(${JSON.stringify({ scope, ...(baseRef ? { base_ref: baseRef } : {}) })})\` to find what changed and affected processes
2. For each changed symbol in critical processes, run \`context({name: "<symbol>"})\` to see its full reference graph
3. For any high-risk items (many callers or cross-process), run \`impact({target: "<symbol>", direction: "upstream"})\` for blast radius
4. Summarize: changes, affected processes, risk level, and recommended actions

Present the analysis as a clear risk report.`,
            },
          },
        ],
      };
    }

    if (name === 'generate_map') {
      const repo = args?.repo || '';
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `Generate architecture documentation for this codebase using the knowledge graph.

Follow these steps:
1. READ \`gitnexus://repo/${repo || '{name}'}/context\` for codebase stats
2. READ \`gitnexus://repo/${repo || '{name}'}/clusters\` to see all functional areas
3. READ \`gitnexus://repo/${repo || '{name}'}/processes\` to see all execution flows
4. For the top 5 most important processes, READ \`gitnexus://repo/${repo || '{name}'}/process/{name}\` for step-by-step traces
5. Generate a mermaid architecture diagram showing the major areas and their connections
6. Write an ARCHITECTURE.md file with: overview, functional areas, key execution flows, and the mermaid diagram`,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  return server;
}

/**
 * Start the MCP server on stdio transport (for CLI use).
 */
export async function startMCPServer(backend: LocalBackend): Promise<void> {
  const server = createMCPServer(backend);

  // Idempotent global sentinel install. cli/mcp.ts calls this first thing
  // (before warnMissingOptionalGrammars / backend.init can emit to stdout);
  // calling again here is a safety net for direct callers of startMCPServer
  // (tests, future entry points). The transport's _safeStdout Proxy is a
  // second layer that guarantees transport writes reach the sentinel even
  // if anything else re-replaces process.stdout.write later. Tagged
  // transport writes (wrapped in withMcpWrite by compatible-stdio-transport.send)
  // pass through to the captured realStdoutWrite; untagged writes reaching
  // the Proxy or process.stdout get redirected to stderr with the
  // [mcp:stdout-redirect] prefix. See stdio-context.ts.
  const sentinel = installGlobalStdoutSentinel();
  const safeStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'write') return sentinel.write;
      const val = Reflect.get(target, prop, receiver);
      return typeof val === 'function' ? val.bind(target) : val;
    },
  });
  const transport = new CompatibleStdioServerTransport(process.stdin, safeStdout);
  await server.connect(transport);

  // Orphan guard: if the client process that launched this stdio server dies,
  // self-terminate. Independent of stdin-EOF / SIGTERM delivery (both proved
  // unreliable when the parent is SIGKILLed, leaving the server spinning at
  // ~18% CPU as a `ppid=1` orphan and OOMing the host). The interval is unref'd
  // so it never keeps an otherwise-idle process alive; the MCP DB is opened
  // read-only, so the hard exit below cannot corrupt anything.
  const launchedByPid = process.ppid;
  const orphanGuard = setInterval(() => {
    try {
      process.kill(launchedByPid, 0); // signal 0 = liveness probe, delivers nothing
    } catch {
      process.exit(0); // ESRCH: launching client is gone -> exit now
    }
  }, 3000);
  orphanGuard.unref();

  // Surface the redirect counter on shutdown so users see the volume of
  // stray writes even when individual payloads were truncated/suppressed.
  process.on('exit', () => sentinel.flushSummary());

  // Graceful shutdown helper. Pino's default destination is `sync: false`
  // (buffered), so we must `flushLoggerSync()` before `process.exit` —
  // otherwise records emitted during disconnect/close are lost. The flush
  // is a no-op when the singleton was never used or when running under
  // vitest. See `gitnexus/src/core/logger.ts`.
  let shuttingDown = false;
  const shutdown = async (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Force-exit watchdog: never let a hung backend.disconnect()/server.close()
    // keep the process alive (the original orphan-spin bug — SIGTERM appeared
    // "ignored" because its handler awaited these). unref'd so it doesn't itself
    // hold the event loop open.
    setTimeout(() => process.exit(exitCode), 3000).unref();
    try {
      await backend.disconnect();
    } catch {}
    try {
      await server.close();
    } catch {}
    const { flushLoggerSync } = await import('../core/logger.js');
    flushLoggerSync();
    process.exit(exitCode);
  };

  // Handle graceful shutdown
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Log crashes to stderr so they aren't silently lost.
  // uncaughtException is fatal — shut down.
  // unhandledRejection is logged but kept non-fatal (availability-first):
  // killing the server for one missed catch would be worse than logging it.
  process.on('uncaughtException', (err) => {
    process.stderr.write(`GitNexus MCP uncaughtException: ${err?.stack || err}\n`);
    shutdown(1);
  });
  process.on('unhandledRejection', (reason: any) => {
    process.stderr.write(`GitNexus MCP unhandledRejection: ${reason?.stack || reason}\n`);
  });

  // Handle stdio errors — stdin close means the parent process is gone
  process.stdin.on('end', shutdown);
  process.stdin.on('error', () => shutdown());
  process.stdout.on('error', () => shutdown());
}
