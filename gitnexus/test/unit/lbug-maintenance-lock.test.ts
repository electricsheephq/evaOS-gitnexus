import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir } from '../helpers/test-db.js';

vi.mock('@ladybugdb/core', () => ({ default: {} }));

describe('LadybugDB maintenance open', () => {
  afterEach(() => {
    vi.doUnmock('../../src/core/lbug/lbug-config.js');
    vi.doUnmock('../../src/core/lbug/sidecar-recovery.js');
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('holds the init lock while running the non-recovering sidecar preflight', async () => {
    const fixture = await createTempDir('gitnexus-maintenance-lock-');
    const dbPath = path.join(fixture.dbPath, 'lbug');
    const lockPath = `${dbPath}.init.lock`;
    await fs.writeFile(dbPath, 'fixture');

    const preflightLbugSidecars = vi.fn(async () => {
      const record = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      expect(record.pid).toBe(process.pid);
    });
    const closeLbugConnection = vi.fn(async () => undefined);

    vi.doMock('../../src/core/lbug/lbug-config.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/lbug-config.js')>()),
      openLbugConnection: vi.fn(async () => ({ db: {}, conn: {} })),
      closeLbugConnection,
    }));
    vi.doMock('../../src/core/lbug/sidecar-recovery.js', async (importActual) => ({
      ...(await importActual<typeof import('../../src/core/lbug/sidecar-recovery.js')>()),
      preflightLbugSidecars,
    }));

    try {
      const adapter = await import('../../src/core/lbug/lbug-adapter.js');
      await adapter.initLbugForMaintenance(dbPath);

      expect(preflightLbugSidecars).toHaveBeenCalledWith(dbPath, {
        mode: 'write',
        logger: expect.anything(),
        allowQuarantine: false,
      });
      await expect(fs.access(lockPath)).rejects.toThrow();
      await adapter.closeLbug();
    } finally {
      await fixture.cleanup();
    }
  });
});
