import { ProviderError } from './errors.js';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  readonly source: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
  readonly retries?: number;
  /** Base delay for exponential backoff; tests pass 0. */
  readonly backoffMs?: number;
  readonly headers?: Record<string, string>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** GET returning the response text. Retries timeouts, network errors, 429 and 5xx with exponential backoff. */
export async function getText(url: URL | string, opts: HttpOptions): Promise<string> {
  const { source, fetch: doFetch = fetch, timeoutMs = 20_000, retries = 2, backoffMs = 500, headers } = opts;
  let last: ProviderError | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs * 2 ** (attempt - 1));
    try {
      const res = await doFetch(url, { headers: { 'user-agent': 'airport-investment-agent/1.0', ...headers }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return await res.text();
      const kind = res.status === 429 ? 'rate-limited' : 'http';
      last = new ProviderError(source, kind, `HTTP ${res.status}`, res.status);
    } catch (err) {
      const name = (err as Error).name;
      last = new ProviderError(source, name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : 'network error');
    }
    if (!last.retryable) throw last;
  }
  throw last as ProviderError;
}

export async function getJson(url: URL | string, opts: HttpOptions): Promise<unknown> {
  const text = await getText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(opts.source, 'invalid-response', 'response was not valid JSON');
  }
}
