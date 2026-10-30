import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../server/llm/retry';
import { LLMError, LMStudioClient, isRetryableError, normalizeBaseUrl } from '../server/llm/client';
import { parseJsonLoose, requestStructured } from '../server/llm/structured';
import { fakeClient, textResult } from './helpers';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sseResponse = (chunks: string[]): Response =>
  new Response(chunks.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });

function makeClient(fetchImpl: typeof fetch, overrides: Partial<ConstructorParameters<typeof LMStudioClient>[0]> = {}) {
  return new LMStudioClient({
    baseUrl: 'http://127.0.0.1:1234',
    model: 'local-test',
    fetchImpl,
    sleep: async () => undefined,
    maxAttempts: 3,
    ...overrides,
  });
}

describe('normalizeBaseUrl', () => {
  it('appends /v1 when missing and trims trailing slashes', () => {
    expect(normalizeBaseUrl('http://localhost:1234')).toBe('http://localhost:1234/v1');
    expect(normalizeBaseUrl('http://localhost:1234/v1/')).toBe('http://localhost:1234/v1');
    expect(normalizeBaseUrl('')).toBe('http://127.0.0.1:1234/v1');
  });
});

describe('error classification', () => {
  it('treats rate limits and 5xx as retryable but validation errors as final', () => {
    expect(isRetryableError(new LLMError('rate', { status: 429, retryable: true, kind: 'http' }))).toBe(true);
    expect(isRetryableError(new LLMError('bad', { status: 400, retryable: false, kind: 'http' }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isRetryableError(Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }))).toBe(true);
  });
});

describe('chat completions', () => {
  it('reads a non-streamed JSON completion', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 }, model: 'local-test' }),
    );
    const result = await makeClient(fetchImpl as unknown as typeof fetch).chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });

  it('streams text and accumulates fragmented tool calls', async () => {
    const sse = sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.ts\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const fetchImpl = vi.fn(async () => sse);
    const deltas: string[] = [];
    const result = await makeClient(fetchImpl as unknown as typeof fetch).chat(
      { messages: [{ role: 'user', content: 'read a.ts' }] },
      (text) => deltas.push(text),
    );
    expect(deltas.join('')).toBe('Hello');
    expect(result.content).toBe('Hello');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.function.name).toBe('read_file');
    expect(JSON.parse(result.toolCalls[0]!.function.arguments)).toEqual({ path: 'a.ts' });
    expect(result.finishReason).toBe('tool_calls');
  });

  it('retries a 500 and then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'loading model' }, 500))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const result = await makeClient(fetchImpl as unknown as typeof fetch).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'bad request' }, 400));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).chat({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never replays a request that already streamed tokens', async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const brokenStream = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          return;
        }
        controller.error(Object.assign(new Error('socket closed'), { name: 'TypeError' }));
      },
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(brokenStream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'duplicate' } }] }));
    await expect(
      makeClient(fetchImpl as unknown as typeof fetch).chat({ messages: [{ role: 'user', content: 'x' }] }),
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails fast when the circuit is open', async () => {
    const breaker = new CircuitBreaker({ threshold: 2, resetTimeoutMs: 60_000 });
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxAttempts: 1, breaker });
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow();
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/circuit open/i);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports a helpful message when LM Studio is not reachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' });
    });
    const client = makeClient(fetchImpl as unknown as typeof fetch, { maxAttempts: 1 });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.error).toMatch(/Could not reach LM Studio/);
    expect(health.baseUrl).toBe('http://127.0.0.1:1234/v1');
  });

  it('lists models with context length when LM Studio provides it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'qwen2.5-coder-14b', max_context_length: 32768 }] }));
    const models = await makeClient(fetchImpl as unknown as typeof fetch).listModels();
    expect(models).toEqual([{ id: 'qwen2.5-coder-14b', contextLength: 32768, state: undefined }]);
  });
});

describe('structured output', () => {
  it('parses fenced and prose-wrapped JSON', () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonLoose('Here you go: {"b":[1,2]} thanks')).toEqual({ b: [1, 2] });
    expect(() => parseJsonLoose('definitely not json')).toThrow();
  });

  it('repairs an invalid first answer', async () => {
    const client = fakeClient(async (_request, _delta, call) =>
      call === 1 ? textResult('sorry, no json') : textResult('```json\n{"spec":"ok"}\n```'),
    );
    const result = await requestStructured<{ spec: string }>(client, { system: 'sys', user: 'user' }, { maxRepairs: 1 });
    expect(result).toEqual({ spec: 'ok' });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]!.messages.some((m) => m.content.includes('not valid JSON'))).toBe(true);
  });

  it('gives up after the repair budget', async () => {
    const client = fakeClient(async () => textResult('still not json'));
    await expect(
      requestStructured(client, { system: 's', user: 'u' }, { maxRepairs: 1 }),
    ).rejects.toThrow(/did not return valid JSON/);
    expect(client.calls).toHaveLength(2);
  });
});
