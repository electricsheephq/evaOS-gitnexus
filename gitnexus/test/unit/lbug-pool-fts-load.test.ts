import { afterEach, describe, expect, it, vi } from 'vitest';

const { connections, loadFTSExtensionMock, loadVectorExtensionMock } = vi.hoisted(() => ({
  connections: [] as any[],
  loadFTSExtensionMock: vi.fn(),
  loadVectorExtensionMock: vi.fn(),
}));

vi.mock('@ladybugdb/core', () => ({
  default: {
    Database: vi.fn(),
    Connection: vi.fn(function (this: any) {
      this.close = vi.fn().mockResolvedValue(undefined);
      this.prepare = vi.fn().mockResolvedValue({
        isSuccess: () => true,
        getErrorMessage: vi.fn().mockResolvedValue(''),
      });
      this.execute = vi.fn().mockResolvedValue({
        getAll: vi.fn().mockResolvedValue([{ ok: 1 }]),
        close: vi.fn(),
      });
      connections.push(this);
    }),
  },
}));

vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  isReadOnlyDbError: vi.fn(() => false),
  loadFTSExtension: loadFTSExtensionMock,
  loadVectorExtension: loadVectorExtensionMock,
}));

vi.mock('../../src/core/lbug/lbug-config.js', () => ({
  createLbugDatabase: vi.fn(),
  toNativeSafePath: vi.fn((p: string) => p),
  isWalCorruptionError: vi.fn(() => false),
  WAL_RECOVERY_SUGGESTION: '',
}));

const {
  closeLbug,
  getPoolCapabilities,
  initLbugWithDb,
  isLbugReady,
  probePoolConnections,
} = await import('../../src/core/lbug/pool-adapter.js');

describe('read-pool optional extension loading', () => {
  afterEach(async () => {
    await closeLbug().catch(() => {});
    loadFTSExtensionMock.mockReset();
    loadVectorExtensionMock.mockReset();
    connections.length = 0;
  });

  it('loads FTS and VECTOR with load-only policy on all eight connections', async () => {
    loadFTSExtensionMock.mockImplementation(async () => {
      expect(isLbugReady('repo-a')).toBe(false);
      return true;
    });
    loadVectorExtensionMock.mockImplementation(async () => {
      expect(isLbugReady('repo-a')).toBe(false);
      return true;
    });
    const db = {} as any;

    await initLbugWithDb('repo-a', db, '/tmp/pool-extension-success-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(8);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(8);
    expect(loadFTSExtensionMock).toHaveBeenCalledWith(expect.anything(), { policy: 'load-only' });
    expect(loadVectorExtensionMock).toHaveBeenCalledWith(expect.anything(), {
      policy: 'load-only',
    });
    expect(getPoolCapabilities('repo-a')).toEqual({
      fts: true,
      vector: true,
      connectionCount: 8,
    });
    await expect(probePoolConnections('repo-a')).resolves.toBe(8);
    expect(connections).toHaveLength(8);
    expect(connections.every((connection) => connection.prepare.mock.calls.length === 1)).toBe(
      true,
    );
  });

  it('keeps graph ready but disables a capability when one connection fails to load it', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadFTSExtensionMock.mockResolvedValueOnce(false);
    loadVectorExtensionMock.mockResolvedValue(true);
    const db = {} as any;

    await initLbugWithDb('repo-partial', db, '/tmp/pool-extension-partial-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(8);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(8);
    expect(isLbugReady('repo-partial')).toBe(true);
    expect(getPoolCapabilities('repo-partial')).toEqual({
      fts: false,
      vector: true,
      connectionCount: 8,
    });
  });

  it('disables VECTOR for the pool when only one connection lacks it', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValueOnce(false);

    await initLbugWithDb('repo-vector-partial', {} as any, '/tmp/pool-vector-partial-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(8);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(8);
    expect(isLbugReady('repo-vector-partial')).toBe(true);
    expect(getPoolCapabilities('repo-vector-partial')).toEqual({
      fts: true,
      vector: false,
      connectionCount: 8,
    });
  });

  it('prepares every connection for each alias sharing a Database', async () => {
    loadFTSExtensionMock.mockResolvedValue(true);
    loadVectorExtensionMock.mockResolvedValue(true);
    const db = {} as any;

    await initLbugWithDb('repo-alias-a', db, '/tmp/pool-extension-alias-db');
    await initLbugWithDb('repo-alias-b', db, '/tmp/pool-extension-alias-db');

    expect(loadFTSExtensionMock).toHaveBeenCalledTimes(16);
    expect(loadVectorExtensionMock).toHaveBeenCalledTimes(16);
    expect(getPoolCapabilities('repo-alias-a')).toMatchObject({ fts: true, vector: true });
    expect(getPoolCapabilities('repo-alias-b')).toMatchObject({
      fts: true,
      vector: true,
    });
  });
});
