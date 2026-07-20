/**
 * Integration Tests: Vector extension loading and state reset
 *
 * Tests: loadVectorExtension idempotency, vectorExtensionLoaded reset
 * on closeLbug and busy-retry cleanup paths.
 *
 * Follows existing lbug integration test patterns (lbug-core-adapter,
 * lbug-lock-retry).
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';

withTestLbugDB('vector-extension', (handle) => {
  describe('loadVectorExtension', () => {
    it('reports VECTOR availability without throwing', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      await expect(loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });

    it('is idempotent -- calling twice does not throw', async () => {
      const { loadVectorExtension } = await import('../../src/core/lbug/lbug-adapter.js');

      await loadVectorExtension();
      await expect(loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });

  describe('vectorExtensionLoaded reset on closeLbug', () => {
    it('re-initializes vector extension after close + re-init cycle', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Close the adapter -- should reset vectorExtensionLoaded
      await adapter.closeLbug();
      expect(adapter.isLbugReady()).toBe(false);

      // Re-initialize -- VECTOR is lazy, so the stale loaded flag must not mask
      // a subsequent explicit availability check.
      await adapter.initLbug(handle.dbPath);
      expect(adapter.isLbugReady()).toBe(true);

      // loadVectorExtension should succeed (not skip due to stale flag)
      await expect(adapter.loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });

  describe('vectorExtensionLoaded reset on busy-retry cleanup', () => {
    it('withLbugDb resets vectorExtensionLoaded on BUSY retry', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      // Ensure vector extension is loaded
      await adapter.loadVectorExtension();

      // Simulate a BUSY error on first attempt, success on second.
      // The retry path should reset vectorExtensionLoaded so the
      // re-initialized DB gets a fresh extension load.
      let callCount = 0;
      const result = await adapter.withLbugDb(handle.dbPath, async () => {
        callCount++;
        if (callCount === 1) throw new Error('database is BUSY');
        return 'recovered';
      });

      expect(result).toBe('recovered');
      expect(callCount).toBe(2);

      // After recovery, vector extension should still be loadable
      // (the flag was reset and re-loaded during re-init)
      await expect(adapter.loadVectorExtension()).resolves.toEqual(expect.any(Boolean));
    });
  });
});

/**
 * Regression for #131: extension LOAD is connection-local. The read pool must
 * prepare VECTOR on all eight slots before publication, otherwise concurrent
 * HNSW queries fail depending on which connection is checked out.
 */
