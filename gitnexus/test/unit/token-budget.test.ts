import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  parseMaxTokens,
  truncateToTokenBudget,
} from '../../src/cli/token-budget.js';

describe('token budget helpers', () => {
  it('estimates tokens with the four-character heuristic', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('truncates text above the requested token budget', () => {
    const result = truncateToTokenBudget('abcdefghijkl', 2);
    expect(result).toBe('abcdefgh\n\n... (truncated, 1 more tokens available)');
  });

  it('leaves text within budget unchanged', () => {
    expect(truncateToTokenBudget('abcd', 1)).toBe('abcd');
  });

  it('accepts positive integer maxTokens values', () => {
    expect(parseMaxTokens('12')).toEqual({ value: 12 });
    expect(parseMaxTokens(3)).toEqual({ value: 3 });
  });

  it('treats missing maxTokens as unset', () => {
    expect(parseMaxTokens(undefined)).toEqual({});
    expect(parseMaxTokens('')).toEqual({});
  });

  it('rejects invalid maxTokens values', () => {
    expect(parseMaxTokens('nope').error).toMatch(/positive integer/);
    expect(parseMaxTokens('0').error).toMatch(/positive integer/);
    expect(parseMaxTokens('-1').error).toMatch(/positive integer/);
    expect(parseMaxTokens('1.5').error).toMatch(/positive integer/);
  });
});
