import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createAnalyzeResourceLogger } from '../../src/cli/analyze-resource-log.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('analyze resource JSONL', () => {
  it('emits only the fixed schema, restricted phase tokens, and numeric counters', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-resource-log-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'nested', 'resource.jsonl');
    const logger = await createAnalyzeResourceLogger(logPath);
    if (!logger) throw new Error('expected resource logger');

    await logger.emit('start', 'initializing', -10);
    await logger.emit('progress', '/private/repo?token=secret', 200);
    await logger.emit('complete', 'done', 100);
    await logger.close();

    const records = (await fs.readFile(logPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      schema: 'gitnexus.analyze-resource/v1',
      event: 'start',
      phase: 'initializing',
      percent: 0,
    });
    expect(records[1]).toMatchObject({ event: 'progress', percent: 100 });
    expect(records[1]).not.toHaveProperty('phase');
    expect(records[2]).toMatchObject({ event: 'complete', phase: 'done', percent: 100 });
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(
        expect.arrayContaining([
          'arrayBuffersMiB',
          'at',
          'event',
          'externalMiB',
          'heapTotalMiB',
          'heapUsedMiB',
          'pid',
          'rssMiB',
          'schema',
          'systemFreeMiB',
          'systemTotalMiB',
        ]),
      );
      expect(JSON.stringify(record)).not.toContain('secret');
      expect(JSON.stringify(record)).not.toContain('/private/repo');
    }
    expect((await fs.stat(logPath)).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent events and closes idempotently', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-resource-log-'));
    tempDirs.push(dir);
    const logPath = path.join(dir, 'resource.jsonl');
    const logger = await createAnalyzeResourceLogger(logPath);
    if (!logger) throw new Error('expected resource logger');

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => logger.emit('progress', 'parse', index)),
    );
    await logger.close();
    await logger.close();
    const lines = (await fs.readFile(logPath, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(20);
    expect(lines.map((line) => JSON.parse(line).percent)).toEqual(
      Array.from({ length: 20 }, (_, index) => index),
    );
  });
});
