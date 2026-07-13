import type { NodeLabel } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';

import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import {
  buildGraphNodeLookup,
  qualifiedKey,
  simpleKey,
} from '../../../src/core/ingestion/scope-resolution/graph-bridge/node-lookup.js';

const FILE = 'src/service.ts';

interface Candidate {
  id: string;
  startLine: number;
}

function buildLookup(candidates: readonly Candidate[]) {
  const graph = createKnowledgeGraph();
  for (const candidate of candidates) {
    graph.addNode({
      id: candidate.id,
      label: 'Method' as NodeLabel,
      properties: {
        name: 'save',
        qualifiedName: 'Service.save',
        filePath: FILE,
        startLine: candidate.startLine,
      },
    });
  }
  return buildGraphNodeLookup(graph);
}

describe('buildGraphNodeLookup determinism', () => {
  it('selects the earliest source definition regardless of graph insertion order', () => {
    const early = { id: `Method:${FILE}:Service.save#1`, startLine: 10 };
    const late = { id: `Method:${FILE}:Service.save#2`, startLine: 20 };

    const lateFirst = buildLookup([late, early]);
    const earlyFirst = buildLookup([early, late]);

    for (const key of [simpleKey(FILE, 'save'), qualifiedKey(FILE, 'Method', 'Service.save')]) {
      expect(lateFirst.get(key)).toBe(early.id);
      expect(earlyFirst.get(key)).toBe(early.id);
    }
  });

  it('uses the stable node id when source positions are identical', () => {
    const first = { id: `Method:${FILE}:Service.save#1`, startLine: 10 };
    const second = { id: `Method:${FILE}:Service.save#2`, startLine: 10 };

    const firstLookup = buildLookup([second, first]);
    const secondLookup = buildLookup([first, second]);

    expect(firstLookup.get(simpleKey(FILE, 'save'))).toBe(first.id);
    expect(secondLookup.get(simpleKey(FILE, 'save'))).toBe(first.id);
  });
});
