/**
 * Swift same-module return-type typeBinding mirroring for the
 * `mirrorNamespaceTypeBindings` hook.
 *
 * Swift gives every file in a module (an SPM target) visibility of every
 * sibling's top-level declarations without a syntactic `import`. For a
 * chained call like
 *
 *   App.swift:    let user = getUser(); user.save()   // user → getUser → ?
 *   Models.swift: func getUser() -> User { … }        // getUser → User
 *
 * to resolve `user.save()` cross-file, App.swift's scope chain must be
 * able to follow `getUser → User`. The function return-type binding
 * (`getUser → User`) lives on Models.swift's module scope, so we mirror
 * sibling module-scope typeBindings once into the target's shared
 * `namespaceTypeBindings` channel. Each module scope is gated to its target
 * through `accessibleNamespacesByScope`, so lookup sees exactly its siblings
 * without the old O(files x bindings) per-module copy. Swift has no
 * namespace-import edges, so module membership is the SPM target subtree
 * (`Sources/<Target>/…`): threaded in via the SPM target map
 * (`resolutionConfig` → `coerceSwiftTargets`) and grouped by
 * `groupSwiftFilesBySpmTarget` (replicating legacy `groupSwiftFilesByTarget`;
 * no-source-dir → all files form one `__default__` module).
 *
 * Runs after `populateNamespaceSiblings` and before
 * `propagateImportedReturnTypes`, so the SCC-ordered propagation pass
 * sees the mirrored bindings and chains `user → getUser → User` to the
 * terminal class. Each mirrored binding is chain-followed inside its
 * source module first so we mirror the terminal type, not an intermediate
 * intra-module reference. `Scope.typeBindings` is mutated via the
 * sanctioned non-frozen Map cast (Contract Invariant I6).
 */

import type { ParsedFile, ScopeId, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

export function mirrorSwiftSiblingTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  resolutionConfig?: unknown,
): void {
  const moduleScopeByFile = workspaceIndex.moduleScopeByFile;

  // Group files by SPM target subtree (the module). No-source-dir → all
  // files in one `__default__` bucket.
  const targets = coerceSwiftTargets(resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );
  const sharedTypes = indexes.namespaceTypeBindings as Map<string, Map<string, TypeRef>>;
  const accessibleTargets = indexes.accessibleNamespacesByScope as Map<ScopeId, string[]>;

  for (const [targetName, group] of filesByTarget) {
    if (group.length < 2) continue; // no siblings to mirror from
    const targetKey = `swift-target:${targetName}`;
    let targetTypes = sharedTypes.get(targetKey);
    if (targetTypes === undefined) {
      targetTypes = new Map<string, TypeRef>();
      sharedTypes.set(targetKey, targetTypes);
    }

    for (const parsed of group) {
      registerTargetAccess(accessibleTargets, parsed.moduleScope, targetKey);
    }
    for (const parsed of group) {
      const sourceModule = moduleScopeByFile.get(parsed.filePath);
      if (sourceModule === undefined) continue;
      for (const [name, ref] of sourceModule.typeBindings) {
        if (name.length === 0 || targetTypes.has(name)) continue;
        targetTypes.set(name, followChainPostFinalize(ref, sourceModule.id, indexes));
      }
    }
  }
}

function registerTargetAccess(
  accessibleTargets: Map<ScopeId, string[]>,
  scopeId: ScopeId,
  targetKey: string,
): void {
  const existing = accessibleTargets.get(scopeId);
  if (existing === undefined) {
    accessibleTargets.set(scopeId, [targetKey]);
  } else if (!existing.includes(targetKey)) {
    existing.push(targetKey);
  }
}
