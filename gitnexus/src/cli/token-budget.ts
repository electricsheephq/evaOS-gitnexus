export interface ParsedMaxTokens {
  value?: number;
  error?: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function truncateToTokenBudget(text: string, maxTokens: number): string {
  const totalTokens = estimateTokens(text);
  if (totalTokens <= maxTokens) return text;

  const maxChars = maxTokens * 4;
  const truncated = text.substring(0, maxChars);
  const remaining = totalTokens - maxTokens;
  return `${truncated}\n\n... (truncated, ${remaining} more tokens available)`;
}

export function parseMaxTokens(raw: unknown): ParsedMaxTokens {
  if (raw === undefined || raw === null || raw === '') return {};

  const value = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isInteger(value) || value <= 0) {
    return { error: 'maxTokens must be a positive integer.' };
  }

  return { value };
}
