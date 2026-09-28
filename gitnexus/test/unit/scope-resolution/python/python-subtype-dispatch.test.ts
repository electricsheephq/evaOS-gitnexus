import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/captures.js';
import {
  applyPythonSubtypeDispatchSideChannel,
  beginPythonSubtypeDispatchCapture,
  collectPythonSubtypeDispatchSideChannel,
} from '../../../../src/core/ingestion/languages/python/subtype-dispatch.js';
import { pythonMissingReceiverSubtypeCandidateCompatibility } from '../../../../src/core/ingestion/languages/python/scope-resolver.js';

const callerSource = [
  'class Caller:',
  '    def positional(self, value):',
  '        return self.target(value)',
  '    def keyword(self, value):',
  '        return self.target(value=value)',
  '    def too_few(self):',
  '        return self.target()',
  '    def too_many(self, value):',
  '        return self.target(value, value)',
].join('\n');

const targetSource = [
  'class Worker:',
  '    def target(self, value):',
  '        return value',
  'class KeywordOnly:',
  '    def target(self, *, value=0):',
  '        return value',
  'class PositionalOnly:',
  '    def target(self, value, /):',
  '        return value',
  'class RequiredKeywordOnly:',
  '    def target(self, value=0, *, required):',
  '        return value + required',
].join('\n');

const aliasedClassmethodSource = [
  'from builtins import classmethod as cm',
  'class AliasedCaller:',
  '    @cm',
  '    def dispatch(owner, value):',
  '        return owner.target(value)',
].join('\n');

const zeroArgumentTargetsSource = [
  'class ReceiverlessWorker:',
  '    def target():',
  '        return 1',
  'class InstanceWorker:',
  '    def target(self):',
  '        return 1',
  'class StaticWorker:',
  '    @staticmethod',
  '    def target():',
  '        return 1',
].join('\n');

const candidate = (line: number): SymbolDefinition => ({
  nodeId: `def:targets.py#${line}:4:Method:target`,
  filePath: 'targets.py',
  type: 'Method',
  parameterCount: 1,
  requiredParameterCount: 1,
});

const positionalSite = {
  arity: 1,
  atRange: { startLine: 3, startCol: 15, endLine: 3, endCol: 33 },
};
const keywordSite = {
  arity: 1,
  atRange: { startLine: 5, startCol: 15, endLine: 5, endCol: 39 },
};
const tooFewSite = {
  atRange: { startLine: 7, startCol: 15, endLine: 7, endCol: 28 },
};
const tooManySite = {
  atRange: { startLine: 9, startCol: 15, endLine: 9, endCol: 40 },
};

describe('Python missing-member subtype argument shapes', () => {
  it('rejects receiverless instance methods while preserving zero-argument descriptors', () => {
    emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(zeroArgumentTargetsSource, 'zero-targets.py');

    const zeroCandidate = (line: number): SymbolDefinition => ({
      nodeId: `def:zero-targets.py#${line}:4:Method:target`,
      filePath: 'zero-targets.py',
      type: 'Method',
      parameterCount: 0,
      requiredParameterCount: 0,
    });

    expect([
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, zeroCandidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, zeroCandidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, zeroCandidate(9)),
    ]).toEqual(['unknown', 'compatible', 'compatible']);
  });

  it('keeps unproven decorator aliases out of instance-subtype inference', () => {
    emitPythonScopeCaptures(aliasedClassmethodSource, 'aliased-caller.py');
    emitPythonScopeCaptures(targetSource, 'targets.py');

    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'aliased-caller.py',
        {
          arity: 1,
          atRange: { startLine: 5, startCol: 15, endLine: 5, endCol: 34 },
        },
        candidate(2),
      ),
    ).toBe('unknown');
  });

  it('declines unknown target decorators without losing known descriptor targets', () => {
    emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(targetSource, 'targets.py');

    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(2),
        ['@am'],
      ),
    ).toBe('unknown');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(2),
        ['@staticmethod'],
      ),
    ).toBe('compatible');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(2),
        ['@builtins.classmethod'],
      ),
    ).toBe('compatible');
  });

  it('preserves simple positional compatibility across capture snapshot restore', () => {
    const captures = emitPythonScopeCaptures(callerSource, 'caller.py');
    emitPythonScopeCaptures(targetSource, 'targets.py');
    const callerSnapshot = collectPythonSubtypeDispatchSideChannel('caller.py');
    const targetSnapshot = collectPythonSubtypeDispatchSideChannel('targets.py');

    expect(callerSnapshot).toBeDefined();
    expect(targetSnapshot).toBeDefined();
    expect(() => structuredClone(callerSnapshot)).not.toThrow();
    expect(() => structuredClone(targetSnapshot)).not.toThrow();
    expect(captures.every((capture) => capture['@reference.arity'] === undefined)).toBe(true);
    expect(callerSnapshot?.simplePositionalCalls).toEqual([
      [3, 15, 1],
      [7, 15, 0],
      [9, 15, 2],
    ]);

    const fresh = [
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', keywordSite, candidate(8)),
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(11),
      ),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooManySite, candidate(2)),
    ];
    expect(fresh).toEqual([
      'compatible',
      'incompatible',
      'unknown',
      'unknown',
      'incompatible',
      'incompatible',
    ]);

    beginPythonSubtypeDispatchCapture('caller.py');
    beginPythonSubtypeDispatchCapture('targets.py');
    expect(
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
    ).toBe('unknown');

    applyPythonSubtypeDispatchSideChannel({
      filePath: 'caller.py',
      captureSideChannel: callerSnapshot,
    } as ParsedFile);
    applyPythonSubtypeDispatchSideChannel({
      filePath: 'targets.py',
      captureSideChannel: targetSnapshot,
    } as ParsedFile);

    expect([
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', positionalSite, candidate(5)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', keywordSite, candidate(8)),
      pythonMissingReceiverSubtypeCandidateCompatibility(
        'caller.py',
        positionalSite,
        candidate(11),
      ),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooFewSite, candidate(2)),
      pythonMissingReceiverSubtypeCandidateCompatibility('caller.py', tooManySite, candidate(2)),
    ]).toEqual(fresh);
  });
});
