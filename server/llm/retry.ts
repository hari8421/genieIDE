export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** 0..1 random source, injectable for deterministic tests. */
  jitterRatio?: number;
  rand?: () => number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
}

export function computeBackoff(
  attempt: number,
  baseMs = 500,
  maxMs = 8000,
  jitterRatio = 0.2,
  rand: () => number = Math.random,
): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = exponential * jitterRatio * rand();
  return Math.round(Math.min(maxMs, exponential + jitter));
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Retry with exponential backoff + jitter. Always rethrows the final error.
 * `onRetry` is called before each wait so callers can journal the failure.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const isRetryable = options.isRetryable ?? (() => true);
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.signal));

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetryable(error) && !options.signal?.aborted;
      if (!canRetry) throw error;
      const delayMs = computeBackoff(attempt, options.baseDelayMs, options.maxDelayMs, options.jitterRatio, options.rand);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Prevents hammering a dead LM Studio instance: after `threshold` consecutive
 * failures requests fail fast until `resetTimeoutMs` elapses, then a single
 * probe is allowed through.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private probing = false;

  constructor(
    private readonly options: { threshold?: number; resetTimeoutMs?: number; now?: () => number } = {},
  ) {}

  private get threshold(): number {
    return this.options.threshold ?? 3;
  }

  private get resetTimeoutMs(): number {
    return this.options.resetTimeoutMs ?? 15_000;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  get state(): BreakerState {
    if (this.openedAt === null) return 'closed';
    if (this.now() - this.openedAt >= this.resetTimeoutMs) return 'half-open';
    return 'open';
  }

  get failureCount(): number {
    return this.failures;
  }

  canRequest(): boolean {
    const state = this.state;
    if (state === 'open') return false;
    if (state === 'half-open') {
      if (this.probing) return false;
      this.probing = true;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
    this.probing = false;
  }

  recordFailure(): void {
    this.failures += 1;
    this.probing = false;
    if (this.failures >= this.threshold) {
      this.openedAt = this.now();
    }
  }
}
