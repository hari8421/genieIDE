import { LLMError, type LMStudioClient } from './client';
import { withRetry } from './retry';

/** Strip markdown fences and prose around a JSON object, then parse. */
export function parseJsonLoose<T = unknown>(text: string): T {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new Error('Empty response where JSON was expected');

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1]?.trim() ?? trimmed;

  try {
    return JSON.parse(body) as T;
  } catch {
    // fall through to brace extraction
  }

  const start = body.search(/[[{]/);
  if (start >= 0) {
    const open = body[start];
    const close = open === '{' ? '}' : ']';
    const end = body.lastIndexOf(close);
    if (end > start) {
      const candidate = body.slice(start, end + 1);
      try {
        return JSON.parse(candidate) as T;
      } catch {
        // ignore
      }
    }
  }
  throw new Error(`Could not parse JSON from model output: ${body.slice(0, 200)}`);
}

export interface StructuredOptions<T> {
  /** Validates the parsed value; throw to trigger a repair attempt. */
  validate?: (value: unknown) => T;
  maxRepairs?: number;
  onRepair?: (info: { attempt: number; error: string }) => void;
}

/**
 * Ask a local model for JSON and repair malformed output by feeding the parse
 * error back. Local models routinely emit near-JSON; this keeps spec generation
 * from dying on a stray trailing comma.
 */
export async function requestStructured<T>(
  client: LMStudioClient,
  args: {
    system: string;
    user: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  },
  options: StructuredOptions<T> = {},
): Promise<T> {
  const maxRepairs = options.maxRepairs ?? 2;
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: args.system },
    { role: 'user', content: args.user },
  ];

  let lastError = '';
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    const result = await withRetry(
      () =>
        client.chat(
          {
            messages,
            temperature: args.temperature ?? 0.1,
            maxTokens: args.maxTokens,
            stream: true,
            signal: args.signal,
          },
          () => undefined,
        ),
      {
        maxAttempts: 2,
        isRetryable: (error) => error instanceof LLMError && error.retryable,
      },
    );

    try {
      const parsed = parseJsonLoose(result.content);
      return options.validate ? options.validate(parsed) : (parsed as T);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      options.onRepair?.({ attempt: attempt + 1, error: lastError });
      messages.push({ role: 'assistant', content: result.content.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: `That was not valid JSON (${lastError}). Reply with valid JSON only. No markdown fences, no commentary.`,
      });
    }
  }
  throw new Error(`Model did not return valid JSON after ${maxRepairs + 1} attempts: ${lastError}`);
}
