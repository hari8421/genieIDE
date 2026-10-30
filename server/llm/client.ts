import { CircuitBreaker, withRetry } from './retry';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: ChatUsage;
  model?: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
  stream?: boolean;
}

export interface ModelInfo {
  id: string;
  contextLength?: number;
  state?: string;
}

export type LLMErrorKind = 'network' | 'http' | 'protocol' | 'aborted' | 'timeout' | 'circuit-open';

export class LLMError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  readonly kind: LLMErrorKind;

  constructor(message: string, options: { status?: number; retryable: boolean; kind: LLMErrorKind }) {
    super(message);
    this.name = 'LLMError';
    this.status = options.status;
    this.retryable = options.retryable;
    this.kind = options.kind;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** Aborted requests and 4xx validation errors must never be retried. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof LLMError) return error.retryable;
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; code?: string };
  if (e.name === 'AbortError') return false;
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;
  // fetch throws TypeError for transport failures
  if (e.name === 'TypeError') return true;
  return false;
}

export function normalizeBaseUrl(url: string): string {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://127.0.0.1:1234/v1';
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  args: string;
}

function mergeToolCalls(
  acc: Map<number, ToolCallAccumulator>,
  deltas: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>,
): void {
  for (const delta of deltas) {
    const index = typeof delta.index === 'number' ? delta.index : acc.size;
    let current = acc.get(index);
    if (!current) {
      current = { id: delta.id ?? `call_${index}`, name: '', args: '' };
      acc.set(index, current);
    }
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (delta.function?.arguments) current.args += delta.function.arguments;
  }
}

function toToolCalls(acc: Map<number, ToolCallAccumulator>): ToolCall[] {
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, value]) => value.name)
    .map(([, value]) => ({
      id: value.id,
      type: 'function' as const,
      function: { name: value.name, arguments: value.args || '{}' },
    }));
}

