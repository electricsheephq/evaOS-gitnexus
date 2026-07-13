import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

const codePointCompare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const assertDirectory = (directory) => {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error(`refusing symbolic link in canary evidence path: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`expected canary evidence directory: ${directory}`);
  }
};

const assertTreeHasNoSymlinks = (directory) => {
  assertDirectory(directory);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`refusing symbolic link in canary evidence path: ${entryPath}`);
    }
    if (entry.isDirectory()) assertTreeHasNoSymlinks(entryPath);
  }
};

export const prepareEvidenceLayout = ({ evidence, commandDir, snapshotDir, home }) => {
  fs.mkdirSync(evidence, { recursive: true });
  assertDirectory(evidence);
  for (const directory of [commandDir, snapshotDir, home]) {
    fs.mkdirSync(directory, { recursive: true });
    assertDirectory(directory);
  }
  assertTreeHasNoSymlinks(commandDir);
  assertTreeHasNoSymlinks(snapshotDir);
  assertTreeHasNoSymlinks(home);
};

export const writeJsonAtomic = (filePath, value) => {
  assertDirectory(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
};

const artifactStem = (name, attempt) => (attempt === 1 ? name : `${name}-attempt-${attempt}`);

export const openArtifactLogs = (directory, name) => {
  assertDirectory(directory);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const stem = artifactStem(name, attempt);
    const stdoutPath = path.join(directory, `${stem}.stdout.log`);
    const stderrPath = path.join(directory, `${stem}.stderr.log`);
    let stdout;
    try {
      stdout = fs.openSync(stdoutPath, 'wx', 0o600);
      const stderr = fs.openSync(stderrPath, 'wx', 0o600);
      return { stdoutPath, stderrPath, stdout, stderr };
    } catch (error) {
      if (stdout !== undefined) {
        fs.closeSync(stdout);
        fs.rmSync(stdoutPath, { force: true });
      }
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not allocate unique command artifacts for ${name}`);
};

export const writeJsonArtifact = (directory, name, value) => {
  assertDirectory(directory);
  for (let attempt = 1; attempt < 10_000; attempt += 1) {
    const filePath = path.join(directory, `${artifactStem(name, attempt)}.json`);
    try {
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      return filePath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`could not allocate unique JSON artifact for ${name}`);
};

const isContained = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
};

const assertNoSymlinkComponents = (root, candidate) => {
  const relative = path.relative(root, candidate);
  let cursor = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    if (fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`refusing symbolic link in canary worktree path: ${cursor}`);
    }
  }
};

export const createSafeContainedDirectory = (root, relativePath) => {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!isContained(resolvedRoot, candidate) || candidate === resolvedRoot) {
    throw new Error(`refusing directory outside canary worktree: ${relativePath}`);
  }
  if (fs.existsSync(candidate)) {
    throw new Error(`refusing existing canary fixture directory: ${candidate}`);
  }
  let cursor = resolvedRoot;
  for (const component of path.relative(resolvedRoot, candidate).split(path.sep)) {
    cursor = path.join(cursor, component);
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) {
        throw new Error(`refusing symbolic link in canary worktree path: ${cursor}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`refusing non-directory in canary worktree path: ${cursor}`);
      }
    } else {
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const realCandidate = fs.realpathSync(candidate);
  if (!isContained(realRoot, realCandidate)) {
    throw new Error(`refusing directory outside real canary worktree: ${relativePath}`);
  }
  return candidate;
};

export const selectSafeTrackedFiles = (worktree, files, count) => {
  const realWorktree = fs.realpathSync(worktree);
  const candidates = files.map((file) => {
    if (!file || path.isAbsolute(file)) {
      throw new Error(`refusing unsafe tracked path: ${JSON.stringify(file)}`);
    }
    const candidate = path.resolve(worktree, file);
    if (!isContained(path.resolve(worktree), candidate)) {
      throw new Error(`refusing tracked path outside canary worktree: ${file}`);
    }
    assertNoSymlinkComponents(path.resolve(worktree), candidate);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing tracked symbolic link in canary mutation set: ${file}`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing non-file in canary mutation set: ${file}`);
    }
    const realCandidate = fs.realpathSync(candidate);
    if (!isContained(realWorktree, realCandidate)) {
      throw new Error(`refusing tracked path outside real canary worktree: ${file}`);
    }
    return { file, bytes: stat.size };
  });
  return candidates
    .sort((left, right) => left.bytes - right.bytes || codePointCompare(left.file, right.file))
    .slice(0, count);
};

export class ChildSupervisor {
  constructor({ platform = process.platform, killTimeoutMs = 5_000 } = {}) {
    this.platform = platform;
    this.killTimeoutMs = killTimeoutMs;
    this.children = new Set();
    this.receivedSignal = undefined;
    this.signalHandlers = new Map();
  }

  spawn(command, args, options = {}) {
    if (this.receivedSignal) {
      throw new Error(`refusing child spawn after ${this.receivedSignal}`);
    }
    const child = spawn(command, args, {
      ...options,
      detached: this.platform !== 'win32',
    });
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    return child;
  }

  terminate(child, signal = 'SIGTERM') {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (this.platform === 'win32') {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (result.error || result.status !== 0) child.kill(signal);
      return;
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== 'ESRCH') child.kill(signal);
    }
  }

  terminateAll(signal = 'SIGTERM') {
    const children = [...this.children];
    for (const child of children) this.terminate(child, signal);
    if (children.length > 0) {
      const timer = setTimeout(() => {
        for (const child of this.children) this.terminate(child, 'SIGKILL');
      }, this.killTimeoutMs);
      timer.unref();
    }
  }

  installSignalHandlers(targetProcess = process, onSignal = () => {}) {
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        if (this.receivedSignal) return;
        this.receivedSignal = signal;
        targetProcess.exitCode = SIGNAL_EXIT_CODES[signal];
        this.terminateAll(signal);
        onSignal(signal);
      };
      this.signalHandlers.set(signal, handler);
      targetProcess.on(signal, handler);
    }
  }

  disposeSignalHandlers(targetProcess = process) {
    for (const [signal, handler] of this.signalHandlers) {
      targetProcess.off(signal, handler);
    }
    this.signalHandlers.clear();
  }
}
