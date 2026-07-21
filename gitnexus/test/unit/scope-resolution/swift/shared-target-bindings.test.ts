import { describe, expect, it } from 'vitest';
import type { ParsedFile, Scope, ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import { finalizeScopeModel } from '../../../../src/core/ingestion/finalize-orchestrator.js';
import { populateSwiftTargetSiblings } from '../../../../src/core/ingestion/languages/swift/target-siblings.js';
import { mirrorSwiftSiblingTypeBindings } from '../../../../src/core/ingestion/languages/swift/sibling-type-bindings.js';
import { buildWorkspaceResolutionIndex } from '../../../../src/core/ingestion/scope-resolution/workspace-index.js';
import {
  findReceiverTypeBinding,
  lookupBindingsAt,
} from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';

const RANGE = { startLine: 1, startCol: 0, endLine: 10, endCol: 0 } as const;

function parsedFile(
  filePath: string,
  defName: string,
  typeBindings: ReadonlyMap<string, TypeRef> = new Map(),
): ParsedFile {
  const moduleScope = `scope:${filePath}#1:0-10:0:Module` as ScopeId;
  const def: SymbolDefinition = {
    nodeId: `def:${filePath}:${defName}`,
    filePath,
    type: 'Class',
    qualifiedName: defName,
  };
  const scope: Scope = {
    id: moduleScope,
    parent: null,
    kind: 'Module',
    range: RANGE,
    filePath,
    bindings: new Map([[defName, [{ def, origin: 'local' }]]]),
    ownedDefs: [def],
    imports: [],
    typeBindings,
  };
  return {
    filePath,
    moduleScope,
    scopes: [scope],
    parsedImports: [],
    localDefs: [def],
    referenceSites: [],
  };
}

function populate(
  parsedFiles: readonly ParsedFile[],
  targets: ReadonlyMap<string, string> | null = null,
) {
  const indexes = finalizeScopeModel(parsedFiles);
  const workspaceIndex = buildWorkspaceResolutionIndex(parsedFiles, indexes.scopeTree);
  const resolutionConfig = targets === null ? undefined : { targets };
  populateSwiftTargetSiblings(parsedFiles, indexes, {
    fileContents: new Map(),
    resolutionConfig,
  });
  mirrorSwiftSiblingTypeBindings(parsedFiles, indexes, workspaceIndex, resolutionConfig);
  return { indexes, workspaceIndex };
}

function totalBindingRefs(
  buckets: ReadonlyMap<string, ReadonlyMap<string, readonly unknown[]>>,
): number {
  let total = 0;
  for (const names of buckets.values()) {
    for (const refs of names.values()) total += refs.length;
  }
  return total;
}

describe('Swift same-target shared binding channels', () => {
  it('stores one binding per definition instead of copying every definition to every module', () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      parsedFile(`Sources/App/File${i}.swift`, `Type${i}`),
    );

    const { indexes } = populate(files);

    expect(indexes.bindingAugmentations.size).toBe(0);
    expect(indexes.namespaceFqnBindings.size).toBe(1);
    expect(totalBindingRefs(indexes.namespaceFqnBindings)).toBe(100);
    expect(indexes.accessibleNamespacesByScope.size).toBe(100);
  });

  it('preserves local-first lookup and isolates definitions between SPM targets', () => {
    const alphaLocal = parsedFile('Sources/Alpha/A.swift', 'User');
    const alphaSibling = parsedFile('Sources/Alpha/B.swift', 'User');
    const beta = parsedFile('Sources/Beta/User.swift', 'User');
    const targets = new Map([
      ['Alpha', 'Sources/Alpha'],
      ['Beta', 'Sources/Beta'],
    ]);

    const { indexes } = populate([alphaLocal, alphaSibling, beta], targets);
    const refs = lookupBindingsAt(alphaLocal.moduleScope, 'User', indexes);

    expect(refs.map((ref) => ref.def.nodeId)).toEqual([
      'def:Sources/Alpha/A.swift:User',
      'def:Sources/Alpha/B.swift:User',
    ]);
    expect(refs.some((ref) => ref.def.filePath.startsWith('Sources/Beta/'))).toBe(false);
  });

  it('shares return-type bindings once per target without mutating sibling module scopes', () => {
    const sourceScope = 'scope:Sources/App/Models.swift#1:0-10:0:Module' as ScopeId;
    const getUserType: TypeRef = {
      rawName: 'User',
      declaredAtScope: sourceScope,
      source: 'return-annotation',
    };
    const source = parsedFile(
      'Sources/App/Models.swift',
      'User',
      new Map([['getUser', getUserType]]),
    );
    const consumer = parsedFile('Sources/App/App.swift', 'App');

    const { indexes } = populate([source, consumer]);

    const consumerModule = indexes.scopeTree.getScope(consumer.moduleScope)!;
    expect(consumerModule.typeBindings.has('getUser')).toBe(false);
    expect(indexes.namespaceTypeBindings.size).toBe(1);
    expect(findReceiverTypeBinding(consumer.moduleScope, 'getUser', indexes)).toEqual(getUserType);
  });
});
