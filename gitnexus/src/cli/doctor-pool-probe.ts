import {
  EMBEDDING_DIMS,
  EMBEDDING_INDEX_NAME,
  EMBEDDING_TABLE_NAME,
} from '../core/lbug/schema.js';

export interface DoctorPoolProbe {
  fts: boolean;
  vector: boolean;
  vectorIndex: boolean;
  vectorIndexReason:
    | 'vector-extension-unavailable'
    | 'vector-index-missing-or-unqueryable'
    | 'pool-probe-unavailable'
    | null;
  exercisedConnections: number;
  connectionCount: number;
  reason: string | null;
}

interface DoctorPoolAdapter {
  closeLbug(repoId?: string): Promise<void>;
  executeQuery(repoId: string, cypher: string): Promise<unknown[]>;
  getPoolCapabilities(repoId: string): {
    fts: boolean;
    vector: boolean;
    connectionCount: number;
  } | null;
  initLbugNonRecovering(repoId: string, dbPath: string): Promise<void>;
  probePoolConnections(repoId: string): Promise<number>;
}

export const EXPECTED_POOL_CONNECTIONS = 8;

const ZERO_VECTOR = `[${Array.from({ length: EMBEDDING_DIMS }, () => '0').join(',')}]`;
const VECTOR_INDEX_PROBE_QUERY = `
  CALL QUERY_VECTOR_INDEX('${EMBEDDING_TABLE_NAME}', '${EMBEDDING_INDEX_NAME}',
    CAST(${ZERO_VECTOR} AS FLOAT[${EMBEDDING_DIMS}]), 1)
  YIELD node AS emb, distance
  RETURN distance
`;

/**
 * Probe the production indexed read pool without invoking a recovery path.
 * Optional extensions are aggregated across every pre-warmed connection by
 * the pool adapter before this diagnostic reports them as live capabilities.
 */
export async function probeDoctorPool(dbPath: string): Promise<DoctorPoolProbe> {
  const repoId = `doctor:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let closePool: DoctorPoolAdapter['closeLbug'] | undefined;
  try {
    // Keep the native pool out of the static CLI import graph so diagnostics
    // can still report a missing or broken lbugjs.node module.
    const pool =
      (await import('../core/lbug/pool-adapter.js')) as unknown as Partial<DoctorPoolAdapter>;
    closePool = pool.closeLbug;
    if (
      !closePool ||
      !pool.executeQuery ||
      !pool.initLbugNonRecovering ||
      !pool.getPoolCapabilities ||
      !pool.probePoolConnections
    ) {
      throw new Error('non-recovering read-pool capability probe is unavailable');
    }

    await pool.initLbugNonRecovering(repoId, dbPath);
    const capabilities = pool.getPoolCapabilities(repoId);
    if (!capabilities) throw new Error('read pool did not publish capability state');
    const exercisedConnections = await pool.probePoolConnections(repoId);
    if (
      capabilities.connectionCount !== EXPECTED_POOL_CONNECTIONS ||
      exercisedConnections !== EXPECTED_POOL_CONNECTIONS
    ) {
      throw new Error('read-pool capability probe did not exercise all eight connections');
    }
    let vectorIndex = false;
    let vectorIndexReason: DoctorPoolProbe['vectorIndexReason'] =
      'vector-extension-unavailable';
    if (capabilities.vector) {
      try {
        // A successful zero-result query is still proof that the named HNSW
        // index exists and is queryable. Extension loading alone is not:
        // QUERY_VECTOR_INDEX prepares successfully only when this database has
        // the exact index production semantic retrieval uses.
        await pool.executeQuery(repoId, VECTOR_INDEX_PROBE_QUERY);
        vectorIndex = true;
        vectorIndexReason = null;
      } catch {
        vectorIndexReason = 'vector-index-missing-or-unqueryable';
      }
    }
    return {
      fts: capabilities.fts,
      vector: capabilities.vector,
      vectorIndex,
      vectorIndexReason,
      exercisedConnections,
      connectionCount: capabilities.connectionCount,
      reason: null,
    };
  } catch (error) {
    return {
      fts: false,
      vector: false,
      vectorIndex: false,
      vectorIndexReason: 'pool-probe-unavailable',
      exercisedConnections: 0,
      connectionCount: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (closePool) await closePool(repoId).catch(() => {});
  }
}
