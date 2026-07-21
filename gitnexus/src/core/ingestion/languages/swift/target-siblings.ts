/**
 * Swift same-module (SPM target) implicit visibility for the
 * `populateNamespaceSiblings` hook.
 *
 * Swift gives every file in a module access to every other file's
 * top-level declarations WITHOUT any `import` statement (whole-module
 * visibility). This is the Swift analogue of Go's same-package sibling
 * visibility — `populateGoPackageSiblings` is the template.
 *
 * Module identity: Swift has no in-source `package X` marker. The SPM
 * target is a directory subtree (`Sources/<Target>/…`). Module membership
 * is threaded in via the SPM target map (`ctx.resolutionConfig` →
 * `coerceSwiftTargets`) and grouped by `groupSwiftFilesBySpmTarget`,
 * replicating legacy `wireSwiftImplicitImports`'s `groupSwiftFilesByTarget`:
 * files are grouped by SPM target subtree when a package config is present,
 * else ALL Swift files form one module (`__default__`,
 * single-Xcode-project assumption). Every `.swift` file in the same target
 * sees its siblings' top-level defs.
 *
 * Bindings are added once per SPM target through the shared
 * `namespaceFqnBindings` channel, gated for each module scope by
 * `accessibleNamespacesByScope`. This preserves same-target visibility and
 * local-first lookup without copying every target definition into every file
 * (the old O(files x definitions) fan-out exhausted the heap on large Xcode
 * workspaces with no Package.swift).
 */

import type { BindingRef, ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

export function populateSwiftTargetSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly resolutionConfig?: unknown;
  },
): void {
  // Group files by SPM target subtree (the module). No-source-dir → all
  // files in one `__default__` bucket.
  const targets = coerceSwiftTargets(ctx.resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(
    parsedFiles,
    (parsed) => parsed.filePath,
    targets,
  );

  const namespaceBindings = indexes.namespaceFqnBindings as Map<string, Map<string, BindingRef[]>>;
  const accessibleTargets = indexes.accessibleNamespacesByScope as Map<ScopeId, string[]>;

  for (const [targetName, group] of filesByTarget) {
    if (group.length < 2) continue; // no siblings to share
    const targetKey = `swift-target:${targetName}`;
    let targetBindings = namespaceBindings.get(targetKey);
    if (targetBindings === undefined) {
      targetBindings = new Map<string, BindingRef[]>();
      namespaceBindings.set(targetKey, targetBindings);
    }
    const seenByName = new Map<string, Set<string>>();

    for (const parsed of group) {
      registerTargetAccess(accessibleTargets, parsed.moduleScope, targetKey);
      for (const def of parsed.localDefs) {
        const name = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
        if (name === '') continue;
        let bucket = targetBindings.get(name);
        if (bucket === undefined) {
          bucket = [];
          targetBindings.set(name, bucket);
        }
        let seen = seenByName.get(name);
        if (seen === undefined) {
          seen = new Set(bucket.map((binding) => binding.def.nodeId));
          seenByName.set(name, seen);
        }
        if (seen.has(def.nodeId)) continue;
        seen.add(def.nodeId);
        bucket.push({ def, origin: 'namespace' });
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
