import { describe, expect, it } from 'vitest';
import { compareRates, median, pearson, percentileRanks, safeDiv, shrink } from '../stats.js';

describe('percentileRanks', () => {
  it('maps distinct values onto 0..100 evenly', () => {
    expect(percentileRanks([10, 30, 20])).toEqual([0, 100, 50]);
  });
  it('gives tied values the mean of their ranks', () => {
    // sorted: 1, 2, 2, 3 -> positions 0, 1.5, 1.5, 3 of 3
    expect(percentileRanks([2, 1, 3, 2])).toEqual([50, 0, 100, 50]);
    expect(percentileRanks([5, 5, 5])).toEqual([50, 50, 50]);
  });
  it('keeps undefined as undefined and ranks only the defined values', () => {
    expect(percentileRanks([undefined, 1, 2, undefined])).toEqual([undefined, 0, 100, undefined]);
  });
  it('returns 50 for a single value (no information) and nothing for no values', () => {
    expect(percentileRanks([7])).toEqual([50]);
    expect(percentileRanks([undefined, undefined])).toEqual([undefined, undefined]);
    expect(percentileRanks([])).toEqual([]);
  });
  it('is not moved by extreme values: only order matters', () => {
    expect(percentileRanks([1, 2, 3, 1_000_000_000])).toEqual(percentileRanks([1, 2, 3, 4]));
  });
  it('ignores non-finite values', () => {
    expect(percentileRanks([1, Number.NaN, 2])).toEqual([0, undefined, 100]);
  });
});

describe('median / safeDiv / shrink', () => {
  it('computes medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeUndefined();
  });
  it('divides safely: zero or missing denominators give undefined, not Infinity or 0', () => {
    expect(safeDiv(1, 0)).toBeUndefined();
    expect(safeDiv(undefined, 5)).toBeUndefined();
    expect(safeDiv(0, 5)).toBe(0);
  });
  it('shrinks small bases toward the prior and leaves large bases alone', () => {
    expect(shrink(0.5, 250_000, 250_000, 0)).toBeCloseTo(0.25, 10);
    expect(shrink(0.5, 1_000, 250_000, 0.02)).toBeCloseTo(0.02 + (0.48 * 1_000) / 251_000, 6);
    expect(shrink(0.05, 50_000_000, 250_000, 0)).toBeCloseTo(0.05, 3);
  });
});

describe('pearson', () => {
  it('is 1 / -1 for perfectly related values and ignores incomplete pairs', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, undefined, 3, 4], [2, 5, 6, 8])).toBeCloseTo(1, 10);
  });
  it('is undefined with too few pairs or no variance', () => {
    expect(pearson([1, 2], [1, 2])).toBeUndefined();
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeUndefined();
  });
});

describe('compareRates', () => {
  it('reports a real difference when the interval excludes 0 and the gap is practical', () => {
    const r = compareRates(300, 1000, 200, 1000, 0.02)!;
    expect(r.difference).toBeCloseTo(0.1, 10);
    expect(r.verdict).toBe('a-higher');
    expect(compareRates(200, 1000, 300, 1000, 0.02)!.verdict).toBe('b-higher');
  });
  it('withholds a verdict for a gap inside sampling noise', () => {
    expect(compareRates(101, 1000, 100, 1000)!.verdict).toBe('indistinguishable');
  });
  it('withholds a verdict for a statistically detectable but trivial gap', () => {
    // 1.2 points on 100k flights each: significant, but below the 2 point practical floor.
    expect(compareRates(25_200, 100_000, 24_000, 100_000, 0.02)!.verdict).toBe('indistinguishable');
  });
  it('is undefined when either side has no observations', () => {
    expect(compareRates(0, 0, 1, 10)).toBeUndefined();
  });
});
