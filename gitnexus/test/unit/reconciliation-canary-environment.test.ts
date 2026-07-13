import { describe, expect, it } from 'vitest';

import { createSanitizedEnvironment } from '../../scripts/reconciliation/canary-environment.mjs';

describe('reconciliation canary environment', () => {
  it('retains only process plumbing and replaces user Git configuration', () => {
    const result = createSanitizedEnvironment(
      {
        PATH: '/usr/bin',
        LANG: 'en_US.UTF-8',
        TMPDIR: '/tmp/canary',
        GH_TOKEN: 'github-secret',
        GITHUB_TOKEN: 'actions-secret',
        OPENAI_API_KEY: 'openai-secret',
        AWS_SECRET_ACCESS_KEY: 'aws-secret',
        npm_config_token: 'npm-secret',
      },
      { home: '/tmp/isolated-home', platform: 'darwin' },
    );

    expect(result).toEqual({
      PATH: '/usr/bin',
      TMPDIR: '/tmp/canary',
      LANG: 'en_US.UTF-8',
      HOME: '/tmp/isolated-home',
      USERPROFILE: '/tmp/isolated-home',
      CI: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    });
    expect(Object.values(result)).not.toContain('github-secret');
    expect(Object.values(result)).not.toContain('openai-secret');
  });

  it('retains required Windows process keys without inheriting credentials', () => {
    const result = createSanitizedEnvironment(
      {
        PATH: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        GH_TOKEN: 'github-secret',
      },
      { home: 'C:\\canary-home', platform: 'win32' },
    );

    expect(result.SystemRoot).toBe('C:\\Windows');
    expect(result.COMSPEC).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(result.GIT_CONFIG_GLOBAL).toBe('NUL');
    expect(result).not.toHaveProperty('GH_TOKEN');
  });

  it('requires an isolated home', () => {
    expect(() => createSanitizedEnvironment({ PATH: '/usr/bin' }, {})).toThrow(
      'sanitized environment requires an isolated home',
    );
  });
});
