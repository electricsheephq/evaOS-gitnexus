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

export function parseMaxTokens(value: string | number | undefined): { value?: number; error?: string } {
  if (value === undefined || value === '') return {};
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { error: 'must be a positive integer.' };
  }
  return { value: parsed };
}
