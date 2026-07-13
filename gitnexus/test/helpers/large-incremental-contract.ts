import { spawn, type ChildProcess } from 'node:child_process';

const PORTABLE_ENV_KEYS = [
  'PATH',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
] as const;

const WINDOWS_ENV_KEYS = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'] as const;

export const RECOVERY_BOUNDARY_CASES = [
  ['before-delete', 'escalated-full-write'],
  ['during-delete', 'escalated-full-write'],
  ['during-insert', 'escalated-load-graph'],
  ['before-finalize', 'escalated-load-graph'],
] as const;

export type RecoveryBoundary = (typeof RECOVERY_BOUNDARY_CASES)[number][0];

export const ALL_RECOVERY_BOUNDARIES: readonly RecoveryBoundary[] = RECOVERY_BOUNDARY_CASES.map(
  ([boundary]) => boundary,
);

export function createHermeticProcessEnv(
  source: NodeJS.ProcessEnv,
  home: string,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (!home) throw new Error('hermetic process environment requires an isolated home');
  const allowedKeys =
    platform === 'win32'
      ? ([...PORTABLE_ENV_KEYS, ...WINDOWS_ENV_KEYS] as const)
      : PORTABLE_ENV_KEYS;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    if (typeof source[key] === 'string') env[key] = source[key];
  }
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
    ...overrides,
  };
}

export function selectRecoveryBoundaries(raw: string | undefined): RecoveryBoundary[] {
  if (raw === undefined) return [...ALL_RECOVERY_BOUNDARIES];
  const requested = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error('GITNEXUS_RECOVERY_BOUNDARIES must name at least one boundary');
  }
  const known = new Set<string>(ALL_RECOVERY_BOUNDARIES);
  const unknown = requested.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw new Error(
      `GITNEXUS_RECOVERY_BOUNDARIES contains unknown value(s): ${unknown.join(', ')}`,
    );
  }
  return [...new Set(requested)] as RecoveryBoundary[];
}

export type ChildExit = { code: number | null; signal: NodeJS.Signals | null };

const currentExit = (child: ChildProcess): ChildExit | undefined => {
  if (child.exitCode === null && child.signalCode === null) return undefined;
  return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
};

export async function terminateChild(
  child: ChildProcess,
  graceMs = 30_000,
  killWaitMs = 5_000,
): Promise<ChildExit> {
  const exited = currentExit(child);
  if (exited) return exited;

  return new Promise<ChildExit>((resolve, reject) => {
    let killTimer: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      if (killTimer) clearTimeout(killTimer);
      child.off('exit', onExit);
    };
    const finish = (result: ChildExit): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish({ code, signal });
    };
    const graceTimer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error('child did not terminate after SIGKILL'));
      }, killWaitMs);
    }, graceMs);

    child.once('exit', onExit);
    const racedExit = currentExit(child);
    if (racedExit) {
      finish(racedExit);
      return;
    }

    child.kill('SIGTERM');
  });
}

export interface ReadyProcessOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  readyPrefix: string;
  timeoutMs?: number;
  terminateGraceMs?: number;
  cwd?: string;
}

export async function startReadyProcess(
  options: ReadyProcessOptions,
): Promise<{ child: ChildProcess; value: string }> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  try {
    const value = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const timeoutMs = options.timeoutMs ?? 30_000;
      const timer = setTimeout(
        () => rejectOnce(new Error(`child did not become ready within ${timeoutMs}ms`)),
        timeoutMs,
      );

      const cleanup = (): void => {
        clearTimeout(timer);
        child.stdout?.off('data', onStdout);
        child.stderr?.off('data', onStderr);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const rejectOnce = (error: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onStdout = (chunk: Buffer | string): void => {
        stdout += chunk.toString();
        const line = stdout
          .split(/\r?\n/u)
          .find((candidate) => candidate.startsWith(options.readyPrefix));
        if (!line || settled) return;
        settled = true;
        cleanup();
        resolve(line.slice(options.readyPrefix.length));
      };
      const onStderr = (chunk: Buffer | string): void => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8_192);
      };
      const onError = (error: Error): void => rejectOnce(error);
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        rejectOnce(
          new Error(
            `child exited before ready: code=${code} signal=${signal}${stderr ? ` ${stderr}` : ''}`,
          ),
        );

      child.stdout?.on('data', onStdout);
      child.stderr?.on('data', onStderr);
      child.once('error', onError);
      child.once('exit', onExit);
    });
    return { child, value };
  } catch (error) {
    try {
      await terminateChild(child, options.terminateGraceMs ?? 1_000);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'child startup and cleanup both failed');
    }
    throw error;
  }
}
