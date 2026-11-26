export type ProviderErrorKind = 'timeout' | 'network' | 'rate-limited' | 'http' | 'invalid-response' | 'invalid-request';

/** A failure of an external data source. Never carries URLs with secrets; callers show `message` to users. */
export class ProviderError extends Error {
  constructor(
    readonly source: string,
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(`${source}: ${message}`);
    this.name = 'ProviderError';
  }
  /** Worth retrying: transient failures only. */
  get retryable(): boolean {
    return this.kind === 'timeout' || this.kind === 'network' || this.kind === 'rate-limited' || (this.kind === 'http' && (this.status ?? 0) >= 500);
  }
}