const poolVectorNodeId = 'Function:src/vector-pool.ts:target:1';
withTestLbugDB(
  'vector-pool-all-connections',
  (handle) => {
    it.skipIf(process.platform === 'win32')(
      'runs a real HNSW query successfully on all eight pooled connections',
      async () => {
        const poolAdapter = await import('../../src/core/lbug/pool-adapter.js');
        const { EMBEDDING_DIMS, EMBEDDING_INDEX_NAME, EMBEDDING_TABLE_NAME } = await import(
          '../../src/core/lbug/schema.js'
        );
        const queryVector = [1, ...new Array(EMBEDDING_DIMS - 1).fill(0)];
        const query = `
          CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
            CAST([${queryVector.join(',')}] AS FLOAT[${EMBEDDING_DIMS}]), 1)
          YIELD node AS emb, distance
          RETURN emb.nodeId AS nodeId, distance
        `;

        expect(poolAdapter.getPoolCapabilities(handle.repoId)).toEqual({
          fts: expect.any(Boolean),
          vector: true,
          connectionCount: 8,
        });
        const results = await Promise.all(
          Array.from({ length: 8 }, () => poolAdapter.executeQuery(handle.repoId, query)),
        );

        expect(results).toHaveLength(8);
        for (const rows of results) {
          expect(rows[0]?.nodeId ?? rows[0]?.[0]).toBe(poolVectorNodeId);
        }
      },
    );

    it.skipIf(process.platform !== 'win32')(
      'keeps graph queries available while VECTOR is disabled on Windows',
      async () => {
        const poolAdapter = await import('../../src/core/lbug/pool-adapter.js');

        expect(poolAdapter.getPoolCapabilities(handle.repoId)).toEqual({
          fts: expect.any(Boolean),
          vector: false,
          connectionCount: 8,
        });
        await expect(poolAdapter.probePoolConnections(handle.repoId)).resolves.toBe(8);
      },
    );
  },
  {
    poolAdapter: true,
    beforeFTS: async () => {
      if (process.platform === 'win32') return;

      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } = await import(
        '../../src/core/embeddings/embedding-pipeline.js'
      );
      const { resolveAnalyzeInstallPolicy } = await import(
        '../../src/core/lbug/extension-loader.js'
      );
      const { EMBEDDING_DIMS } = await import('../../src/core/lbug/schema.js');
      const loaded = await adapter.loadVectorExtension(undefined, {
        policy: resolveAnalyzeInstallPolicy(),
      });
      if (!loaded) {
        throw new Error(
          'VECTOR is required for the non-Windows eight-connection pool regression test',
        );
      }

      await adapter.executeQuery(
        `CREATE (:Function {id: '${poolVectorNodeId}', name: 'target', filePath: 'src/vector-pool.ts', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
      );
      await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
        {
          nodeId: poolVectorNodeId,
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          embedding: [1, ...new Array(EMBEDDING_DIMS - 1).fill(0)],
        },
      ]);
      if (!(await adapter.createVectorIndex())) {
        throw new Error('Failed to create the HNSW index for the eight-connection pool test');
      }
    },
    timeout: 120_000,
  },
);

/**
 * Regression: VECTOR/HNSW index creation during analyze (#2114).
 *
 * `CALL CREATE_VECTOR_INDEX(...)` compiles to multiple statements, which
 * LadybugDB cannot run through `conn.prepare()`. Routing it through the
 * prepared `executeQuery` path (as #1655 inadvertently did when it switched the
 * singleton `executeQuery` from `conn.query()` to `conn.prepare()`) makes it
 * throw "We do not support prepare multiple statements", which `analyze`
 * swallowed and silently downgraded to exact-scan. The fix gives the adapter a
 * `createVectorIndex()` that runs the procedure via `conn.query()` (like
 * `createFTSIndex`). These tests exercise the real adapter against a real
 * LadybugDB so a revert to the prepared path fails loudly.
 */
withTestLbugDB('vector-index-creation', (handle) => {
  // VECTOR is platform-sensitive (skipped on win32 / unsupported platforms,
  // and when it cannot be installed offline). Probe once, skip the suite if
  // unavailable — mirrors the FTS-skip convention in withTestLbugDB.
  let vectorAvailable = false;
  let skipWarned = false;
  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { resolveAnalyzeInstallPolicy } = await import('../../src/core/lbug/extension-loader.js');
    // Mirror the analyze write path (`auto`: LOAD-first, then one bounded
    // INSTALL) so this suite runs wherever analyze would have vector support.
    vectorAvailable = await adapter.loadVectorExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
  });
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[withTestLbugDB(vector-index-creation)] Skipping — the LadybugDB VECTOR ' +
            'extension is unavailable (unsupported platform or could not be installed).',
        );
      }
      ctx.skip();
    }
  });

  describe('createVectorIndex', () => {
    it('creates the HNSW index via conn.query (the prepared path cannot)', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      const created = await adapter.createVectorIndex();
      expect(created).toBe(true);

      const rows = await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *');
      const idx = rows.find((r: any) => r.index_name === 'code_embedding_idx');
      expect(idx).toBeDefined();
      expect(idx.index_type).toBe('HNSW');
    });

    it('is idempotent — a second call returns true so incremental re-runs do not downgrade to exact scan', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      await adapter.createVectorIndex();
      await expect(adapter.createVectorIndex()).resolves.toBe(true);

      // No duplicate index created by the repeat call.
      const rows = await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *');
      const matches = rows.filter((r: any) => r.index_name === 'code_embedding_idx');
      expect(matches).toHaveLength(1);
    });

    it('treats a pre-existing index as ready after the connection cache is reset', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');

      await adapter.createVectorIndex();
      await adapter.closeLbug();
      await adapter.initLbug(handle.dbPath);

      // This reaches LadybugDB again after vectorIndexEnsured was cleared. The
      // engine's "already exists" response is a ready state, not a downgrade.
      await expect(adapter.createVectorIndex()).resolves.toBe(true);

      const rows = await adapter.executeQuery('CALL SHOW_INDEXES() RETURN *');
      expect(rows.filter((row: any) => row.index_name === 'code_embedding_idx')).toHaveLength(1);
    });

    it('deletes embedding rows from a persisted HNSW index after close and re-open', async () => {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      const { batchInsertEmbeddings } =
        await import('../../src/core/embeddings/embedding-pipeline.js');
      const { EMBEDDING_DIMS } = await import('../../src/core/lbug/schema.js');
      const filePath = 'src/vector-reopen-delete.ts';
      const nodeId = `Function:${filePath}:target:1`;

      await adapter.executeQuery(
        `CREATE (:Function {id: '${nodeId}', name: 'target', filePath: '${filePath}', startLine: 1, endLine: 3, isExported: true, content: '', description: ''})`,
      );
      await batchInsertEmbeddings(adapter.executeWithReusedStatement, [
        {
          nodeId,
          chunkIndex: 0,
          startLine: 1,
          endLine: 3,
          embedding: new Array(EMBEDDING_DIMS).fill(0),
        },
      ]);
      await adapter.createVectorIndex();
      await adapter.closeLbug();
      await adapter.initLbug(handle.dbPath);

      await expect(adapter.deleteNodesForFiles([filePath])).resolves.toBeUndefined();
      const rows = (await adapter.executeQuery(
        `MATCH (e:CodeEmbedding) WHERE e.nodeId = '${nodeId}' RETURN count(e) AS count`,
      )) as Array<{ count: number | bigint }>;
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
    });
  });
});

/**
 * Regression for the #2114 root cause: the prepared `executeQuery` path cannot
 * create the index. This lives in its OWN suite (a fresh, index-free DB) on
 * purpose — in the `vector-index-creation` suite above the index already exists
 * by the time this would run, so `conn.prepare()` fails with "index already
 * exists" instead of the multi-statement rejection we want to pin. With no index
 * present, `CALL CREATE_VECTOR_INDEX(...)` (which compiles to multiple
 * statements) is rejected by `conn.prepare()` with "We do not support prepare
 * multiple statements" — the exact failure that silently downgraded analyze to
 * exact-scan, and why `createVectorIndex` must use `conn.query()` instead.
 */
withTestLbugDB('vector-index-prepare-rejects', () => {
  let vectorAvailable = false;
  let skipWarned = false;
  beforeAll(async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { resolveAnalyzeInstallPolicy } = await import('../../src/core/lbug/extension-loader.js');
    vectorAvailable = await adapter.loadVectorExtension(undefined, {
      policy: resolveAnalyzeInstallPolicy(),
    });
  });
  beforeEach((ctx) => {
    if (!vectorAvailable) {
      if (!skipWarned) {
        skipWarned = true;
        console.warn(
          '[withTestLbugDB(vector-index-prepare-rejects)] Skipping — the LadybugDB VECTOR ' +
            'extension is unavailable (unsupported platform or could not be installed).',
        );
      }
      ctx.skip();
    }
  });

  it('the prepared executeQuery path rejects CREATE_VECTOR_INDEX (#2114 root cause)', async () => {
    const adapter = await import('../../src/core/lbug/lbug-adapter.js');
    const { CREATE_VECTOR_INDEX_QUERY } = await import('../../src/core/lbug/schema.js');

    // executeQuery -> executePrepared -> conn.prepare(): the multi-statement
    // CREATE_VECTOR_INDEX procedure cannot be prepared. Anchored to the specific
    // error so the test can only pass for the #2114 reason — not for an
    // unrelated throw (e.g. a missing table or an already-existing index).
    await expect(adapter.executeQuery(CREATE_VECTOR_INDEX_QUERY)).rejects.toThrow(
      /prepare multiple statements/i,
    );
  });
});
