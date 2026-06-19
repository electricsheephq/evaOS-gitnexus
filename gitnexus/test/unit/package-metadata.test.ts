import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

describe('package metadata', () => {
  it('keeps the local embedding runtime optional so basic installs do not fail on ONNX postinstall downloads', () => {
    const localEmbeddingRuntime = [
      '@huggingface/transformers',
      'onnxruntime-common',
      'onnxruntime-node',
    ];

    for (const dep of localEmbeddingRuntime) {
      expect(
        pkg.dependencies ?? {},
        `${dep} must not be a hard runtime dependency`,
      ).not.toHaveProperty(dep);
      expect(
        pkg.optionalDependencies ?? {},
        `${dep} must stay optional because HTTP/Voyage embeddings do not need local ONNX`,
      ).toHaveProperty(dep);
    }
  });
});
