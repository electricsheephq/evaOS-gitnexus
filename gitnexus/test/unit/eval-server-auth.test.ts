import { describe, expect, it } from 'vitest';
import {
  assertSecureEvalServerBinding,
  isEvalServerBearerAuthorized,
  isEvalServerLoopbackHost,
  resolveEvalServerAuthToken,
} from '../../src/cli/eval-server.js';

describe('eval-server bearer authentication', () => {
  it('resolves a trimmed token and treats blank values as absent', () => {
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '  secret-value  ' })).toBe(
      'secret-value',
    );
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '' })).toBeUndefined();
    expect(resolveEvalServerAuthToken({ GITNEXUS_AUTH_TOKEN: '   ' })).toBeUndefined();
  });

  it.each(['127.0.0.1', '127.0.0.2', 'localhost', '::1'])('classifies %s as loopback', (host) => {
    expect(isEvalServerLoopbackHost(host)).toBe(true);
  });

  it.each(['0.0.0.0', '::', '192.168.1.50', '2001:db8::1', 'localhost.evil.test'])(
    'classifies %s as non-loopback',
    (host) => {
      expect(isEvalServerLoopbackHost(host)).toBe(false);
    },
  );

  it('allows loopback without a token and requires one for non-loopback binds', () => {
    expect(() => assertSecureEvalServerBinding('127.0.0.1', undefined)).not.toThrow();
    expect(() => assertSecureEvalServerBinding('::1', undefined)).not.toThrow();
    expect(() => assertSecureEvalServerBinding('0.0.0.0', 'secret-value')).not.toThrow();
    expect(() => assertSecureEvalServerBinding('192.168.1.50', undefined)).toThrow(
      /non-loopback.*GITNEXUS_AUTH_TOKEN/i,
    );
  });

  it('accepts only the exact Bearer header when a token is configured', () => {
    const token = 'secret-value';
    expect(isEvalServerBearerAuthorized(undefined, undefined)).toBe(true);
    expect(isEvalServerBearerAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isEvalServerBearerAuthorized(undefined, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(`Bearer wrong`, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(token, token)).toBe(false);
    expect(isEvalServerBearerAuthorized(`bearer ${token}`, token)).toBe(false);
    expect(isEvalServerBearerAuthorized([`Bearer ${token}`], token)).toBe(false);
  });
});
