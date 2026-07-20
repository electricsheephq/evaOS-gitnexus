export interface DoctorPoolProbe {
  fts: boolean;
  vector: boolean;
  exercisedConnections: number;
  connectionCount: number;
  reason: string | null;
}

interface DoctorPoolAdapter {
  closeLbug(repoId?: string): Promise<void>;
  getPoolCapabilities(repoId: string): {
    fts: boolean;
    vector: boolean;
    connectionCount: number;
  } | null;
  initLbugNonRecovering(repoId: string, dbPath: string): Promise<void>;
  probePoolConnections(repoId: string): Promise<number>;
}

const EXPECTED_POOL_CONNECTIONS = 8;

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
    if (!pool.initLbugNonRecovering || !pool.getPoolCapabilities || !pool.probePoolConnections) {
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
    return {
      fts: capabilities.fts,
      vector: capabilities.vector,
      exercisedConnections,
      connectionCount: capabilities.connectionCount,
      reason: null,
    };
  } catch (error) {
    return {
      fts: false,
      vector: false,
      exercisedConnections: 0,
      connectionCount: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (closePool) await closePool(repoId).catch(() => {});
  }
}
