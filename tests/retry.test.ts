import { describe, expect, it, vi } from 'vitest';
import { CircuitBreaker, computeBackoff, withRetry } from '../server/llm/retry';

describe('computeBackoff', () => {
  it('grows exponentially and is capped', () => {
    const noJitter = () => 0;
    expect(computeBackoff(1, 100, 1000, 0, noJitter)).toBe(100);
    expect(computeBackoff(2, 100, 1000, 0, noJitter)).toBe(200);
    expect(computeBackoff(3, 100, 1000, 0, noJitter)).toBe(400);
    expect(computeBackoff(10, 100, 1000, 0, noJitter)).toBe(1000);
  });

  it('adds bounded jitter', () => {
    const value = computeBackoff(3, 100, 5000, 0.5, () => 1);
    expect(value).toBeGreaterThan(400);
    expect(value).toBeLessThanOrEqual(600);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { maxAttempts: 3, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries retryable failures and reports each wait', async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky');
        return 'recovered';
      },
      { maxAttempts: 3, sleep, onRetry, rand: () => 0 },
    );
    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('stops immediately for non-retryable errors', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw new Error('bad request');
    });
    await expect(withRetry(fn, { maxAttempts: 4, isRetryable: () => false, sleep })).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rethrows the final error after exhausting attempts', async () => {
    const sleep = vi.fn(async () => undefined);
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw new Error(`failure ${attempts}`);
        },
        { maxAttempts: 3, sleep, rand: () => 0 },
      ),
    ).rejects.toThrow('failure 3');
    expect(attempts).toBe(3);
  });
});

describe('CircuitBreaker', () => {
  it('opens after the threshold, rejects, then half-opens after the timeout', () => {
    let now = 1000;
    const breaker = new CircuitBreaker({ threshold: 2, resetTimeoutMs: 5000, now: () => now });
    expect(breaker.state).toBe('closed');
    expect(breaker.canRequest()).toBe(true);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    expect(breaker.canRequest()).toBe(false);

    now += 5001;
    expect(breaker.state).toBe('half-open');
    expect(breaker.canRequest()).toBe(true);
    // only one probe is allowed while half-open
    expect(breaker.canRequest()).toBe(false);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.failureCount).toBe(0);
  });
});
