import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rateLimiter.js';

/** A fake clock whose sleep advances time instantly. */
function clock() {
  let t = 1_000_000;
  const slept: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; }, slept, advance: (ms: number) => { t += ms; } };
}

describe('RateLimiter', () => {
  it('lets calls through up to the limit without waiting', async () => {
    const c = clock();
    const l = new RateLimiter(3, 60_000, c.now, c.sleep);
    for (let i = 0; i < 3; i += 1) expect(await l.acquire()).toBe(0);
    expect(c.slept).toEqual([]);
  });

  it('waits until the oldest call leaves the window', async () => {
    const c = clock();
    const l = new RateLimiter(2, 60_000, c.now, c.sleep);
    await l.acquire();
    c.advance(10_000);
    await l.acquire();
    const waited = await l.acquire();
    expect(waited).toBe(50_000);
    expect(c.slept).toEqual([50_000]);
  });

  it('never exceeds the limit in any window, including bursts', async () => {
    const c = clock();
    const l = new RateLimiter(12, 60_000, c.now, c.sleep);
    const times: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      await l.acquire();
      times.push(c.now());
    }
    for (let i = 0; i + 12 < times.length; i += 1) expect((times[i + 12] as number) - (times[i] as number)).toBeGreaterThanOrEqual(60_000);
  });

  it('stops waiting when the request is aborted', async () => {
    const l = new RateLimiter(1, 60_000);
    await l.acquire();
    const ctrl = new AbortController();
    const pending = l.acquire(ctrl.signal);
    setTimeout(() => ctrl.abort(new Error('cancelled')), 20);
    await expect(pending).rejects.toThrow('cancelled');
  });

  it('rejects a nonsensical limit', () => {
    expect(() => new RateLimiter(0)).toThrow(RangeError);
  });
});
