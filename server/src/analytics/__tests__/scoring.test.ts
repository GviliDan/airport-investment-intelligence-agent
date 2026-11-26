import { describe, expect, it } from 'vitest';
import { METRIC_DEFINITIONS, rankOpportunities, resolveWeights, type MetricId } from '../scoring.js';
import { metricsFor, type Spec } from './fixtures.js';

/** Ten airports that differ on every metric, so no two rank the same way on all of them. */
const SET: Spec[] = [
  { code: 'AAA', latest: 30_000_000, prior: 29_000_000, deps: 300_000, runways: 4, taxi: 20 },
  { code: 'BBB', latest: 20_000_000, prior: 19_000_000, deps: 150_000, runways: 3, taxi: 15 },
  { code: 'CCC', latest: 10_000_000, prior: 8_000_000, deps: 80_000, runways: 2, taxi: 12 },
  { code: 'DDD', latest: 6_000_000, prior: 5_800_000, deps: 70_000, runways: 1, taxi: 18 },
  { code: 'EEE', latest: 4_000_000, prior: 3_000_000, deps: 40_000, runways: 2, taxi: 10 },
  { code: 'FFF', latest: 3_000_000, prior: 3_100_000, deps: 30_000, runways: 1, taxi: 14 },
  { code: 'GGG', latest: 2_000_000, prior: 1_500_000, deps: 25_000, runways: 2, taxi: 9 },
  { code: 'HHH', latest: 1_500_000, prior: 1_600_000, deps: 30_000, runways: 1, taxi: 16 },
  { code: 'III', latest: 1_000_000, prior: 700_000, deps: 12_000, runways: 1, taxi: 11 },
  { code: 'JJJ', latest: 800_000, prior: 790_000, deps: 9_000, runways: 1, taxi: 8 },
].map((s, i) => ({ ...s, latestSeats: s.latest * (1.2 + (i % 4) * 0.03), priorSeats: s.prior * (1.2 + ((i + 1) % 3) * 0.04) }));
const metrics = (specs: Spec[] = SET) => specs.map(metricsFor);
const ONLY = (id: MetricId): Partial<Record<MetricId, number>> => Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, d.id === id ? 1 : 0]));

describe('resolveWeights', () => {
  it('uses documented defaults that sum to 100', () => {
    const w = resolveWeights();
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    expect(w.departureDelay).toBe(0);
  });
  it('applies overrides and rejects invalid ones', () => {
    expect(resolveWeights({ scale: 50 }).scale).toBe(50);
    expect(() => resolveWeights({ scale: -1 })).toThrow(RangeError);
    expect(() => resolveWeights({ scale: Number.NaN })).toThrow(RangeError);
    expect(() => resolveWeights({ nonsense: 1 } as never)).toThrow(/unknown metric/);
    expect(() => resolveWeights(Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, 0])))).toThrow(/at least one/);
  });
});

