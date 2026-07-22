import { describe, expect, it } from 'vitest';

import { completionUpdateForWorkerResult } from '../../src/server/analyze-launch.js';
import type { AnalyzeResultIpc } from '../../src/server/analyze-worker-ipc.js';

const result = (recoveredPromotionOnly?: boolean): AnalyzeResultIpc => ({
  repoName: 'demo',
  repoPath: '/repos/demo',
  stats: { nodes: 10, edges: 12 },
  alreadyUpToDate: undefined,
  recoveredPromotionOnly,
  ftsRepairedOnly: undefined,
  ftsSkipped: undefined,
});

describe('analyze worker recovery-only parent contract', () => {
  it('fails closed with retry guidance instead of reporting ordinary completion', () => {
    expect(completionUpdateForWorkerResult(result(true))).toEqual({
      status: 'failed',
      repoName: 'demo',
      error:
        'Recovered a previous staged promotion, but the current checkout was not analyzed. ' +
        'Start a new analysis with force=true and dropEmbeddings=true ' +
        '(CLI: `gitnexus analyze --staged --drop-embeddings`).',
    });
  });

  it('keeps an ordinary successful analysis complete', () => {
    expect(completionUpdateForWorkerResult(result())).toEqual({
      status: 'complete',
      repoName: 'demo',
    });
  });
});
