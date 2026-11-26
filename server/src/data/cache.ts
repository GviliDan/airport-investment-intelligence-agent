/** In-memory TTL cache that also shares one in-flight request between concurrent callers. Failures are not cached. */
export class TtlCache<T> {
  private readonly entries = new Map<string, { value: Promise<T>; expires: number }>();
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = load();
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    return value;
  }
}