describe('rankOpportunities: scoring arithmetic', () => {
  it('with one metric, the score is exactly the percentile position of that metric', () => {
    const r = rankOpportunities(metrics(), { weights: ONLY('scale'), correlationAdjustment: false });
    const byCode = new Map(r.ranked.map((x) => [x.code, x]));
    expect(byCode.get('AAA')?.score).toBe(100);
    expect(byCode.get('JJJ')?.score).toBe(0);
    expect(byCode.get('EEE')?.score).toBeCloseTo((5 / 9) * 100, 8); // 6th largest of 10: position 5 of 9 from the bottom
    expect(r.ranked.map((x) => x.code)).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH', 'III', 'JJJ']);
  });
  it('contributions add up to the score and effective weights add up to 100', () => {
    const r = rankOpportunities(metrics());
    for (const a of r.ranked) {
      expect(a.contributions.reduce((s, c) => s + c.points, 0)).toBeCloseTo(a.score, 8);
      expect(a.contributions.reduce((s, c) => s + c.effectiveWeight, 0)).toBeCloseTo(100, 8);
      expect(Object.values(a.pillarPoints).reduce((s, p) => s + p, 0)).toBeCloseTo(a.score, 8);
      for (const c of a.contributions) expect(c.points).toBeCloseTo((c.effectiveWeight * c.percentile) / 100, 8);
    }
  });
  it('scores stay within 0..100', () => {
    for (const a of rankOpportunities(metrics()).ranked) {
      expect(a.score).toBeGreaterThanOrEqual(0);
      expect(a.score).toBeLessThanOrEqual(100);
    }
  });
  it('changing weights changes the order in the expected direction', () => {
    const bySize = rankOpportunities(metrics(), { weights: ONLY('scale') }).ranked[0]?.code;
    const byGrowth = rankOpportunities(metrics(), { weights: ONLY('momentum') }).ranked[0]?.code;
    expect(bySize).toBe('AAA');
    expect(byGrowth).not.toBe('AAA');
    expect(['CCC', 'EEE', 'GGG', 'III']).toContain(byGrowth); // the fast growers
  });
  it('reports the weights it used, the definitions and the method', () => {
    const r = rankOpportunities(metrics(), { weights: { scale: 40 } });
    expect(r.weights.scale).toBe(40);
    expect(r.definitions.map((d) => d.id)).toContain('capacityGap');
    expect(r.method.join(' ')).toMatch(/relative to the candidate set/);
  });
});

describe('rankOpportunities: determinism, ties and extremes', () => {
  it('gives identical output whatever the input order', () => {
    const a = rankOpportunities(metrics());
    const b = rankOpportunities([...metrics()].reverse());
    const c = rankOpportunities([...metrics()].sort((x, y) => x.code.localeCompare(y.code) * -1));
    expect(JSON.stringify(b.ranked)).toBe(JSON.stringify(a.ranked));
    expect(JSON.stringify(c.ranked)).toBe(JSON.stringify(a.ranked));
  });
  it('breaks exact ties by passenger count, then by code', () => {
    const twins = [
      metricsFor({ code: 'ZZZ', latest: 2_000_000, prior: 1_900_000, taxi: 12 }),
      metricsFor({ code: 'YYY', latest: 2_000_000, prior: 1_900_000, taxi: 12 }),
      metricsFor({ code: 'XXX', latest: 2_500_000, prior: 1_900_000, taxi: 12 }),
      ...metrics().slice(0, 7),
    ];
    const r = rankOpportunities(twins, { weights: ONLY('loadFactor'), correlationAdjustment: false });
    const yz = r.ranked.filter((x) => x.code === 'YYY' || x.code === 'ZZZ');
    expect(yz[0]?.score).toBe(yz[1]?.score);
    expect(yz.map((x) => x.code)).toEqual(['YYY', 'ZZZ']);
    expect(new Set(r.ranked.map((x) => x.rank)).size).toBe(r.ranked.length);
  });
  it('is not dominated by an extreme outlier: only its own position changes', () => {
    const base = rankOpportunities(metrics(), { weights: ONLY('scale') }).ranked.map((x) => x.code);
    const withGiant = rankOpportunities([...metrics(), metricsFor({ code: 'GIA', latest: 9e11, prior: 8e11 })], { weights: ONLY('scale') }).ranked.map((x) => x.code);
    expect(withGiant[0]).toBe('GIA');
    expect(withGiant.slice(1)).toEqual(base);
  });
  it('ranks start at 1, are consecutive and match list order', () => {
    const r = rankOpportunities(metrics());
    expect(r.ranked.map((x) => x.rank)).toEqual(r.ranked.map((_, i) => i + 1));
  });
  it('topN limits the list but not the scoring', () => {
    const full = rankOpportunities(metrics());
    const top = rankOpportunities(metrics(), { topN: 3 });
    expect(top.ranked).toHaveLength(3);
    expect(top.ranked.map((x) => x.score)).toEqual(full.ranked.slice(0, 3).map((x) => x.score));
    expect(top.candidateSet.scored).toBe(10);
  });
  it('a single candidate is scored but flagged as having no comparison', () => {
    const r = rankOpportunities([metricsFor(SET[0] as Spec)]);
    expect(r.ranked[0]?.score).toBe(50);
    expect(r.warnings.join(' ')).toMatch(/Only 1 airports are eligible/);
  });
  it('handles an empty candidate set', () => {
    const r = rankOpportunities([]);
    expect(r.ranked).toEqual([]);
    expect(r.candidateSet.considered).toBe(0);
  });
});

