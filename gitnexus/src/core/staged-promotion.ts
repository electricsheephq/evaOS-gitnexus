import { randomBytes } from 'crypto';
import path from 'path';
import fs from 'fs/promises';
import { retryRename } from '../storage/fs-atomic.js';
import {
  isMissingFilesystemError,
  loadMeta,
  saveMeta,
  type RepoMeta,
} from '../storage/repo-manager.js';

const STAGE_MANIFEST_SCHEMA = 'gitnexus.staged-analyze/v1';
const PROMOTION_JOURNAL_SCHEMA = 'gitnexus.staged-promotion/v1';
const DB_SIDECARS = ['.wal', '.shadow', '.wal.checkpoint'] as const;

export type PromotionState =
  | 'prepared'
  | 'old-backed-up'
  | 'new-installed'
  | 'metadata/registry-committed';

export type PromotionBoundary = PromotionState;

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

interface MetaIdentity {
  lastCommit: string;
  indexedAt: string;
}

interface StageManifest {
  schema: typeof STAGE_MANIFEST_SCHEMA;
  generationId: string;
  createdAt: string;
  sourceMeta?: MetaIdentity;
  sourceDb?: FileIdentity;
}

interface PromotionJournal {
  schema: typeof PROMOTION_JOURNAL_SCHEMA;
  generationId: string;
  state: PromotionState;
  updatedAt: string;
  hadCanonical: boolean;
  stagedMeta: MetaIdentity;
  stagedDb: FileIdentity;
  oldDb?: FileIdentity;
  projectName?: string;
}

export interface StagedAnalyzePaths {
  canonicalLbugPath: string;
  canonicalMetaDir: string;
  stageRoot: string;
  stagedLbugPath: string;
  stagedMetaDir: string;
  stageManifestPath: string;
  backupLbugPath: string;
  journalPath: string;
}

export interface PromotionHooks {
  /** Test-only crash-injection seam after a durable state transition. */
  afterBoundary?: (boundary: PromotionBoundary) => void | Promise<void>;
}

export interface PromotionResult {
  projectName?: string;
  recovered: boolean;
}

interface StageLockRecord {
  schema: 'gitnexus.staged-analyze-lock/v1';
  pid: number;
  nonce: string;
  startedAt: string;
}

const metaIdentity = (meta: RepoMeta): MetaIdentity => ({
  lastCommit: meta.lastCommit,
  indexedAt: meta.indexedAt,
});

const identitiesEqual = <T>(a?: T, b?: T): boolean =>
  a === undefined ? b === undefined : b !== undefined && JSON.stringify(a) === JSON.stringify(b);

const statRegularFile = async (filePath: string): Promise<FileIdentity | undefined> => {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile()) throw new Error(`Expected a regular file at ${filePath}`);
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (isMissingFilesystemError(error)) return undefined;
    throw error;
  }
};

