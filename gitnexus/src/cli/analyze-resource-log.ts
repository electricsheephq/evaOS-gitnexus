import path from 'path';
import fs from 'fs/promises';
import os from 'os';

const RESOURCE_LOG_SCHEMA = 'gitnexus.analyze-resource/v1';
const BYTES_PER_MIB = 1024 * 1024;
const MAX_PHASE_LENGTH = 64;
const PHASE_PATTERN = /^[a-z0-9._-]+$/u;

export type AnalyzeResourceEvent = 'start' | 'progress' | 'signal' | 'complete' | 'error';

export interface AnalyzeResourceLogger {
  emit(event: AnalyzeResourceEvent, phase?: string, percent?: number): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

const sanitizePhase = (phase: string | undefined): string | undefined => {
  if (!phase) return undefined;
  const normalized = phase.trim().toLowerCase();
  if (!PHASE_PATTERN.test(normalized) || normalized.length > MAX_PHASE_LENGTH) return undefined;
  return normalized;
};

const normalizePercent = (percent: number | undefined): number | undefined => {
  if (percent === undefined || !Number.isFinite(percent)) return undefined;
  return Math.max(0, Math.min(100, Math.round(percent)));
};

const mib = (bytes: number): number => Math.round((bytes / BYTES_PER_MIB) * 10) / 10;

/**
 * Create an append-only resource-event sink for analyze.
 *
 * The schema deliberately accepts only an enum event, a restricted phase token,
 * numeric progress, and process/system counters. Free-form messages, repository
 * paths, endpoint URLs, source text, environment values, and errors can never
 * enter the JSONL payload.
 */
export const createAnalyzeResourceLogger = async (
  filePath = process.env.GITNEXUS_ANALYZE_RESOURCE_LOG,
): Promise<AnalyzeResourceLogger | undefined> => {
  if (!filePath?.trim()) return undefined;

  const resolvedPath = path.resolve(filePath.trim());
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  const handle = await fs.open(resolvedPath, 'a', 0o600);
  let pending = Promise.resolve();
  let closed = false;
  let closing = false;

  const emit = async (
    event: AnalyzeResourceEvent,
    phase?: string,
    percent?: number,
  ): Promise<void> => {
    if (closing || closed) return;
    const memory = process.memoryUsage();
    const record = {
      schema: RESOURCE_LOG_SCHEMA,
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      phase: sanitizePhase(phase),
      percent: normalizePercent(percent),
      rssMiB: mib(memory.rss),
      heapUsedMiB: mib(memory.heapUsed),
      heapTotalMiB: mib(memory.heapTotal),
      externalMiB: mib(memory.external),
      arrayBuffersMiB: mib(memory.arrayBuffers),
      systemFreeMiB: mib(os.freemem()),
      systemTotalMiB: mib(os.totalmem()),
    };
    pending = pending.then(async () => {
      await handle.appendFile(`${JSON.stringify(record)}\n`, 'utf8');
    });
    await pending;
  };

  const flush = async (): Promise<void> => {
    await pending;
    if (closed) return;
    await handle.sync();
  };

  const close = async (): Promise<void> => {
    if (closed || closing) return;
    closing = true;
    try {
      await pending;
      await handle.sync();
    } finally {
      closed = true;
      await handle.close();
    }
  };

  return { emit, flush, close };
};