describe('rankOpportunities: missing data and coverage', () => {
  it('re-scales weights for a missing metric instead of scoring it as 0, and reports the gap', () => {
    const set = [...metrics(), metricsFor({ code: 'NOF', latest: 5_000_000, prior: 4_800_000, runways: null, taxi: 12 })];
    const r = rankOpportunities(set, { correlationAdjustment: false, missingDataPolicy: 'redistribute' });
    const nof = r.ranked.find((x) => x.code === 'NOF')!;
    expect(nof.contributions.some((c) => c.metric === 'runwayLoad')).toBe(false);
    expect(nof.contributions.reduce((s, c) => s + c.effectiveWeight, 0)).toBeCloseTo(100, 8);
    expect(nof.coverage.weightCoverage).toBeCloseTo(0.85, 8);
    expect(nof.coverage.missing).toEqual([{ metric: 'runwayLoad', reason: 'no FAA match (runways unknown)' }]);
    expect(nof.coverage.faaMatched).toBe(false);
    expect(nof.flags.join(' ')).toMatch(/no FAA match/);
    expect(nof.contributions.find((c) => c.metric === 'scale')?.effectiveWeight).toBeCloseTo((20 / 85) * 100, 8);
  });
  it('by default fills a missing metric with the neutral 50th percentile, shows it as imputed, and brackets the score', () => {
    const set = [...metrics(), metricsFor({ code: 'NOF', latest: 5_000_000, prior: 4_800_000, runways: null, taxi: 12 })];
    const r = rankOpportunities(set, { correlationAdjustment: false });
    expect(r.missingDataPolicy).toBe('neutral');
    const nof = r.ranked.find((x) => x.code === 'NOF')!;
    const gap = nof.contributions.find((c) => c.metric === 'runwayLoad')!;
    expect(gap).toMatchObject({ imputed: true, raw: undefined, percentile: 50, effectiveWeight: 15 });
    expect(nof.contributions.reduce((s, c) => s + c.points, 0)).toBeCloseTo(nof.score, 8);
    expect(nof.scoreBounds.low).toBeCloseTo(nof.score - 0.15 * 50, 8);
    expect(nof.scoreBounds.high).toBeCloseTo(nof.score + 0.15 * 50, 8);
    const complete = r.ranked.find((x) => x.code === 'AAA')!;
    expect(complete.scoreBounds).toEqual({ low: complete.score, high: complete.score });
  });
  it('missing data cannot lift an airport above where its known metrics put it: redistribution can', () => {
    // 'TOP' is the best airport on everything it reports but cannot be scored on runways; 'FUL' is identical and complete but mediocre on runways.
    const base = metrics();
    const top = metricsFor({ code: 'TOP', latest: 31_000_000, prior: 25_000_000, runways: null, taxi: 7 });
    const redistribute = rankOpportunities([...base, top], { correlationAdjustment: false, missingDataPolicy: 'redistribute' }).ranked.find((x) => x.code === 'TOP')!;
    const neutral = rankOpportunities([...base, top], { correlationAdjustment: false, missingDataPolicy: 'neutral' }).ranked.find((x) => x.code === 'TOP')!;
    expect(redistribute.score).toBeGreaterThan(neutral.score);
    expect(neutral.scoreBounds.high).toBeGreaterThanOrEqual(neutral.score);
    expect(neutral.scoreBounds.low).toBeLessThanOrEqual(neutral.score);
  });
  it('includes the other missing-data policy among the sensitivity scenarios', () => {
    const set = [...metrics(), metricsFor({ code: 'TOP', latest: 31_000_000, prior: 25_000_000, runways: null, taxi: 7 })];
    const r = rankOpportunities(set, { correlationAdjustment: false });
    const top = r.ranked.find((x) => x.code === 'TOP')!;
    const alt = rankOpportunities(set, { correlationAdjustment: false, missingDataPolicy: 'redistribute' }).ranked.find((x) => x.code === 'TOP')!;
    expect(top.rankRange.best).toBeLessThanOrEqual(alt.rank);
    expect(top.rankRange.worst).toBeGreaterThanOrEqual(alt.rank);
  });
  it('does not silently drop airports without an FAA match: they are scored and listed', () => {
    const set = [...metrics(), metricsFor({ code: 'NOF', latest: 5_000_000, prior: 4_800_000, runways: null, taxi: 12 })];
    const r = rankOpportunities(set);
    expect(r.ranked.map((x) => x.code)).toContain('NOF');
    expect(r.candidateSet.considered).toBe(r.candidateSet.scored + r.candidateSet.unscored + r.candidateSet.excluded);
  });
  it('leaves an airport unscored, with the reason, when too little of the weight has data', () => {
    const set = [...metrics(), metricsFor({ code: 'BAD', latest: 3_000_000, prior: 2_900_000, runways: null, taxi: 'none' })];
    const r = rankOpportunities(set, { weights: { ...ONLY('runwayLoad'), taxiOut: 1 } });
    expect(r.ranked.map((x) => x.code)).not.toContain('BAD');
    const bad = r.unscored.find((u) => u.code === 'BAD');
    expect(bad?.reason).toMatch(/0% of the configured weight/);
    expect(bad?.weightCoverage).toBe(0);
  });
  it('excludes airports on missing on-time data from the taxi-out metric only', () => {
    const set = [...metrics(), metricsFor({ code: 'NOO', latest: 5_000_000, prior: 4_800_000, taxi: 'none' })];
    const noo = rankOpportunities(set).ranked.find((x) => x.code === 'NOO')!;
    expect(noo.coverage.missing.find((m) => m.metric === 'taxiOut')?.reason).toMatch(/no on-time data/);
    expect(noo.coverage.weightCoverage).toBeCloseTo(0.9, 8);
    expect(noo.flags.join(' ')).toMatch(/no on-time data/);
  });
  it('lists below-threshold airports as excluded, with the reason and the threshold', () => {
    const set = [...metrics(), metricsFor({ code: 'TNY', latest: 50_000, prior: 40_000 })];
    const r = rankOpportunities(set, { minPassengers: 100_000 });
    expect(r.ranked.map((x) => x.code)).not.toContain('TNY');
    expect(r.excluded).toEqual([{ code: 'TNY', name: 'TNY Airport', reason: expect.stringContaining('below the 100,000 threshold') }]);
  });
  it('treats an airport with a gap in its 12-month window as unscored when it is large, and excluded when it is small', () => {
    const big = metricsFor({ code: 'BIG', latest: 12_000_000, prior: 11_000_000 });
    const gap = { ...big, traffic: { ...big.traffic, current: { ...big.traffic.current, complete: false, passengers: undefined, missingMonths: ['2026-01'], monthsPresent: 11, passengersPresent: 11_000_000 }, issues: ['current window 2025-09..2026-08 is missing months: 2026-01'] } };
    const small = { ...gap, code: 'SMA', traffic: { ...gap.traffic, current: { ...gap.traffic.current, monthsPresent: 5, passengersPresent: 20_000 } } };
    const r = rankOpportunities([...metrics(), gap, small]);
    expect(r.unscored.map((u) => u.code)).toEqual(['BIG']);
    expect(r.excluded.find((e) => e.code === 'SMA')?.reason).toMatch(/only 5 of 12 months/);
  });
});

