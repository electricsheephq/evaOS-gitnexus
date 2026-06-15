import { execSync } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { describe, it, expect, vi } from 'vitest';
import {
  deriveEmbeddingMode,
  deriveEmbeddingCap,
  DEFAULT_EMBEDDING_NODE_LIMIT,
} from '../../src/core/embedding-mode.js';
import {
  getStoragePaths,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../../src/storage/repo-manager.js';
import { createTempDir } from '../helpers/test-db.js';

describe('run-analyze module', () => {
  it('exports runFullAnalysis as a function', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(typeof mod.runFullAnalysis).toBe('function');
  });

  it('exports PHASE_LABELS', async () => {
    const mod = await import('../../src/core/run-analyze.js');
    expect(mod.PHASE_LABELS).toBeDefined();
    expect(mod.PHASE_LABELS.parsing).toBe('Parsing code');
  });

  it('creates .gitnexus/.gitignore on the already-up-to-date fast path (#1233)', async () => {
    const tmpRepo = await createTempDir('gitnexus-test-run-analyze-fast-path-');
    try {
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit --allow-empty -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });
      const currentCommit = execSync('git rev-parse HEAD', {
        cwd: tmpRepo.dbPath,
        encoding: 'utf-8',
      }).trim();
      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const meta: RepoMeta = {
        repoPath: tmpRepo.dbPath,
        lastCommit: currentCommit,
        indexedAt: new Date().toISOString(),
      };
      await saveMeta(storagePath, meta);

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        {},
        {
          onProgress: () => {},
        },
      );

      expect(result.alreadyUpToDate).toBe(true);
      await expect(
        fs.readFile(path.join(tmpRepo.dbPath, '.gitnexus', '.gitignore'), 'utf-8'),
      ).resolves.toBe('*\n');
    } finally {
      await tmpRepo.cleanup();
    }
  });

  it('skips AGENTS.md, CLAUDE.md, and bundled skills when skipAiContext is enabled', async () => {
    const tmpRepo = await createTempDir('gitnexus-test-run-analyze-no-ai-context-');
    const previousHome = process.env.GITNEXUS_HOME;
    try {
      const gitnexusHome = path.join(tmpRepo.dbPath, '.gitnexus-home');
      await fs.mkdir(gitnexusHome, { recursive: true });
      process.env.GITNEXUS_HOME = gitnexusHome;

      await fs.writeFile(
        path.join(tmpRepo.dbPath, 'index.ts'),
        'export function hello() { return 1; }\n',
      );
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAiContext: true },
        {
          onProgress: () => {},
        },
      );

      expect(result.alreadyUpToDate).not.toBe(true);
      await expect(fs.stat(path.join(tmpRepo.dbPath, '.gitnexus'))).resolves.toBeDefined();
      await expect(fs.stat(path.join(tmpRepo.dbPath, 'AGENTS.md'))).rejects.toThrow();
      await expect(fs.stat(path.join(tmpRepo.dbPath, 'CLAUDE.md'))).rejects.toThrow();
      await expect(fs.stat(path.join(tmpRepo.dbPath, '.claude'))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) {
        delete process.env.GITNEXUS_HOME;
      } else {
        process.env.GITNEXUS_HOME = previousHome;
      }
      await tmpRepo.cleanup();
    }
  });

  it('does not treat embedding checkpoint metadata as already up to date', async () => {
    const tmpRepo = await createTempDir('gitnexus-test-run-analyze-checkpoint-');
    const previousHome = process.env.GITNEXUS_HOME;
    const previousEmbeddingUrl = process.env.GITNEXUS_EMBEDDING_URL;
    const previousEmbeddingModel = process.env.GITNEXUS_EMBEDDING_MODEL;
    const previousEmbeddingKey = process.env.GITNEXUS_EMBEDDING_API_KEY;
    try {
      const gitnexusHome = path.join(tmpRepo.dbPath, '.gitnexus-home');
      await fs.mkdir(gitnexusHome, { recursive: true });
      process.env.GITNEXUS_HOME = gitnexusHome;
      process.env.GITNEXUS_EMBEDDING_URL = 'http://test:8080/v1';
      process.env.GITNEXUS_EMBEDDING_MODEL = 'test-model';
      process.env.GITNEXUS_EMBEDDING_API_KEY = 'test-key';
      const mockVec = Array.from({ length: 384 }, (_, i) => i / 384);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (_input, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body ?? '{}')) as { input?: unknown[] };
          const count = Array.isArray(body.input) ? body.input.length : 1;
          return {
            ok: true,
            json: async () => ({
              data: Array.from({ length: count }, () => ({ embedding: mockVec })),
            }),
          };
        }),
      );

      await fs.writeFile(
        path.join(tmpRepo.dbPath, 'index.ts'),
        'export function checkpointResume() { return "ready"; }\n',
      );
      execSync('git init', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git add index.ts', { cwd: tmpRepo.dbPath, stdio: 'pipe' });
      execSync('git -c user.name=test -c user.email=test@test commit -m init', {
        cwd: tmpRepo.dbPath,
        stdio: 'pipe',
      });

      const { runFullAnalysis } = await import('../../src/core/run-analyze.js');
      await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAiContext: true },
        {
          onProgress: () => {},
        },
      );

      const { storagePath } = getStoragePaths(tmpRepo.dbPath);
      const completedMeta = await loadMeta(storagePath);
      expect(completedMeta).not.toBeNull();
      if (!completedMeta) {
        throw new Error('expected completed meta before checkpoint simulation');
      }
      await saveMeta(storagePath, {
        ...completedMeta,
        stats: { ...completedMeta.stats, embeddings: 1 },
        checkpoint: true,
      });

      const logs: string[] = [];
      const result = await runFullAnalysis(
        tmpRepo.dbPath,
        { skipAiContext: true },
        {
          onProgress: () => {},
          onLog: (msg) => logs.push(msg),
        },
      );

      expect(result.alreadyUpToDate).not.toBe(true);
      expect(fetch).toHaveBeenCalled();
      expect(logs.some((msg) => msg.includes('embedding checkpoint'))).toBe(true);
      const finalMeta = await loadMeta(storagePath);
      expect(finalMeta?.checkpoint).toBeUndefined();
    } finally {
      if (previousHome === undefined) {
        delete process.env.GITNEXUS_HOME;
      } else {
        process.env.GITNEXUS_HOME = previousHome;
      }
      if (previousEmbeddingUrl === undefined) {
        delete process.env.GITNEXUS_EMBEDDING_URL;
      } else {
        process.env.GITNEXUS_EMBEDDING_URL = previousEmbeddingUrl;
      }
      if (previousEmbeddingModel === undefined) {
        delete process.env.GITNEXUS_EMBEDDING_MODEL;
      } else {
        process.env.GITNEXUS_EMBEDDING_MODEL = previousEmbeddingModel;
      }
      if (previousEmbeddingKey === undefined) {
        delete process.env.GITNEXUS_EMBEDDING_API_KEY;
      } else {
        process.env.GITNEXUS_EMBEDDING_API_KEY = previousEmbeddingKey;
      }
      vi.unstubAllGlobals();
      await tmpRepo.cleanup();
    }
  });
});

