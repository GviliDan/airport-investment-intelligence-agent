/** Retry policy for model calls: bounded, exponential backoff with jitter, transient errors only. */

const TRANSIENT = /\b(429|500|502|503|504)\b|rate.?limit|resource.?exhausted|overloaded|high demand|unavailable|deadline|timed? ?out|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|socket hang up/i;
const PERMANENT = /\b(400|401|403|404)\b|api key|permission|invalid argument|not found|safety|blocked/i;

/** A quota that resets in hours (daily free-tier limits): waiting a few seconds cannot help, so it is not retried, only failed over. */
export function isQuotaExhausted(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  // Gemini reports the quota id ("...PerDay...") only in the structured error details, not in the message text.
  const details = err instanceof Error ? safeJson((err as { errorDetails?: unknown }).errorDetails) : '';
  if (/PerDay/i.test(details) && /\b429\b|quota|resource.?exhausted/i.test(`${text} ${details}`)) return true;
  return /per.?day|daily|retry in \d+h|requests per day/i.test(text) && /\b429\b|quota|resource.?exhausted/i.test(text);
}

function safeJson(v: unknown): string {
  try { return v === undefined ? '' : JSON.stringify(v); } catch { return ''; }
}

/** True for failures worth retrying (rate limits, overload, network). Permanent errors such as a bad key are not. */
export function isTransient(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (isQuotaExhausted(err)) return false;
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  if (PERMANENT.test(text) && !/\b(429|500|502|503|504)\b/.test(text)) return false;
  return TRANSIENT.test(text);
}

export interface BackoffOptions {
  readonly maxRetries: number;
  readonly initialMs: number;
  readonly maxMs: number;
  readonly signal?: AbortSignal;
  /** Called before each wait; used for metrics and logging. */
  readonly onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason ?? new Error('aborted')); }, { once: true });
  });

/** Delay before retry number `attempt` (1-based): initial * 2^(attempt-1), jittered to 50-100%, capped. */
export function backoffDelay(attempt: number, initialMs: number, maxMs: number, random: () => number = Math.random): number {
  const base = Math.min(maxMs, initialMs * 2 ** (attempt - 1));
  return Math.round(base * (0.5 + 0.5 * random()));
}

/** Runs `fn`, retrying transient failures up to `maxRetries` times. Throws the last error when retries are exhausted. */
export async function withBackoff<T>(fn: () => Promise<T>, o: BackoffOptions): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= o.maxRetries || !isTransient(err) || o.signal?.aborted) throw err;
      const delay = backoffDelay(attempt + 1, o.initialMs, o.maxMs, o.random);
      o.onRetry?.(attempt + 1, delay, err);
      await sleep(delay, o.signal);
    }
  }
}
