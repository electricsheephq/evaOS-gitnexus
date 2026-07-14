#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSanitizedEnvironment } from './canary-environment.mjs';
import {
  ChildSupervisor,
  createSafeContainedDirectory,
  openArtifactLogs,
  prepareEvidenceLayout,
  selectSafeTrackedFiles,
  writeJsonArtifact,
  writeJsonAtomic,
} from './canary-safety.mjs';

const REQUIRED_ARGS = [
  'source',
  'source-sha',
  'public-origin',
  'worktree',
  'evidence',
  'gitnexus-cli',
  'incremental-child',
  'extension-source',
  'run-id',
];

const parseArgs = (argv) => {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!key || !value || !argv[index].startsWith('--')) {
      throw new Error(`invalid argument sequence near ${argv[index] ?? '<end>'}`);
    }
    result[key] = value;
  }
  for (const key of REQUIRED_ARGS) {
    if (!result[key]) throw new Error(`missing required --${key}`);
  }
  return result;
};

const args = parseArgs(process.argv.slice(2));
const source = path.resolve(args.source);
const sourceSha = args['source-sha'];
const publicOrigin = args['public-origin'];
const worktree = path.resolve(args.worktree);
const evidence = path.resolve(args.evidence);
const cli = path.resolve(args['gitnexus-cli']);
const incrementalChild = path.resolve(args['incremental-child']);
const extensionSource = path.resolve(args['extension-source']);
const runId = args['run-id'];
const dimensions = Number(args['embedding-dims'] ?? '8');
const model = args['embedding-model'] ?? 'gitnexus-canary-deterministic-v1';
const resumeFrom = args['resume-from'];
const escalationTimeoutMs = Number(args['escalation-timeout-ms'] ?? '21600000');
const packageRoot = path.resolve(path.dirname(cli), '../..');
const home = path.join(evidence, 'home');
const commandDir = path.join(evidence, 'commands');
const snapshotDir = path.join(evidence, 'snapshots');
const failurePath = path.join(evidence, 'failure.json');
const baseEnv = createSanitizedEnvironment(process.env, { home });

if (!Number.isInteger(dimensions) || dimensions <= 0) {
  throw new Error('--embedding-dims must be a positive integer');
}
if (resumeFrom && !['wide', 'forced'].includes(resumeFrom)) {
  throw new Error('--resume-from currently supports only "wide" or "forced"');
}
if (!Number.isInteger(escalationTimeoutMs) || escalationTimeoutMs <= 0) {
  throw new Error('--escalation-timeout-ms must be a positive integer');
}
if (!resumeFrom && fs.existsSync(worktree)) {
  throw new Error(`refusing existing canary worktree: ${worktree}`);
}
if (resumeFrom && !fs.existsSync(worktree)) {
  throw new Error(`cannot resume missing canary worktree: ${worktree}`);
}
for (const requiredPath of [source, cli, incrementalChild, extensionSource]) {
  if (!fs.existsSync(requiredPath))
    throw new Error(`required path does not exist: ${requiredPath}`);
}
prepareEvidenceLayout({ evidence, commandDir, snapshotDir, home });
if (resumeFrom && fs.existsSync(failurePath)) {
  let archiveIndex = 1;
  let archivedFailurePath;
  do {
    archivedFailurePath = path.join(evidence, `failure-before-resume-${archiveIndex}.json`);
    archiveIndex += 1;
  } while (fs.existsSync(archivedFailurePath));
  if (!archivedFailurePath) {
    throw new Error('failed to allocate archived failure path');
  }
  fs.renameSync(failurePath, archivedFailurePath);
}
fs.cpSync(extensionSource, path.join(home, '.lbdb', 'extension'), { recursive: true });

const writeJson = writeJsonAtomic;

const extensionFiles = [];
const collectExtensionFiles = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) collectExtensionFiles(fullPath);
    if (entry.isFile()) {
      const contents = fs.readFileSync(fullPath);
      extensionFiles.push({
        path: path.relative(extensionSource, fullPath),
        bytes: contents.byteLength,
        sha256: crypto.createHash('sha256').update(contents).digest('hex'),
      });
    }
  }
};
collectExtensionFiles(extensionSource);
writeJson(path.join(evidence, 'extension-manifest.json'), extensionFiles);

