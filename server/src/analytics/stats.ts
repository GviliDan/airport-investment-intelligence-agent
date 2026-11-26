/** Small, dependency-free statistics helpers. All are deterministic and treat `undefined` as missing, never as 0. */

export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * Percentile position, 0..100, of each defined value among the defined values. Ties share the mean of their ranks, so equal
 * inputs always get equal scores. With one defined value the position is 50 (no information). Undefined stays undefined.
 */
export function percentileRanks(values: ReadonlyArray<number | undefined>): Array<number | undefined> {
  const defined = values.flatMap((v, i) => (v === undefined || !Number.isFinite(v) ? [] : [{ v, i }]));
  const out: Array<number | undefined> = values.map(() => undefined);
  const n = defined.length;
  if (n === 0) return out;
  if (n === 1) {
    out[(defined[0] as { i: number }).i] = 50;
    return out;
  }
  const sorted = [...defined].sort((a, b) => a.v - b.v || a.i - b.i);
  let start = 0;
  while (start < n) {
    let end = start;
    while (end + 1 < n && (sorted[end + 1] as { v: number }).v === (sorted[start] as { v: number }).v) end += 1;
    const meanRank = (start + end) / 2; // 0-based
    for (let k = start; k <= end; k += 1) out[(sorted[k] as { i: number }).i] = (meanRank / (n - 1)) * 100;
    start = end + 1;
  }
  return out;
}

/** Pearson correlation over pairs where both values are defined; undefined with fewer than 3 pairs or no variance. */
export function pearson(xs: ReadonlyArray<number | undefined>, ys: ReadonlyArray<number | undefined>): number | undefined {
  const pairs: Array<[number, number]> = [];
  xs.forEach((x, i) => {
    const y = ys[i];
    if (x !== undefined && y !== undefined) pairs.push([x, y]);
  });
  if (pairs.length < 3) return undefined;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / pairs.length;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / pairs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? undefined : sxy / Math.sqrt(sxx * syy);
}

/**
 * Pulls a growth rate toward a prior in proportion to how small its base is: (n*g + k*prior) / (n + k).
 * A tiny airport's +80% moves most of the way to the prior; a large airport's growth is essentially unchanged.
 */
export function shrink(growth: number, base: number, pseudoCount: number, prior: number): number {
  return (base * growth + pseudoCount * prior) / (base + pseudoCount);
}

export interface RateComparison {
  readonly rateA: number;
  readonly rateB: number;
  /** rateA - rateB, as a fraction (0.02 = 2 percentage points). */
  readonly difference: number;
  /** Approximate 95% interval for the difference from independent binomial sampling. */
  readonly ci95: readonly [number, number];
  /** 'a-higher' / 'b-higher' only when the interval excludes 0 AND the gap is at least `minPractical`. */
  readonly verdict: 'a-higher' | 'b-higher' | 'indistinguishable';
}

/**
 * Compares two proportions from counts. Flights on the same day are not independent (weather, ATC programs), so the
 * interval is narrower than the truth; the verdict is therefore also gated on a minimum practical difference.
 */
export function compareRates(successesA: number, totalA: number, successesB: number, totalB: number, minPractical = 0.01): RateComparison | undefined {
  if (totalA <= 0 || totalB <= 0) return undefined;
  const pa = successesA / totalA;
  const pb = successesB / totalB;
  const se = Math.sqrt((pa * (1 - pa)) / totalA + (pb * (1 - pb)) / totalB);
  const diff = pa - pb;
  const ci: readonly [number, number] = [diff - 1.96 * se, diff + 1.96 * se];
  const significant = ci[0] > 0 || ci[1] < 0;
  const verdict = significant && Math.abs(diff) >= minPractical ? (diff > 0 ? 'a-higher' : 'b-higher') : 'indistinguishable';
  return { rateA: pa, rateB: pb, difference: diff, ci95: ci, verdict };
}

export const safeDiv = (num: number | undefined, den: number | undefined): number | undefined =>
  num === undefined || den === undefined || den === 0 ? undefined : num / den;