const assertNoDbSidecars = async (lbugPath: string, label: string): Promise<void> => {
  const present: string[] = [];
  for (const suffix of DB_SIDECARS) {
    try {
      await fs.lstat(`${lbugPath}${suffix}`);
      present.push(`${lbugPath}${suffix}`);
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  }
  if (present.length > 0) {
    throw new Error(
      `${label} has unresolved LadybugDB sidecars (${present.join(', ')}); ` +
        'refusing staged copy or promotion until WAL/shadow state is resolved.',
    );
  }
};

const syncDirectory = async (dir: string): Promise<void> => {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR') throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
};

const writeDurableJson = async (target: string, value: unknown): Promise<void> => {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await retryRename(temp, target);
    await syncDirectory(path.dirname(target));
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

const readJson = async <T>(filePath: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch (error) {
    if (isMissingFilesystemError(error)) return undefined;
    throw new Error(`Cannot read staged-analyze state at ${filePath}`, { cause: error });
  }
};

const isPromotionState = (value: unknown): value is PromotionState =>
  value === 'prepared' ||
  value === 'old-backed-up' ||
  value === 'new-installed' ||
  value === 'metadata/registry-committed';

const readManifest = async (paths: StagedAnalyzePaths): Promise<StageManifest | undefined> => {
  const manifest = await readJson<StageManifest>(paths.stageManifestPath);
  if (!manifest) return undefined;
  if (
    manifest.schema !== STAGE_MANIFEST_SCHEMA ||
    typeof manifest.generationId !== 'string' ||
    manifest.generationId.length < 8
  ) {
    throw new Error('Staged-analyze manifest is corrupt or from an unsupported version');
  }
  return manifest;
};

const readJournal = async (paths: StagedAnalyzePaths): Promise<PromotionJournal | undefined> => {
  const journal = await readJson<PromotionJournal>(paths.journalPath);
  if (!journal) return undefined;
  if (
    journal.schema !== PROMOTION_JOURNAL_SCHEMA ||
    typeof journal.generationId !== 'string' ||
    !isPromotionState(journal.state) ||
    typeof journal.hadCanonical !== 'boolean' ||
    !journal.stagedMeta ||
    !journal.stagedDb ||
    typeof journal.stagedMeta.lastCommit !== 'string' ||
    typeof journal.stagedMeta.indexedAt !== 'string'
  ) {
    throw new Error('Staged-promotion journal is corrupt or from an unsupported version');
  }
  return journal;
};

const updateJournal = async (
  paths: StagedAnalyzePaths,
  journal: PromotionJournal,
  state: PromotionState,
  projectName?: string,
): Promise<PromotionJournal> => {
  const next: PromotionJournal = {
    ...journal,
    state,
    updatedAt: new Date().toISOString(),
    projectName: projectName ?? journal.projectName,
  };
  await writeDurableJson(paths.journalPath, next);
  return next;
};

const moveAndSync = async (source: string, target: string): Promise<void> => {
  await retryRename(source, target);
  await syncDirectory(path.dirname(target));
};

export const getStagedAnalyzePaths = (
  canonicalLbugPath: string,
  canonicalMetaDir: string,
): StagedAnalyzePaths => {
  const stageRoot = `${canonicalLbugPath}.staged-work`;
  return {
    canonicalLbugPath,
    canonicalMetaDir,
    stageRoot,
    stagedLbugPath: path.join(stageRoot, 'lbug'),
    stagedMetaDir: path.join(stageRoot, 'meta'),
    stageManifestPath: path.join(stageRoot, 'manifest.json'),
    backupLbugPath: `${canonicalLbugPath}.promotion-backup`,
    journalPath: path.join(canonicalMetaDir, 'analyze-promotion.json'),
  };
};

const processIsAlive = (pid: number): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** Serialize staged builders; a dead owner's lock is reclaimed on the next run. */
export const withStagedAnalyzeLock = async <T>(
  storagePath: string,
  operation: () => Promise<T>,
): Promise<T> => {
  await fs.mkdir(storagePath, { recursive: true });
  const lockPath = path.join(storagePath, 'analyze-staged.lock');
  const record: StageLockRecord = {
    schema: 'gitnexus.staged-analyze-lock/v1',
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
    startedAt: new Date().toISOString(),
  };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = await readJson<StageLockRecord>(lockPath);
      if (owner?.schema === record.schema && processIsAlive(owner.pid)) {
        throw new Error(
          `Another staged analyze is active (pid ${owner.pid}, started ${owner.startedAt}).`,
        );
      }
      if (attempt === 1) throw new Error('Could not reclaim the stale staged-analyze lock');
      await fs.rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error('Could not acquire the staged-analyze lock');
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    const current = await readJson<StageLockRecord>(lockPath).catch(() => undefined);
    if (current?.nonce === record.nonce) await fs.rm(lockPath, { force: true });
  }
};

/**
 * Create or resume the isolated build workspace. Only the stage tree may be
 * removed here, and only while a complete canonical generation is present.
 */
export const prepareStagedWorkspace = async (
  paths: StagedAnalyzePaths,
  canonicalMeta: RepoMeta | null,
): Promise<{ resumed: boolean; generationId: string }> => {
  if (await readJournal(paths)) {
    throw new Error('A staged-promotion journal must be recovered before preparing another build');
  }
  if (await statRegularFile(paths.backupLbugPath)) {
    throw new Error(
      `Unjournaled promotion backup exists at ${paths.backupLbugPath}; refusing to overwrite it.`,
    );
  }

  const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
  if ((canonicalMeta === null) !== (canonicalDb === undefined)) {
    throw new Error(
      'Canonical metadata/database presence disagrees; refusing staged analysis because the live generation cannot be proven complete.',
    );
  }
  if (canonicalDb) await assertNoDbSidecars(paths.canonicalLbugPath, 'Canonical index');

  const sourceMeta = canonicalMeta ? metaIdentity(canonicalMeta) : undefined;
  const manifest = await readManifest(paths);
  if (manifest) {
    const sameSource =
      identitiesEqual(manifest.sourceMeta, sourceMeta) &&
      identitiesEqual(manifest.sourceDb, canonicalDb);
    if (sameSource) {
      const stagedDb = await statRegularFile(paths.stagedLbugPath);
      const stagedMeta = await loadMeta(paths.stagedMetaDir);
      if (canonicalDb && (!stagedDb || !stagedMeta)) {
        throw new Error(
          'The staged workspace manifest matches the canonical generation, but its DB or metadata is missing.',
        );
      }
      return { resumed: true, generationId: manifest.generationId };
    }
    if (!canonicalDb || !canonicalMeta) {
      throw new Error(
        'A stale staged workspace exists but no complete canonical generation is available to replace it safely.',
      );
    }
    await fs.rm(paths.stageRoot, { recursive: true, force: true });
  } else {
    try {
      await fs.lstat(paths.stageRoot);
      if (!canonicalDb || !canonicalMeta) {
        throw new Error(
          'An incomplete staged workspace exists and no complete canonical generation is available for safe cleanup.',
        );
      }
      await fs.rm(paths.stageRoot, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingFilesystemError(error)) throw error;
    }
  }

  await fs.mkdir(paths.stagedMetaDir, { recursive: true });
  if (canonicalDb && canonicalMeta) {
    const tempDb = `${paths.stagedLbugPath}.copy-${randomBytes(8).toString('hex')}`;
    await fs.copyFile(paths.canonicalLbugPath, tempDb);
    const handle = await fs.open(tempDb, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await moveAndSync(tempDb, paths.stagedLbugPath);
    await saveMeta(paths.stagedMetaDir, canonicalMeta);
  }

  const next: StageManifest = {
    schema: STAGE_MANIFEST_SCHEMA,
    generationId: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    sourceMeta,
    sourceDb: canonicalDb,
  };
  await writeDurableJson(paths.stageManifestPath, next);
  return { resumed: false, generationId: next.generationId };
};

export const discardStagedWorkspace = async (paths: StagedAnalyzePaths): Promise<void> => {
  if (await readJournal(paths)) {
    throw new Error('Cannot discard a staged workspace while promotion recovery is pending');
  }
  await fs.rm(paths.stageRoot, { recursive: true, force: true });
};

/** Validate the staged DB/meta pair before the first canonical rename. */
export const validateStagedGeneration = async (paths: StagedAnalyzePaths): Promise<RepoMeta> => {
  const manifest = await readManifest(paths);
  if (!manifest) throw new Error('Staged generation has no durable manifest');
  const db = await statRegularFile(paths.stagedLbugPath);
  if (!db || db.size === 0) throw new Error('Staged generation has no non-empty LadybugDB file');
  await assertNoDbSidecars(paths.stagedLbugPath, 'Staged index');
  const meta = await loadMeta(paths.stagedMetaDir);
  if (!meta) throw new Error('Staged generation has no readable metadata');
  if (meta.incrementalInProgress || meta.embeddingCheckpoint) {
    throw new Error('Staged generation still carries an incomplete write/checkpoint marker');
  }
  return meta;
};

/**
 * Resume or execute the four-state promotion. Every destructive rename has a
 * complete generation on the other side, and the old DB is retained until
 * metadata plus registry commit succeeds.
 */
export const promoteStagedGeneration = async (
  paths: StagedAnalyzePaths,
  commitMetadataAndRegistry: (meta: RepoMeta) => Promise<string>,
  hooks: PromotionHooks = {},
): Promise<PromotionResult> => {
  let journal = await readJournal(paths);
  const recovered = journal !== undefined;
  if (!journal) {
    const meta = await validateStagedGeneration(paths);
    const manifest = await readManifest(paths);
    if (!manifest) throw new Error('Staged generation manifest disappeared during validation');
    const canonicalDb = await statRegularFile(paths.canonicalLbugPath);
    if (await statRegularFile(paths.backupLbugPath)) {
      throw new Error('Cannot begin promotion while an unjournaled backup generation exists');
    }
    if (canonicalDb) await assertNoDbSidecars(paths.canonicalLbugPath, 'Canonical index');
    journal = {
      schema: PROMOTION_JOURNAL_SCHEMA,
      generationId: manifest.generationId,
      state: 'prepared',
      updatedAt: new Date().toISOString(),
      hadCanonical: canonicalDb !== undefined,
      stagedMeta: metaIdentity(meta),
      stagedDb: (await statRegularFile(paths.stagedLbugPath))!,
      oldDb: canonicalDb,
    };
    await writeDurableJson(paths.journalPath, journal);
    await hooks.afterBoundary?.('prepared');
  }

  if (journal.state === 'prepared') {
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    const backup = await statRegularFile(paths.backupLbugPath);
    if (journal.hadCanonical) {
      if (
        canonical &&
        staged &&
        !backup &&
        identitiesEqual(canonical, journal.oldDb) &&
        identitiesEqual(staged, journal.stagedDb)
      ) {
        await moveAndSync(paths.canonicalLbugPath, paths.backupLbugPath);
      } else if (
        !canonical &&
        staged &&
        backup &&
        identitiesEqual(staged, journal.stagedDb) &&
        identitiesEqual(backup, journal.oldDb)
      ) {
        // Crash after the rename but before the journal transition.
      } else if (
        canonical &&
        !staged &&
        backup &&
        identitiesEqual(canonical, journal.stagedDb) &&
        identitiesEqual(backup, journal.oldDb)
      ) {
        journal = await updateJournal(paths, journal, 'new-installed');
      } else {
        throw new Error('Ambiguous prepared promotion artifacts; refusing to choose a generation');
      }
    } else if (!canonical && staged && !backup && identitiesEqual(staged, journal.stagedDb)) {
      // First index: there is no old generation to back up.
    } else if (canonical && !staged && !backup && identitiesEqual(canonical, journal.stagedDb)) {
      journal = await updateJournal(paths, journal, 'new-installed');
    } else {
      throw new Error('Ambiguous first-generation promotion artifacts');
    }
    if (journal.state === 'prepared') {
      journal = await updateJournal(paths, journal, 'old-backed-up');
      await hooks.afterBoundary?.('old-backed-up');
    }
  }

  if (journal.state === 'old-backed-up') {
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    const backup = await statRegularFile(paths.backupLbugPath);
    if (
      !canonical &&
      staged &&
      identitiesEqual(staged, journal.stagedDb) &&
      (!journal.hadCanonical || identitiesEqual(backup, journal.oldDb))
    ) {
      await moveAndSync(paths.stagedLbugPath, paths.canonicalLbugPath);
    } else if (canonical && !staged && identitiesEqual(canonical, journal.stagedDb)) {
      // Crash after install but before the journal transition.
    } else if (
      !canonical &&
      !staged &&
      backup &&
      journal.hadCanonical &&
      identitiesEqual(backup, journal.oldDb)
    ) {
      await moveAndSync(paths.backupLbugPath, paths.canonicalLbugPath);
      throw new Error('Staged generation is missing; restored the canonical backup instead');
    } else {
      throw new Error(
        'Ambiguous old-backed-up promotion artifacts; refusing to delete or overwrite',
      );
    }
    journal = await updateJournal(paths, journal, 'new-installed');
    await hooks.afterBoundary?.('new-installed');
  }

  if (journal.state === 'new-installed') {
    const canonical = await statRegularFile(paths.canonicalLbugPath);
    const staged = await statRegularFile(paths.stagedLbugPath);
    if (!canonical || !identitiesEqual(canonical, journal.stagedDb)) {
      const backup = await statRegularFile(paths.backupLbugPath);
      if (backup && journal.hadCanonical && identitiesEqual(backup, journal.oldDb)) {
        await moveAndSync(paths.backupLbugPath, paths.canonicalLbugPath);
      }
      throw new Error(
        'Installed generation is missing or has the wrong identity; restored the backup when available',
      );
    }
    if (staged) throw new Error('Both staged and installed DB files exist after promotion');
    const stagedMeta = await loadMeta(paths.stagedMetaDir);
    if (!stagedMeta || !identitiesEqual(metaIdentity(stagedMeta), journal.stagedMeta)) {
      throw new Error('Staged metadata identity changed after promotion was prepared');
    }
    const projectName = await commitMetadataAndRegistry(stagedMeta);
    journal = await updateJournal(paths, journal, 'metadata/registry-committed', projectName);
    await hooks.afterBoundary?.('metadata/registry-committed');
  }

  if (journal.state !== 'metadata/registry-committed') {
    throw new Error(`Unsupported promotion state: ${journal.state}`);
  }
  const committedCanonical = await statRegularFile(paths.canonicalLbugPath);
  if (!committedCanonical || !identitiesEqual(committedCanonical, journal.stagedDb)) {
    throw new Error(
      'Cannot clean promotion artifacts because the canonical DB is missing or has the wrong identity',
    );
  }
  await fs.rm(paths.backupLbugPath, { force: true });
  await fs.rm(paths.stageRoot, { recursive: true, force: true });
  await fs.rm(paths.journalPath, { force: true });
  await syncDirectory(paths.canonicalMetaDir);
  return { projectName: journal.projectName, recovered };
};

export const hasPendingPromotion = async (paths: StagedAnalyzePaths): Promise<boolean> =>
  (await readJournal(paths)) !== undefined;