const commandLedgerPath = path.join(evidence, 'command-ledger.json');
const commandLedger =
  resumeFrom && fs.existsSync(commandLedgerPath)
    ? JSON.parse(fs.readFileSync(commandLedgerPath, 'utf8'))
    : [];
const embeddingStats = { requests: 0, items: 0 };
const childSupervisor = new ChildSupervisor({ terminationEnv: baseEnv });

const run = async (name, command, commandArgs, options = {}) => {
  const { stdoutPath, stderrPath, stdout, stderr } = openArtifactLogs(commandDir, name);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stdout.write(`[${runId}] ${name}\n`);
  const child = childSupervisor.spawn(command, commandArgs, {
    cwd: options.cwd ?? worktree,
    env: options.env ?? baseEnv,
    stdio: ['ignore', stdout, stderr],
  });
  let childError;
  let result = { code: null, signal: null };
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } catch (error) {
    childError = error;
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  const entry = {
    name,
    command,
    args: commandArgs,
    cwd: options.cwd ?? worktree,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    code: result.code,
    signal: result.signal,
    error: childError instanceof Error ? childError.message : undefined,
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
  };
  commandLedger.push(entry);
  writeJson(path.join(evidence, 'command-ledger.json'), commandLedger);
  if (childError) throw childError;
  if (!options.allowFailure && (result.code !== 0 || result.signal !== null)) {
    throw new Error(`${name} failed with code=${result.code} signal=${result.signal}`);
  }
  return entry;
};

const runText = async (name, command, commandArgs, options = {}) => {
  const chunks = [];
  const child = childSupervisor.spawn(command, commandArgs, {
    cwd: options.cwd ?? worktree,
    env: options.env ?? baseEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk));
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(`${name} failed: ${Buffer.concat(errors).toString('utf8').trim()}`);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
};

const deterministicVector = (text) => {
  const digest = crypto.createHash('sha256').update(text).digest();
  const vector = Array.from({ length: dimensions }, (_, index) => digest[index] / 127.5 - 1);
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / magnitude);
};

const embeddingServer = http.createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/embeddings') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      if (!inputs.every((input) => typeof input === 'string')) {
        throw new Error('input must be a string or string array');
      }
      embeddingStats.requests += 1;
      embeddingStats.items += inputs.length;
      const payload = {
        object: 'list',
        model,
        data: inputs.map((input, index) => ({
          object: 'embedding',
          index,
          embedding: deterministicVector(input),
        })),
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
});

await new Promise((resolve, reject) => {
  embeddingServer.once('error', reject);
  embeddingServer.listen(0, '127.0.0.1', resolve);
});
const address = embeddingServer.address();
if (!address || typeof address === 'string') throw new Error('embedding server has no TCP address');
childSupervisor.installSignalHandlers(process, () => embeddingServer.close());

const canaryEnv = {
  ...baseEnv,
  GITNEXUS_HOME: path.join(home, '.gitnexus'),
  CI: '1',
  NODE_OPTIONS: '--max-old-space-size=6144',
  GITNEXUS_WORKER_POOL_SIZE: '2',
  GITNEXUS_PARSE_CHUNK_CONCURRENCY: '1',
  GITNEXUS_LBUG_EXTENSION_INSTALL: 'load-only',
  GITNEXUS_EMBEDDING_URL: `http://127.0.0.1:${address.port}/v1`,
  GITNEXUS_EMBEDDING_MODEL: model,
  GITNEXUS_EMBEDDING_DIMS: String(dimensions),
  GITNEXUS_EMBEDDING_BATCH_SIZE: '256',
  GITNEXUS_EMBEDDING_SUB_BATCH_SIZE: '256',
  GITNEXUS_EMBEDDING_MAX_ATTEMPTS: '3',
  GITNEXUS_EMBEDDING_RETRY_CAP_MS: '1000',
  GITNEXUS_EMBEDDING_MIN_INTERVAL_MS: '0',
};

