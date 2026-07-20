import { beforeEach, describe, expect, it, vi } from 'vitest';

const poolMocks = vi.hoisted(() => ({
  closeLbug: vi.fn().mockResolvedValue(undefined),
  getPoolCapabilities: vi.fn(),
  initLbugNonRecovering: vi.fn().mockResolvedValue(undefined),
  probePoolConnections: vi.fn().mockResolvedValue(8),
}));

vi.mock('../../src/core/lbug/pool-adapter.js', () => poolMocks);

const { probeDoctorPool } = await import('../../src/cli/doctor.js');

describe('doctor real read-pool probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    poolMocks.initLbugNonRecovering.mockResolvedValue(undefined);
    poolMocks.probePoolConnections.mockResolvedValue(8);
    poolMocks.getPoolCapabilities.mockReturnValue({
      fts: true,
      vector: true,
      connectionCount: 8,
    });
  });

  it('uses non-recovering initialization and exercises all eight connections', async () => {
    const result = await probeDoctorPool('/repo/.gitnexus/lbug');

    expect(poolMocks.initLbugNonRecovering).toHaveBeenCalledWith(
      expect.stringMatching(/^doctor:/),
      '/repo/.gitnexus/lbug',
    );
    expect(poolMocks.probePoolConnections).toHaveBeenCalledOnce();
    expect(result).toEqual({
      fts: true,
      vector: true,
      exercisedConnections: 8,
      connectionCount: 8,
      reason: null,
    });
    expect(poolMocks.closeLbug).toHaveBeenCalledOnce();
  });

  it('reports aggregate optional-extension failure without losing graph-pool evidence', async () => {
    poolMocks.getPoolCapabilities.mockReturnValue({
      fts: true,
      vector: false,
      connectionCount: 8,
    });

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: true,
      vector: false,
      exercisedConnections: 8,
      connectionCount: 8,
    });
  });

  it('closes the diagnostic pool when non-recovering initialization fails', async () => {
    poolMocks.initLbugNonRecovering.mockRejectedValue(new Error('WAL requires recovery'));

    await expect(probeDoctorPool('/repo/.gitnexus/lbug')).resolves.toMatchObject({
      fts: false,
      vector: false,
      exercisedConnections: 0,
      reason: 'WAL requires recovery',
    });
    expect(poolMocks.probePoolConnections).not.toHaveBeenCalled();
    expect(poolMocks.closeLbug).toHaveBeenCalledOnce();
  });
});