describe('rankOpportunities: small-airport distortion and correlated metrics', () => {
  it('shrinks the growth of a small airport toward the median, but not a large one', () => {
    const set = [...metrics(), metricsFor({ code: 'SML', latest: 300_000, prior: 150_000 })];
    const r = rankOpportunities(set, { weights: ONLY('momentum'), correlationAdjustment: false });
    const sml = r.ranked.find((x) => x.code === 'SML')!;
    expect(sml.evidence.passengerGrowthPct).toBe(100);
    expect(sml.contributions[0]?.raw).toBeLessThan(45); // 100% growth on 150k passengers is pulled far toward the median
    expect(sml.flags.join(' ')).toMatch(/small base/);
    const aaa = r.ranked.find((x) => x.code === 'AAA')!;
    expect(aaa.contributions[0]?.raw).toBeCloseTo((30 / 29 - 1) * 100, 0);
  });
  it('down-weights metrics that carry the same signal, and shows the factor', () => {
    // Make load factor an exact function of scale so the two are perfectly correlated.
    const set = SET.map((s) => ({ ...s, latestSeats: s.latest * 1.25, priorSeats: s.prior * 1.25 })).map((s, i) => ({ ...s, latest: s.latest, latestSeats: s.latest / (0.7 + i * 0.02) }));
    const r = rankOpportunities(metrics(set), { weights: { scale: 1, loadFactor: 1, momentum: 1 } });
    const adj = r.correlationAdjustments.find((a) => a.metric === 'scale');
    expect(adj).toBeDefined();
    expect(adj!.factor).toBeLessThan(1);
    expect(adj!.correlatedWith.length).toBeGreaterThan(0);
    const top = r.ranked[0]!;
    expect(top.contributions.find((c) => c.metric === 'scale')?.correlationFactor).toBeLessThan(1);
    expect(r.warnings.join(' ')).toMatch(/down-weighted/);
    const off = rankOpportunities(metrics(set), { weights: { scale: 1, loadFactor: 1, momentum: 1 }, correlationAdjustment: false });
    expect(off.correlationAdjustments).toEqual([]);
    expect(off.ranked[0]?.contributions.every((c) => c.correlationFactor === 1)).toBe(true);
  });
  it('does not adjust on correlations from very few airports', () => {
    expect(rankOpportunities(metrics().slice(0, 5)).correlationAdjustments).toEqual([]);
  });
});

