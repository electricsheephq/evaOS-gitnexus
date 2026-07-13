import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(fixtureDir, '../..');
const runAnalyzeUrl = pathToFileURL(path.join(packageRoot, 'dist/core/run-analyze.js')).href;
const repoManagerUrl = pathToFileURL(path.join(packageRoot, 'dist/storage/repo-manager.js')).href;
const lbugAdapterUrl = pathToFileURL(path.join(packageRoot, 'dist/core/lbug/lbug-adapter.js')).href;
const bm25IndexUrl = pathToFileURL(path.join(packageRoot, 'dist/core/search/bm25-index.js')).href;

const [repoPath, ...args] = process.argv.slice(2);
if (!repoPath) {
  throw new Error(
    'usage: large-incremental-child.mjs <repo> [--force] [--pause-on-escalation <file>] [--fts-query <text>]',
  );
}

const force = args.includes('--force');
const pauseIndex = args.indexOf('--pause-on-escalation');
const pauseReadyFile = pauseIndex >= 0 ? args[pauseIndex + 1] : undefined;
if (pauseIndex >= 0 && !pauseReadyFile) {
  throw new Error('--pause-on-escalation requires a ready-file path');
}
const ftsQueryIndex = args.indexOf('--fts-query');
const ftsQuery = ftsQueryIndex >= 0 ? args[ftsQueryIndex + 1] : undefined;
if (ftsQueryIndex >= 0 && !ftsQuery) {
  throw new Error('--fts-query requires query text');
}

const { runFullAnalysis } = await import(runAnalyzeUrl);
const { getStoragePaths, loadMeta } = await import(repoManagerUrl);
const { storagePath, lbugPath } = getStoragePaths(repoPath);
const logs = [];
let paused = false;

const onLog = (message) => {
  logs.push(message);
  if (!paused && pauseReadyFile && message.includes('switching to a full DB write')) {
    paused = true;
    const metadataPath = path.join(storagePath, 'gitnexus.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    fs.writeFileSync(
      pauseReadyFile,
      JSON.stringify({ message, dirty: metadata.incrementalInProgress }),
      'utf8',
    );

    const latch = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(latch, 0, 0, 120_000);
    throw new Error('pause-on-escalation timed out before the parent terminated this process');
  }
};

try {
  await runFullAnalysis(repoPath, { skipAgentsMd: true, force }, { onProgress: () => {}, onLog });

  const meta = await loadMeta(storagePath);
  const lbugStat = fs.statSync(lbugPath);
  if (!meta) throw new Error('analysis returned without metadata');
  if (meta.incrementalInProgress) {
    throw new Error(
      `analysis returned with dirty marker phase ${meta.incrementalInProgress.phase}`,
    );
  }
  if (!meta.stats || Number(meta.stats.files ?? 0) <= 0 || Number(meta.stats.nodes ?? 0) <= 0) {
    throw new Error('analysis returned without a valid nonempty graph');
  }
  if (!lbugStat.isFile() || lbugStat.size <= 0) {
    throw new Error('analysis returned without a valid LadybugDB file');
  }

  let ftsSearch;
  if (ftsQuery) {
    const adapter = await import(lbugAdapterUrl);
    const { searchFTSFromLbug } = await import(bm25IndexUrl);
    await adapter.initLbug(lbugPath);
    try {
      const response = await searchFTSFromLbug(ftsQuery, 20);
      ftsSearch = { query: ftsQuery, ...response };
      if (!response.ftsAvailable) {
        throw new Error(`FTS indexes are unavailable after analysis for query ${ftsQuery}`);
      }
      if (response.results.length === 0) {
        throw new Error(`FTS query returned no results after analysis for ${ftsQuery}`);
      }
    } finally {
      await adapter.closeLbug();
    }
  }

  const lbugName = path.basename(lbugPath);
  const sidecars = fs
    .readdirSync(storagePath)
    .filter((name) => name.startsWith(`${lbugName}.`))
    .sort();
  process.stdout.write(
    `HARNESS_RESULT=${JSON.stringify({
      stats: meta.stats,
      capabilities: meta.capabilities ?? {},
      logs,
      sidecars,
      lastCommit: meta.lastCommit,
      ftsSearch,
    })}\n`,
  );
} catch (error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
