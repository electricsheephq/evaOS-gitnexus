import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { runFullAnalysisMock, boundedCheckpointMock } = vi.hoisted(() => ({
  runFullAnalysisMock: vi.fn(),
  boundedCheckpointMock: vi.fn(),
}));

vi.mock('../../src/core/run-analyze.js', () => ({ runFullAnalysis: runFullAnalysisMock }));
vi.mock('../../src/core/lbug/shutdown-helpers.js', () => ({
  boundedCheckpointBeforeExit: boundedCheckpointMock,
}));
vi.mock('../../src/core/lbug/lbug-adapter.js', () => ({
  closeLbug: vi.fn(async () => undefined),
  closeLbugBeforeExit: vi.fn(async () => undefined),
  isLbugReady: vi.fn(() => false),
  LbugWipeError: class LbugWipeError extends Error {},
}));
vi.mock('../../src/storage/repo-manager.js', () => ({
  getStoragePaths: vi.fn(() => ({ storagePath: '.gitnexus', lbugPath: '.gitnexus/lbug' })),
  getGlobalRegistryPath: vi.fn(() => 'registry.json'),
  RegistryNameCollisionError: class RegistryNameCollisionError extends Error {},
  AnalysisNotFinalizedError: class AnalysisNotFinalizedError extends Error {},
  assertAnalysisFinalized: vi.fn(async () => undefined),
}));
vi.mock('../../src/storage/git.js', () => ({
  getGitRoot: vi.fn(() => '/repo'),
  hasGitDir: vi.fn(() => true),
  getDefaultBranch: vi.fn(() => null),
}));
vi.mock('../../src/core/ingestion/utils/max-file-size.js', () => ({
  getMaxFileSizeBannerMessage: vi.fn(() => null),
}));
vi.mock('../../src/cli/ai-context.js', () => ({
  refreshBaseRefLine: vi.fn(async () => ({ files: [] })),
}));

describe('analyze SIGTERM checkpoint shutdown', () => {
  let savedNodeOptions: string | undefined;
  let savedResourceLog: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    runFullAnalysisMock.mockReset();
    boundedCheckpointMock.mockReset();
    savedNodeOptions = process.env.NODE_OPTIONS;
    savedResourceLog = process.env.GITNEXUS_ANALYZE_RESOURCE_LOG;
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    delete process.env.GITNEXUS_ANALYZE_RESOURCE_LOG;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedNodeOptions;
    if (savedResourceLog === undefined) delete process.env.GITNEXUS_ANALYZE_RESOURCE_LOG;
    else process.env.GITNEXUS_ANALYZE_RESOURCE_LOG = savedResourceLog;
    process.exitCode = undefined;
  });

  it('routes SIGTERM through the bounded checkpoint helper with exit code 143', async () => {
    let finishAnalysis!: (value: unknown) => void;
    runFullAnalysisMock.mockReturnValue(
      new Promise((resolve) => {
        finishAnalysis = resolve;
      }),
    );
    boundedCheckpointMock.mockImplementation(async (options) => {
      await options.beforeExit?.();
    });
    const baseline = new Set(process.listeners('SIGTERM'));
    const { analyzeCommand } = await import('../../src/cli/analyze.js');
    const running = analyzeCommand(undefined, {});
    await vi.waitFor(() => expect(runFullAnalysisMock).toHaveBeenCalledTimes(1));
    const listener = process.listeners('SIGTERM').find((candidate) => !baseline.has(candidate));
    expect(listener).toBeDefined();

    listener?.('SIGTERM');
    await vi.waitFor(() => expect(boundedCheckpointMock).toHaveBeenCalledTimes(1));
    expect(boundedCheckpointMock.mock.calls[0][0]).toMatchObject({ exitCode: 143 });
    expect(typeof boundedCheckpointMock.mock.calls[0][0].beforeExit).toBe('function');

    finishAnalysis({
      repoName: 'repo',
      repoPath: '/repo',
      stats: {},
      alreadyUpToDate: true,
    });
    await running;
    expect(process.listeners('SIGTERM')).not.toContain(listener);
  });
});