function snippet(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface LMStudioClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  breaker?: CircuitBreaker;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Minimal OpenAI-compatible client aimed at LM Studio.
 * Streaming, tool calls, timeouts, retry with backoff and a circuit breaker.
 */
export class LMStudioClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey?: string;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly breaker: CircuitBreaker;
  private readonly onRetry?: LMStudioClientOptions['onRetry'];
  private readonly sleep?: (ms: number) => Promise<void>;

  constructor(options: LMStudioClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens ?? 2048;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.breaker = options.breaker ?? new CircuitBreaker();
    this.onRetry = options.onRetry;
    this.sleep = options.sleep;
  }

  get circuitState(): string {
    return this.breaker.state;
  }

  async listModels(options: { signal?: AbortSignal } = {}): Promise<ModelInfo[]> {
    const json = (await this.getJson('/models', options.signal)) as {
      data?: Array<Record<string, unknown>>;
    };
    const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? (json as Array<Record<string, unknown>>) : [];
    return data
      .map((entry) => {
        const id = String(entry.id ?? entry.model ?? '');
        const contextLength =
          Number(entry.max_context_length ?? entry.loaded_context_length ?? entry.context_length ?? 0) || undefined;
        const state = typeof entry.state === 'string' ? entry.state : undefined;
        return { id, contextLength, state };
      })
      .filter((m) => m.id);
  }

  async health(options: { signal?: AbortSignal } = {}): Promise<{
    ok: boolean;
    baseUrl: string;
    models: ModelInfo[];
    error?: string;
  }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const models = await this.withTimeoutSignal(options.signal, controller, () => this.listModels({ signal: controller.signal }));
        return { ok: true, baseUrl: this.baseUrl, models };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        ok: false,
        baseUrl: this.baseUrl,
        models: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async chat(request: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult> {
    if (!this.breaker.canRequest()) {
      throw new LLMError(
        `LM Studio appears offline (circuit open after ${this.breaker.failureCount} failures). Start the server in LM Studio and load a model, then retry.`,
        { retryable: false, kind: 'circuit-open' },
      );
    }

    let sawDelta = false;
    try {
      const result = await withRetry(
        async () => {
          sawDelta = false;
          return this.attempt(request, (delta) => {
            sawDelta = true;
            onDelta?.(delta);
          });
        },
        {
          maxAttempts: this.maxAttempts,
          signal: request.signal,
          sleep: this.sleep,
          onRetry: this.onRetry,
          // Never replay a request that already streamed tokens to the caller:
          // doing so would duplicate visible output and tool calls.
          isRetryable: (error) => !sawDelta && isRetryableError(error),
        },
      );
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      this.breaker.recordFailure();
      throw error;
    }
  }

  private async attempt(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: request.model ?? this.model,
      messages: request.messages.map((m) => {
        const wire: Record<string, unknown> = { role: m.role, content: m.content };
        if (m.tool_call_id) wire.tool_call_id = m.tool_call_id;
        if (m.name) wire.name = m.name;
        if (m.tool_calls?.length) wire.tool_calls = m.tool_calls;
        return wire;
      }),
      temperature: request.temperature ?? this.temperature,
      max_tokens: request.maxTokens ?? this.maxTokens,
      stream: request.stream ?? true,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = request.toolChoice ?? 'auto';
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream, application/json',
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const external = request.signal;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    external?.addEventListener('abort', onExternalAbort, { once: true });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw this.wrapTransportError(error, external);
    } finally {
      external?.removeEventListener('abort', onExternalAbort);
    }

    try {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const retryable = RETRYABLE_STATUS.has(response.status);
        throw new LLMError(
          `LM Studio returned HTTP ${response.status}${text ? `: ${snippet(text)}` : ''}`,
          { status: response.status, retryable, kind: 'http' },
        );
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && response.body) {
        return await this.readStream(response, request.model ?? this.model, onDelta);
      }

      const json = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string | null; tool_calls?: ToolCall[] };
          delta?: { content?: string | null; tool_calls?: ToolCall[] };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const choice = json.choices?.[0];
      const content = choice?.message?.content ?? choice?.delta?.content ?? '';
      if (content) onDelta(content);
      return {
        content: content ?? '',
        toolCalls: choice?.message?.tool_calls ?? choice?.delta?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? 'stop',
        usage: json.usage
          ? { promptTokens: json.usage.prompt_tokens ?? 0, completionTokens: json.usage.completion_tokens ?? 0 }
          : undefined,
        model: json.model,
      };
    } catch (error) {
      throw this.wrapTransportError(error, external);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readStream(response: Response, model: string, onDelta: (text: string) => void): Promise<ChatResult> {
    if (!response.body) {
      throw new LLMError('LM Studio returned an empty stream.', { retryable: true, kind: 'protocol' });
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const toolAcc = new Map<number, ToolCallAccumulator>();
    let buffer = '';
    let content = '';
    let finishReason = '';
    let usage: ChatUsage | undefined;
    let modelId = model;

    const consume = (payload: string) => {
      const data = payload.trim();
      if (!data || data === '[DONE]') return;
      let parsed: {
        model?: string;
        choices?: Array<{
          delta?: { content?: string | null; tool_calls?: ToolCall[] };
          message?: { content?: string | null; tool_calls?: ToolCall[] };
          finish_reason?: string | null;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // ignore keep-alives / partial garbage
      }
      if (parsed.model) modelId = parsed.model;
      const choice = parsed.choices?.[0];
      const delta = choice?.delta ?? choice?.message ?? undefined;
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta?.tool_calls?.length) {
        mergeToolCalls(toolAcc, delta.tool_calls as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (parsed.usage) {
        usage = {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) consume(line.slice(5));
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) consume(line.slice(5));
    }

    const toolCalls = toToolCalls(toolAcc);
    return {
      content,
      toolCalls,
      finishReason: finishReason || (toolCalls.length ? 'tool_calls' : 'stop'),
      usage,
      model: modelId,
    };
  }

  private async getJson(pathname: string, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 15_000));
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new LLMError(`LM Studio returned HTTP ${res.status} for ${pathname}`, {
          status: res.status,
          retryable: RETRYABLE_STATUS.has(res.status),
          kind: 'http',
        });
      }
      return await res.json();
    } catch (error) {
      throw this.wrapTransportError(error, signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private withTimeoutSignal<T>(
    external: AbortSignal | undefined,
    controller: AbortController,
    fn: () => Promise<T>,
  ): Promise<T> {
    const onExternalAbort = () => controller.abort();
    external?.addEventListener('abort', onExternalAbort, { once: true });
    return fn().finally(() => external?.removeEventListener('abort', onExternalAbort));
  }

  private wrapTransportError(error: unknown, external?: AbortSignal): unknown {
    if (error instanceof LLMError) return error;
    const e = error as { name?: string; message?: string; code?: string };
    if (e?.name === 'AbortError') {
      if (external?.aborted) {
        return new LLMError('Request cancelled.', { retryable: false, kind: 'aborted' });
      }
      return new LLMError(
        `LM Studio did not respond within ${Math.round(this.timeoutMs / 1000)}s. A local model may still be loading.`,
        { retryable: true, kind: 'timeout' },
      );
    }
    return new LLMError(
      `Could not reach LM Studio at ${this.baseUrl}: ${e?.message ?? String(error)}. Is the local server running with a model loaded?`,
      { retryable: isRetryableError(error), kind: 'network' },
    );
  }
}

export function createClientFromConfig(
  config: {
    lmStudioBaseUrl: string;
    model: string;
    temperature?: number;
    maxTokens?: number;
    requestTimeoutMs?: number;
    maxAttempts?: number;
  },
  deps: { fetchImpl?: typeof fetch; onRetry?: LMStudioClientOptions['onRetry']; breaker?: CircuitBreaker } = {},
): LMStudioClient {
  return new LMStudioClient({
    baseUrl: config.lmStudioBaseUrl,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    timeoutMs: config.requestTimeoutMs,
    maxAttempts: config.maxAttempts,
    fetchImpl: deps.fetchImpl,
    onRetry: deps.onRetry,
    breaker: deps.breaker,
  });
}