const commitAll = async (message) => {
  await run(`git-add-${commandLedger.length}`, 'git', ['add', '-A']);
  await run(`git-commit-${commandLedger.length}`, 'git', [
    '-c',
    'user.name=GitNexus Canary',
    '-c',
    'user.email=canary@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-q',
    '-m',
    message,
  ]);
};

const snapshot = async (name, { fingerprint = false } = {}) => {
  const repoManager = await import(
    pathToFileURL(path.join(packageRoot, 'dist/storage/repo-manager.js')).href
  );
  const adapter = await import(
    pathToFileURL(path.join(packageRoot, 'dist/core/lbug/lbug-adapter.js')).href
  );
  const schema = await import(
    pathToFileURL(path.join(packageRoot, 'dist/core/lbug/schema.js')).href
  );
  const { storagePath, lbugPath } = repoManager.getStoragePaths(worktree);
  const meta = await repoManager.loadMeta(storagePath);
  const status = await runText(`status-${name}`, 'git', ['status', '--porcelain=v1']);
  const head = await runText(`head-${name}`, 'git', ['rev-parse', 'HEAD']);
  const disk = await runText(`disk-${name}`, 'df', ['-k', path.dirname(worktree)]);
  const indexKb = Number(
    await runText(`du-${name}`, 'du', ['-sk', storagePath]).then((text) => text.split(/\s+/)[0]),
  );
  const files = fs.existsSync(storagePath)
    ? fs
        .readdirSync(storagePath)
        .sort()
        .map((file) => {
          const stat = fs.statSync(path.join(storagePath, file));
          return { file, bytes: stat.size, directory: stat.isDirectory() };
        })
    : [];
  let database = null;
  if (fs.existsSync(lbugPath)) {
    await adapter.initLbug(lbugPath);
    try {
      const nodes = await adapter.executeQuery('MATCH (n) RETURN count(n) AS count');
      const edges = await adapter.executeQuery('MATCH ()-[r]->() RETURN count(r) AS count');
      const embeddings = await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN count(e) AS count',
      );
      const embeddingDimensions = await adapter.executeQuery(
        'MATCH (e:CodeEmbedding) RETURN DISTINCT size(e.embedding) AS dimensions ORDER BY dimensions',
      );
      let graphFingerprint = null;
      if (fingerprint) {
        const nodeTables = {};
        for (const table of schema.NODE_TABLES) {
          const countRows = await adapter.executeQuery(
            `MATCH (n:\`${table}\`) RETURN count(n) AS count`,
          );
          const digest = crypto.createHash('sha256');
          const streamed = await adapter.streamQuery(
            `MATCH (n:\`${table}\`) RETURN n.id AS id ORDER BY id`,
            (row) => digest.update(`${JSON.stringify(String(row.id ?? ''))}\n`),
          );
          const count = Number(countRows[0]?.count ?? 0);
          if (streamed !== count) {
            throw new Error(
              `${name}: ${table} fingerprint streamed ${streamed} rows, expected ${count}`,
            );
          }
          nodeTables[table] = { count, idSha256: digest.digest('hex') };
        }
        const relationshipTypes = await adapter.executeQuery(
          `MATCH ()-[r:${schema.REL_TABLE_NAME}]->() ` +
            'RETURN r.type AS type, count(r) AS count ORDER BY type',
        );
        const relationshipPairs = await adapter.executeQuery(
          `MATCH (source)-[r:${schema.REL_TABLE_NAME}]->(target) ` +
            'RETURN labels(source) AS sourceLabel, r.type AS type, ' +
            'labels(target) AS targetLabel, count(r) AS count ' +
            'ORDER BY type, sourceLabel, targetLabel',
        );
        const relationshipIdentityDigests = new Map();
        const relationshipIdentityCounts = new Map();
        await adapter.streamQuery(
          `MATCH (source)-[r:${schema.REL_TABLE_NAME}]->(target) ` +
            'RETURN labels(source) AS sourceLabel, source.id AS sourceId, ' +
            'r.type AS type, labels(target) AS targetLabel, target.id AS targetId, ' +
            'r.confidence AS confidence, r.reason AS reason, r.step AS step ' +
            'ORDER BY type, sourceLabel, sourceId, targetLabel, targetId, ' +
            'confidence, reason, step',
          (row) => {
            const type = String(row.type);
            let digest = relationshipIdentityDigests.get(type);
            if (!digest) {
              digest = crypto.createHash('sha256');
              relationshipIdentityDigests.set(type, digest);
            }
            digest.update(
              `${JSON.stringify([
                String(row.sourceLabel),
                String(row.sourceId),
                String(row.targetLabel),
                String(row.targetId),
                Number(row.confidence),
                String(row.reason ?? ''),
                Number(row.step),
              ])}\n`,
            );
            relationshipIdentityCounts.set(type, (relationshipIdentityCounts.get(type) ?? 0) + 1);
          },
        );
        const relationshipIdentities = Array.from(relationshipIdentityDigests.entries())
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([type, digest]) => ({
            type,
            count: relationshipIdentityCounts.get(type) ?? 0,
            sha256: digest.digest('hex'),
          }));
        graphFingerprint = {
          nodeTables,
          relationshipTypes: relationshipTypes.map((row) => ({
            type: String(row.type),
            count: Number(row.count),
          })),
          relationshipPairs: relationshipPairs.map((row) => ({
            sourceLabel: String(row.sourceLabel),
            type: String(row.type),
            targetLabel: String(row.targetLabel),
            count: Number(row.count),
          })),
          relationshipIdentities,
        };
      }
      database = {
        nodes: Number(nodes[0]?.count ?? 0),
        edges: Number(edges[0]?.count ?? 0),
        embeddings: Number(embeddings[0]?.count ?? 0),
        embeddingDimensions: embeddingDimensions.map((row) => Number(row.dimensions)),
        graphFingerprint,
      };
    } finally {
      await adapter.closeLbug();
    }
  }
  const result = {
    name,
    at: new Date().toISOString(),
    runId,
    sourceSha,
    head,
    gitStatus: {
      clean: status.length === 0,
      entryCount: status.length === 0 ? 0 : status.split(/\r?\n/).length,
    },
    embedding: { model, dimensions, server: { ...embeddingStats } },
    metadata: meta ?? null,
    database,
    index: { path: storagePath, sizeKb: indexKb, files },
    disk: disk.split(/\r?\n/).slice(-1)[0],
  };
  const snapshotPath = writeJsonArtifact(snapshotDir, name, result);
  result.artifact = path.basename(snapshotPath);
  return result;
};