describe('deriveEmbeddingMode', () => {
  // Default `analyze` on a repo with existing embeddings: must preserve, must
  // NOT regenerate, must load the cache so phase 3.5 can re-insert vectors.
  it('default + existing>0 → preserve only (load cache, no generation)', () => {
    const m = deriveEmbeddingMode({}, 1234);
    expect(m.preserveExistingEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('default + existing=0 → no-op (no preserve, no generation, no cache load)', () => {
    const m = deriveEmbeddingMode({}, 0);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  // The headline behavior change requested in PR feedback: --force on an
  // already-embedded repo must regenerate (top up new/changed nodes), not
  // silently downgrade to "preserve only".
  it('--force + existing>0 → forceRegenerate + generate + load cache', () => {
    const m = deriveEmbeddingMode({ force: true }, 500);
    expect(m.forceRegenerateEmbeddings).toBe(true);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--force + existing=0 → no embedding work (force keeps prior semantics)', () => {
    const m = deriveEmbeddingMode({ force: true }, 0);
    expect(m.forceRegenerateEmbeddings).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(false);
  });

  it('--embeddings → generate + load cache (incremental top-up)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 500);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.shouldLoadCache).toBe(true);
  });

  it('--embeddings + existing=0 → generate; cache load still fires (harmless empty load)', () => {
    const m = deriveEmbeddingMode({ embeddings: true }, 0);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    // Cache load is gated at the call site by `existingMeta`, not by count;
    // when explicit `--embeddings` is set we always attempt the load so any
    // stray vectors from a partial prior run get picked up.
    expect(m.shouldLoadCache).toBe(true);
  });

  // --drop-embeddings is the explicit wipe path; it must suppress cache load
  // even when --force is also set (the dominant escape hatch).
  it('--drop-embeddings → suppresses cache load, no generation', () => {
    const m = deriveEmbeddingMode({ dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.preserveExistingEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--force + --drop-embeddings → drop wins (no cache load, no generation)', () => {
    const m = deriveEmbeddingMode({ force: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(false);
    expect(m.forceRegenerateEmbeddings).toBe(false);
  });

  it('--embeddings + --drop-embeddings → drop suppresses cache load (no preservation)', () => {
    // --embeddings still generates, but the prior vectors are wiped first.
    const m = deriveEmbeddingMode({ embeddings: true, dropEmbeddings: true }, 1234);
    expect(m.shouldLoadCache).toBe(false);
    expect(m.shouldGenerateEmbeddings).toBe(true);
    expect(m.preserveExistingEmbeddings).toBe(false);
  });
});

describe('deriveEmbeddingCap', () => {
  it('uses the default 50K cap when limit is undefined', () => {
    const d = deriveEmbeddingCap(10_000, undefined);
    expect(d.nodeLimit).toBe(DEFAULT_EMBEDDING_NODE_LIMIT);
    expect(d.capDisabled).toBe(false);
    expect(d.skipForCap).toBe(false);
  });

  it('skips when node count exceeds the default cap', () => {
    const d = deriveEmbeddingCap(75_000, undefined);
    expect(d.skipForCap).toBe(true);
    expect(d.capDisabled).toBe(false);
  });

  it('does not skip when node count equals the default cap (boundary)', () => {
    const d = deriveEmbeddingCap(DEFAULT_EMBEDDING_NODE_LIMIT, undefined);
    expect(d.skipForCap).toBe(false);
  });

  it('limit=0 disables the cap regardless of node count', () => {
    const d = deriveEmbeddingCap(1_000_000, 0);
    expect(d.capDisabled).toBe(true);
    expect(d.skipForCap).toBe(false);
    expect(d.nodeLimit).toBe(0);
  });

  it('honors a custom positive cap', () => {
    expect(deriveEmbeddingCap(99_999, 100_000).skipForCap).toBe(false);
    expect(deriveEmbeddingCap(100_001, 100_000).skipForCap).toBe(true);
  });

  it('custom cap below default still applies', () => {
    expect(deriveEmbeddingCap(15_000, 10_000).skipForCap).toBe(true);
  });
});
