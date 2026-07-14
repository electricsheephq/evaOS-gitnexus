const PORTABLE_KEYS = [
  'PATH',
  'SHELL',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
];

const WINDOWS_KEYS = ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'];

export const createSanitizedEnvironment = (source, { home, platform = process.platform } = {}) => {
  if (!home) throw new Error('sanitized environment requires an isolated home');

  const result = {};
  const allowedKeys = platform === 'win32' ? [...PORTABLE_KEYS, ...WINDOWS_KEYS] : PORTABLE_KEYS;
  for (const key of allowedKeys) {
    if (typeof source[key] === 'string') result[key] = source[key];
  }

  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    CI: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
  };
};