describe('rankOpportunities: periods, explanations and reading guide', () => {
  it('states the exact periods behind each metric family', () => {
    const r = rankOpportunities(metrics());
    expect(r.periods.passengerWindow).toEqual({ from: '2025-09', to: '2026-08' });
    expect(r.periods.baselineWindow).toEqual({ from: '2024-09', to: '2025-08' });
    expect(r.periods.operationalMonths).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(r.periods.notes.join(' ')).toMatch(/not comparable/);
  });
  it('explains each correlation adjustment in words and never calls the score evidence of a terminal constraint', () => {
    const set = SET.map((s, i) => ({ ...s, latestSeats: s.latest / (0.7 + i * 0.02), priorSeats: s.prior * 1.25 }));
    const r = rankOpportunities(metrics(set), { weights: { scale: 1, loadFactor: 1, momentum: 1 } });
    expect(r.correlationAdjustments.length).toBeGreaterThan(0);
    expect(r.correlationAdjustments[0]?.explanation).toMatch(/of its configured weight because across these airports it moves with/);
    expect(r.readingGuide.join(' ')).toMatch(/not evidence that a terminal is capacity-constrained/);
    expect(r.readingGuide.join(' ')).toMatch(/not a forecast/);
  });
});

describe('rankOpportunities: sensitivity to weights', () => {
  it('reports each airport rank range across equal weights and drop-one scenarios', () => {
    const r = rankOpportunities(metrics());
    for (const a of r.ranked) {
      expect(a.rankRange.best).toBeLessThanOrEqual(a.rank);
      expect(a.rankRange.worst).toBeGreaterThanOrEqual(a.rank);
    }
    expect(r.diagnostics.rankStabilityVsEqualWeights).toBeGreaterThan(0.5);
  });
  it('has a single-metric ranking with no sensitivity beyond itself', () => {
    const r = rankOpportunities(metrics(), { weights: ONLY('scale') });
    expect(r.ranked.every((a) => a.rankRange.best === a.rank && a.rankRange.worst === a.rank)).toBe(true);
  });
});
