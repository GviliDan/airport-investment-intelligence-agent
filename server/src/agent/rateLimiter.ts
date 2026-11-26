/**
 * A small sliding-window rate limiter: at most `limit` calls in any `windowMs` window. `acquire` waits until a slot is free,
 * so callers (including retries) never exceed the provider's requests-per-minute quota. One limiter per model name.
 */
export class RateLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('rate limit must be a positive integer');
  }

  /** Resolves with the time spent waiting (ms). Rejects if the signal aborts first. */
  async acquire(signal?: AbortSignal): Promise<number> {
    let waited = 0;
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const t = this.now();
      while (this.stamps.length > 0 && (this.stamps[0] as number) <= t - this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(t);
        return waited;
      }
      const wait = (this.stamps[0] as number) + this.windowMs - t;
      await this.sleep(wait, signal);
      waited += wait;
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });
}

const registry = new Map<string, RateLimiter>();

/** The shared limiter for a model name (created on first use with the given limit). */
export function limiterFor(model: string, limitPerMinute: number): RateLimiter {
  let l = registry.get(model);
  if (!l) registry.set(model, (l = new RateLimiter(limitPerMinute)));
  return l;
}
