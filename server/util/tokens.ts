/**
 * Cheap, deterministic token estimation.
 *
 * We deliberately do not ship a tokenizer: LM Studio models use many different
 * tokenizers and a wrong-but-fast estimate is enough for budgeting as long as it
 * errs on the high side. Code is punctuation heavy, so we take the larger of a
 * chars/4 and a words*1.3 estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const chars = Math.ceil(text.length / 4);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(chars, Math.ceil(words * 1.3));
}

export const MESSAGE_OVERHEAD_TOKENS = 4;
export const TRUNCATION_MARKER = '\n…[truncated]…\n';

export function estimateMessagesTokens(messages: ReadonlyArray<{ content: string }>): number {
  return messages.reduce((sum, m) => sum + MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content), 0);
}

/**
 * Head/tail truncation: keeps the start of a file (imports, signatures) and the
 * end (usually the most recently edited code) instead of blindly cutting the tail.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;

  const budgetChars = Math.max(1, Math.floor(maxTokens * 4) - TRUNCATION_MARKER.length);
  let headChars = Math.floor(budgetChars * 0.6);
  let tailChars = budgetChars - headChars;

  for (let guard = 0; guard < 12; guard += 1) {
    const head = text.slice(0, headChars);
    const tail = tailChars > 0 ? text.slice(text.length - tailChars) : '';
    const candidate = `${head}${TRUNCATION_MARKER}${tail}`;
    if (estimateTokens(candidate) <= maxTokens) return candidate;
    headChars = Math.floor(headChars * 0.8);
    tailChars = Math.floor(tailChars * 0.8);
    if (headChars <= 0 && tailChars <= 0) break;
  }

  return text.slice(0, Math.max(1, Math.floor(maxTokens * 2)));
}