const waitForPauseAndTerminate = async (child, readyFile, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  let childError;
  child.once('error', (error) => {
    childError = error;
  });
  while (Date.now() < deadline) {
    if (childError) throw childError;
    if (fs.existsSync(readyFile)) {
      const dirty = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
      childSupervisor.terminate(child, 'SIGTERM');
      const result = await new Promise((resolve) => {
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      return { dirty, ...result };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('incremental child exited before the escalation pause point');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  childSupervisor.terminate(child, 'SIGKILL');
  await new Promise((resolve) => child.once('close', resolve));
  throw new Error('timed out waiting for the escalation pause point');
};

const interruptAtRecoveryBoundary = async (boundary) => {
  const name = `wide-interrupted-${boundary}`;
  const readyFile = path.join(evidence, `pause-ready-${boundary}.json`);
  if (fs.existsSync(readyFile)) {
    throw new Error(`refusing stale escalation ready file: ${readyFile}`);
  }
  const { stdoutPath, stderrPath, stdout, stderr } = openArtifactLogs(commandDir, name);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  process.stdout.write(`[${runId}] ${name}\n`);
  const childArgs = [
    incrementalChild,
    worktree,
    '--embeddings',
    '--pause-at',
    boundary,
    '--pause-ready',
    readyFile,
  ];
  const child = childSupervisor.spawn(process.execPath, childArgs, {
    cwd: packageRoot,
    env: canaryEnv,
    stdio: ['ignore', stdout, stderr],
  });
  let result;
  try {
    result = await waitForPauseAndTerminate(child, readyFile, escalationTimeoutMs);
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  const entry = {
    name,
    command: process.execPath,
    args: childArgs,
    cwd: packageRoot,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    timeoutMs: escalationTimeoutMs,
    code: result.code,
    signal: result.signal,
    dirty: result.dirty,
    stdout: path.basename(stdoutPath),
    stderr: path.basename(stderrPath),
  };
  commandLedger.push(entry);
  writeJson(path.join(evidence, 'command-ledger.json'), commandLedger);
  if (result.code === 0 || result.signal !== 'SIGTERM') {
    throw new Error(
      `child interrupted at ${boundary} did not fail by SIGTERM: ${JSON.stringify(result)}`,
    );
  }
  return entry;
};

const assertSnapshot = (value, expectedHead) => {
  if (value.head !== expectedHead) throw new Error(`${value.name}: metadata head mismatch`);
  if (value.metadata?.lastCommit !== expectedHead) {
    throw new Error(`${value.name}: persisted commit does not match repository head`);
  }
  if (!value.gitStatus.clean) throw new Error(`${value.name}: repository worktree is not clean`);
  if (value.metadata?.incrementalInProgress) {
    throw new Error(`${value.name}: dirty marker remained after successful analysis`);
  }
  if (!value.database || value.database.nodes <= 0 || value.database.edges <= 0) {
    throw new Error(`${value.name}: graph is empty`);
  }
  if (value.database.embeddings <= 0) throw new Error(`${value.name}: embeddings are empty`);
  if (JSON.stringify(value.database.embeddingDimensions) !== JSON.stringify([dimensions])) {
    throw new Error(`${value.name}: unexpected embedding dimensions`);
  }
  if (Number(value.metadata?.stats?.embeddings ?? -1) !== value.database.embeddings) {
    throw new Error(`${value.name}: metadata/database embedding counts differ`);
  }
  if (value.metadata?.capabilities?.fts?.status !== 'available') {
    throw new Error(`${value.name}: FTS capability is not available`);
  }
  if (value.metadata?.capabilities?.vectorSearch?.status !== 'vector-index') {
    throw new Error(`${value.name}: VECTOR capability is not vector-index`);
  }
};

const compareSnapshots = (left, right) => {
  const metadata = {};
  for (const key of ['files', 'nodes', 'edges', 'communities', 'processes', 'embeddings']) {
    const leftValue = Number(left.metadata?.stats?.[key] ?? -1);
    const rightValue = Number(right.metadata?.stats?.[key] ?? -1);
    if (leftValue !== rightValue) metadata[key] = { left: leftValue, right: rightValue };
  }
  const leftFingerprint = left.database?.graphFingerprint;
  const rightFingerprint = right.database?.graphFingerprint;
  if (!leftFingerprint || !rightFingerprint) {
    return { equal: false, metadata, fingerprint: { missing: true } };
  }
  const nodeTables = {};
  for (const table of Object.keys(leftFingerprint.nodeTables)) {
    const leftTable = leftFingerprint.nodeTables[table];
    const rightTable = rightFingerprint.nodeTables[table];
    if (leftTable?.count !== rightTable?.count || leftTable?.idSha256 !== rightTable?.idSha256) {
      nodeTables[table] = { left: leftTable ?? null, right: rightTable ?? null };
    }
  }
  const relationshipTypesEqual =
    JSON.stringify(leftFingerprint.relationshipTypes) ===
    JSON.stringify(rightFingerprint.relationshipTypes);
  const relationshipPairsEqual =
    JSON.stringify(leftFingerprint.relationshipPairs) ===
    JSON.stringify(rightFingerprint.relationshipPairs);
  const relationshipIdentitiesEqual =
    JSON.stringify(leftFingerprint.relationshipIdentities) ===
    JSON.stringify(rightFingerprint.relationshipIdentities);
  return {
    equal:
      Object.keys(metadata).length === 0 &&
      Object.keys(nodeTables).length === 0 &&
      relationshipTypesEqual &&
      relationshipPairsEqual &&
      relationshipIdentitiesEqual,
    metadata,
    fingerprint: {
      nodeTables,
      relationshipTypes: relationshipTypesEqual
        ? null
        : {
            left: leftFingerprint.relationshipTypes,
            right: rightFingerprint.relationshipTypes,
          },
      relationshipPairs: relationshipPairsEqual
        ? null
        : {
            left: leftFingerprint.relationshipPairs,
            right: rightFingerprint.relationshipPairs,
          },
      relationshipIdentities: relationshipIdentitiesEqual
        ? null
        : {
            left: leftFingerprint.relationshipIdentities,
            right: rightFingerprint.relationshipIdentities,
          },
    },
  };
};

try {
  if (resumeFrom === 'forced') {
    const forcedPath = path.join(snapshotDir, 'forced.json');
    if (!fs.existsSync(forcedPath)) {
      throw new Error('forced resume requires the original forced snapshot');
    }
    const originalForced = JSON.parse(fs.readFileSync(forcedPath, 'utf8'));
    if (originalForced.runId !== runId || originalForced.sourceSha !== sourceSha) {
      throw new Error('forced resume snapshot does not match this run or source SHA');
    }
    const wideHead = await runText('forced-repeat-head', 'git', ['rev-parse', 'HEAD']);
    const preflight = await snapshot('forced-repeat-preflight', { fingerprint: true });
    assertSnapshot(preflight, wideHead);
    if (preflight.metadata?.lastCommit !== originalForced.metadata?.lastCommit) {
      throw new Error('forced repeat preflight does not match the original forced commit');
    }
    await run(
      'forced-repeat-rebuild',
      process.execPath,
      [incrementalChild, worktree, '--force', '--embeddings', '--fts-query', 'r19CanaryNeedleV2'],
      { cwd: packageRoot, env: canaryEnv },
    );
    const repeated = await snapshot('forced-repeat', { fingerprint: true });
    assertSnapshot(repeated, wideHead);
    const comparison = compareSnapshots(preflight, repeated);
    writeJsonArtifact(evidence, 'forced-repeat-comparison', comparison);
    if (!comparison.equal) {
      throw new Error('consecutive forced rebuilds produced different graph fingerprints');
    }
    writeJsonArtifact(evidence, 'forced-repeat-summary', {
      runId,
      result: 'passed',
      sourceSha,
      finalHead: wideHead,
      preflight: preflight.metadata.stats,
      repeated: repeated.metadata.stats,
      comparison,
    });
    process.stdout.write(`[${runId}] forced repeat passed\n`);
  } else {
    let initial;
    let controlled;
    let wideHead;
    if (resumeFrom === 'wide') {
      const initialPath = path.join(snapshotDir, 'initial.json');
      const controlledPath = path.join(snapshotDir, 'controlled-change.json');
      if (!fs.existsSync(initialPath) || !fs.existsSync(controlledPath)) {
        throw new Error('wide resume requires initial and controlled-change snapshots');
      }
      initial = JSON.parse(fs.readFileSync(initialPath, 'utf8'));
      controlled = JSON.parse(fs.readFileSync(controlledPath, 'utf8'));
      if (initial.runId !== runId || controlled.runId !== runId) {
        throw new Error('wide resume snapshots do not belong to this run');
      }
      if (initial.sourceSha !== sourceSha || controlled.sourceSha !== sourceSha) {
        throw new Error('wide resume snapshots do not match the requested source SHA');
      }
      if (!fs.existsSync(path.join(evidence, 'wide-write-set.json'))) {
        throw new Error('wide resume requires the recorded write set');
      }
      wideHead = await runText('wide-resume-head', 'git', ['rev-parse', 'HEAD']);
      const preflight = await snapshot('wide-resume-preflight');
      if (!preflight.gitStatus.clean) throw new Error('wide resume worktree is not clean');
      if (preflight.metadata?.incrementalInProgress) {
        throw new Error('wide resume refuses an existing dirty marker');
      }
      if (preflight.metadata?.lastCommit !== controlled.head || wideHead === controlled.head) {
        throw new Error('wide resume does not match the controlled-to-wide boundary');
      }
    } else {
      await run('clone', 'git', ['clone', '--shared', '--no-checkout', source, worktree], {
        cwd: path.dirname(worktree),
        env: baseEnv,
      });
      await run('checkout-source-sha', 'git', ['checkout', '--detach', sourceSha]);
      await run('set-public-origin', 'git', ['remote', 'set-url', 'origin', publicOrigin]);
      const checkedOut = await runText('verify-source-sha', 'git', ['rev-parse', 'HEAD']);
      if (checkedOut !== sourceSha) throw new Error(`source SHA mismatch: ${checkedOut}`);
      const initialStatus = await runText('verify-initial-clean', 'git', [
        'status',
        '--porcelain=v1',
      ]);
      if (initialStatus) throw new Error('fresh canary clone is not clean');

      await run(
        'initial-analyze',
        process.execPath,
        [cli, 'analyze', worktree, '--embeddings', '0', '--workers', '2', '--index-only'],
        { cwd: packageRoot, env: canaryEnv },
      );
      initial = await snapshot('initial');
      assertSnapshot(initial, sourceSha);
      await run(
        'initial-query',
        process.execPath,
        [cli, 'query', 'gateway authentication', '-r', worktree],
        {
          cwd: packageRoot,
          env: canaryEnv,
        },
      );

      const fixtureRoot = createSafeContainedDirectory(worktree, 'src/r19-canary');
      fs.writeFileSync(
        path.join(fixtureRoot, 'hub.ts'),
        'export function r19CanaryHub(value: number): number {\n  return value + 19;\n}\n',
      );
      fs.writeFileSync(
        path.join(fixtureRoot, 'spoke-a.ts'),
        "import { r19CanaryHub } from './hub.js';\nexport const r19CanaryNeedle = r19CanaryHub(1);\n",
      );
      fs.writeFileSync(
        path.join(fixtureRoot, 'spoke-b.ts'),
        "import { r19CanaryHub } from './hub.js';\nexport const r19CanarySecondary = r19CanaryHub(2);\n",
      );
      await commitAll('r19 controlled add');
      await run(
        'controlled-add-analyze',
        process.execPath,
        [incrementalChild, worktree, '--embeddings', '--fts-query', 'r19CanaryNeedle'],
        { cwd: packageRoot, env: canaryEnv },
      );
      const afterAddHead = await runText('after-add-head', 'git', ['rev-parse', 'HEAD']);
      const afterAdd = await snapshot('controlled-add');
      assertSnapshot(afterAdd, afterAddHead);

      fs.appendFileSync(path.join(fixtureRoot, 'hub.ts'), '\n// r19 controlled edit\n');
      fs.renameSync(
        path.join(fixtureRoot, 'spoke-a.ts'),
        path.join(fixtureRoot, 'spoke-renamed.ts'),
      );
      fs.rmSync(path.join(fixtureRoot, 'spoke-b.ts'));
      fs.writeFileSync(
        path.join(fixtureRoot, 'spoke-c.ts'),
        "import { r19CanaryHub } from './hub.js';\nexport const r19CanaryNeedleV2 = r19CanaryHub(3);\n",
      );
      await commitAll('r19 controlled edit rename delete add');
      await run(
        'controlled-change-analyze',
        process.execPath,
        [incrementalChild, worktree, '--embeddings', '--fts-query', 'r19CanaryNeedleV2'],
        { cwd: packageRoot, env: canaryEnv },
      );
      const controlledHead = await runText('controlled-head', 'git', ['rev-parse', 'HEAD']);
      controlled = await snapshot('controlled-change');
      assertSnapshot(controlled, controlledHead);
      await run(
        'controlled-query',
        process.execPath,
        [cli, 'query', 'r19CanaryNeedleV2', '-r', worktree],
        {
          cwd: packageRoot,
          env: canaryEnv,
        },
      );
      await run(
        'controlled-context',
        process.execPath,
        [cli, 'context', 'r19CanaryHub', '-r', worktree],
        {
          cwd: packageRoot,
          env: canaryEnv,
        },
      );
      await run(
        'controlled-impact',
        process.execPath,
        [cli, 'impact', 'r19CanaryHub', '-r', worktree],
        {
          cwd: packageRoot,
          env: canaryEnv,
        },
      );

      const trackedFiles = (await runText('tracked-typescript', 'git', ['ls-files', '-z', '*.ts']))
        .split('\0')
        .filter((file) => file && !file.startsWith('src/r19-canary/'));
      const tracked = selectSafeTrackedFiles(worktree, trackedFiles, 51);
      if (tracked.length !== 51)
        throw new Error(`expected 51 TypeScript files, found ${tracked.length}`);
      tracked.forEach(({ file }, index) => {
        fs.appendFileSync(path.join(worktree, file), `\n// gitnexus-r19-wide-${index}\n`);
      });
      writeJson(path.join(evidence, 'wide-write-set.json'), tracked);
      await commitAll('r19 force incremental scale escalation');
      wideHead = await runText('wide-head', 'git', ['rev-parse', 'HEAD']);
    }

    const interrupted = await interruptAtRecoveryBoundary('during-delete');
    if (interrupted.dirty?.boundary !== 'during-delete') {
      throw new Error(`unexpected recovery boundary: ${JSON.stringify(interrupted.dirty)}`);
    }
    if (interrupted.dirty?.dirty?.phase !== 'escalated-full-write') {
      throw new Error(`unexpected dirty phase: ${JSON.stringify(interrupted.dirty)}`);
    }
    if (Number(interrupted.dirty?.dirty?.effectiveWriteCount ?? 0) < 50) {
      throw new Error('incremental escalation write set was smaller than 50 files');
    }
    const dirtySnapshot = await snapshot('interrupted-dirty');
    if (!dirtySnapshot.metadata?.incrementalInProgress) {
      throw new Error('interrupted analysis left no dirty marker');
    }

    await run(
      'resume-after-interruption',
      process.execPath,
      [incrementalChild, worktree, '--embeddings', '--fts-query', 'r19CanaryNeedleV2'],
      { cwd: packageRoot, env: canaryEnv },
    );
    const recovered = await snapshot('recovered', { fingerprint: true });
    assertSnapshot(recovered, wideHead);

    await run(
      'forced-rebuild',
      process.execPath,
      [incrementalChild, worktree, '--force', '--embeddings', '--fts-query', 'r19CanaryNeedleV2'],
      { cwd: packageRoot, env: canaryEnv },
    );
    const forced = await snapshot('forced', { fingerprint: true });
    assertSnapshot(forced, wideHead);
    const recoveredForcedComparison = compareSnapshots(recovered, forced);
    writeJsonArtifact(evidence, 'recovered-forced-comparison', recoveredForcedComparison);
    if (!recoveredForcedComparison.equal) {
      throw new Error('recovered and forced graphs produced different fingerprints');
    }
    await run('final-status', process.execPath, [cli, 'status'], { cwd: worktree, env: canaryEnv });
    await run('final-doctor', process.execPath, [cli, 'doctor', worktree], {
      cwd: packageRoot,
      env: canaryEnv,
    });
    await run(
      'final-query',
      process.execPath,
      [cli, 'query', 'r19CanaryNeedleV2', '-r', worktree],
      {
        cwd: packageRoot,
        env: canaryEnv,
      },
    );

    const summary = {
      runId,
      result: 'passed',
      sourceSha,
      finalHead: wideHead,
      publicOrigin,
      embedding: { model, dimensions, ...embeddingStats },
      initial: initial.metadata.stats,
      controlled: controlled.metadata.stats,
      recovered: recovered.metadata.stats,
      forced: forced.metadata.stats,
      interrupted: interrupted.dirty,
      worktree,
      evidence,
    };
    writeJson(path.join(evidence, 'summary.json'), summary);
    process.stdout.write(`[${runId}] passed\n`);
  }
} catch (error) {
  writeJson(failurePath, {
    runId,
    at: new Date().toISOString(),
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    embedding: { model, dimensions, ...embeddingStats },
  });
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  if (!process.exitCode) process.exitCode = 1;
} finally {
  childSupervisor.disposeSignalHandlers();
  await new Promise((resolve) => embeddingServer.close(resolve));
}
