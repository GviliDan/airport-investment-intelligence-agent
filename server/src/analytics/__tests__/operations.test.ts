import { describe, expect, it } from 'vitest';
import { OnTimeAggregator, type Row } from '../../data/aggregate.js';
import { demandPressureProfile, peerPercentile } from '../demandPressure.js';
import { compareOperations, departuresPerRunwayPerDay, runwayInfo, summarizeOperations } from '../operations.js';
import { screen, toScreenRow, type ScreenRow } from '../screen.js';
import { airport, metricsFor, trafficRows } from './fixtures.js';

const flight = (o: Partial<Row>): Row => ({
  YEAR: '2026', MONTH: '8', ORIGIN: 'LAX', DEST: 'SNA', OP_UNIQUE_CARRIER: 'AA', CANCELLED: '0', DIVERTED: '0', DEP_DEL15: '0', DEP_DELAY_NEW: '0', TAXI_OUT: '15', ARR_DEL15: '0', ARR_DELAY_NEW: '0', TAXI_IN: '5', ...o,
});
function records(origin: string, month: string, flights: Array<Partial<Row>>) {
  const a = new OnTimeAggregator(month);
  for (const f of flights) a.add(flight({ ORIGIN: origin, DEST: 'ZZZ', MONTH: String(Number(month.slice(5))), ...f }));
  return a.records().filter((r) => r.airport === origin);
}
const cov = (ratio: number | undefined) => ({ ratio, onTimeFlights: 100, t100ScheduledDepartures: 200 });
const MONTHS = ['2026-08'];

describe('summarizeOperations', () => {
  const recs = records('LAX', '2026-08', [{ DEP_DEL15: '1', DEP_DELAY_NEW: '30' }, {}, {}, { CANCELLED: '1', CANCELLATION_CODE: 'B', DEP_DEL15: '', TAXI_OUT: '' }]);
  it('derives rates from counts and records the cancellation cause', () => {
    const s = summarizeOperations('LAX', recs, MONTHS, cov(0.9));
    expect(s.scheduledDepartures).toBe(4);
    expect(s.derived?.departureDelayRate15).toBeCloseTo(1 / 3, 10);
    expect(s.derived?.cancellationRate).toBe(0.25);
    expect(s.cancellationCauseShare).toEqual({ B: 1 });
    expect(s.reliable).toBe(true);
  });
  it('marks the figures unreliable when on-time coverage is below the threshold, and says so', () => {
    const s = summarizeOperations('LAX', recs, MONTHS, cov(0.3));
    expect(s.reliable).toBe(false);
    expect(s.available).toBe(true);
    expect(s.notes.join(' ')).toMatch(/covers only 30%/);
  });
  it('cannot judge coverage when T-100 shows no scheduled service', () => {
    const s = summarizeOperations('LAX', recs, MONTHS, cov(undefined));
    expect(s.reliable).toBe(false);
    expect(s.notes.join(' ')).toMatch(/cannot be judged/);
  });
  it('reports no data, not zeros, for an airport without on-time records', () => {
    const s = summarizeOperations('QQQ', recs, MONTHS, cov(0.9));
    expect(s).toMatchObject({ available: false, reliable: false, scheduledDepartures: 0, derived: undefined });
    expect(s.notes[0]).toMatch(/No on-time data/);
  });
  it('lists requested months with no data', () => {
    expect(summarizeOperations('LAX', recs, ['2026-07', '2026-08'], cov(0.9)).monthsMissing).toEqual(['2026-07']);
  });
  it('never describes delay data as terminal capacity', () => {
    expect(summarizeOperations('LAX', recs, MONTHS, cov(0.9)).notes.join(' ')).toMatch(/not a measure of terminal capacity/);
  });
  it('combines months from counts: the rate is not the mean of monthly rates', () => {
    const both = [...records('LAX', '2026-07', [{ DEP_DEL15: '1', DEP_DELAY_NEW: '20' }]), ...records('LAX', '2026-08', [{ DEP_DEL15: '1', DEP_DELAY_NEW: '20' }, ...Array.from({ length: 8 }, () => ({}))])];
    const s = summarizeOperations('LAX', both, ['2026-07', '2026-08'], cov(0.9));
    expect(s.derived?.departureDelayRate15).toBeCloseTo(0.2, 10);
  });
});

describe('compareOperations', () => {
  const mk = (origin: string, late: number, total: number, taxi: number) =>
    records(origin, '2026-08', [...Array.from({ length: late }, () => ({ DEP_DEL15: '1', DEP_DELAY_NEW: '25', TAXI_OUT: String(taxi) })), ...Array.from({ length: total - late }, () => ({ TAXI_OUT: String(taxi) }))]);
  it('calls a clear gap, and withholds a verdict for a trivial one', () => {
    const a = mk('AAA', 400, 1000, 20);
    const b = mk('BBB', 200, 1000, 12);
    const c = mk('CCC', 205, 1000, 12);
    const sa = summarizeOperations('AAA', a, MONTHS, cov(0.9));
    const sb = summarizeOperations('BBB', b, MONTHS, cov(0.9));
    const sc = summarizeOperations('CCC', c, MONTHS, cov(0.9));
    const big = compareOperations(sa, sb, a, b);
    expect(big.departureDelayRate15?.verdict).toBe('a-higher');
    expect(big.medianTaxiOutDifferenceMin).toBe(8);
    expect(compareOperations(sb, sc, b, c).departureDelayRate15?.verdict).toBe('indistinguishable');
  });
  it('warns when either side has weak coverage', () => {
    const a = mk('AAA', 400, 1000, 20);
    const b = mk('BBB', 200, 1000, 12);
    const cmp = compareOperations(summarizeOperations('AAA', a, MONTHS, cov(0.2)), summarizeOperations('BBB', b, MONTHS, cov(0.9)), a, b);
    expect(cmp.notes.join(' ')).toMatch(/not .* conclusive|do not treat/i);
  });
});

describe('runway helpers', () => {
  it('counts only commercial-length runways and requires an FAA match', () => {
    const a = airport('RWY', { runways: [{ id: 'a', lengthFt: 9000 }, { id: 'b', lengthFt: 4999 }, { id: 'c' }] });
    expect(runwayInfo(a)).toEqual({ runways: 3, commercialRunways: 1, longestFt: 9000 });
    expect(runwayInfo(airport('NOF', { faaMatched: false }))).toBeUndefined();
    expect(runwayInfo(undefined)).toBeUndefined();
  });
  it('computes departures per runway per day and refuses to divide by zero or missing data', () => {
    expect(departuresPerRunwayPerDay(73_000, 365, { runways: 2, commercialRunways: 2, longestFt: 9000 })).toBeCloseTo(100, 10);
    expect(departuresPerRunwayPerDay(73_000, 365, { runways: 1, commercialRunways: 0, longestFt: 3000 })).toBeUndefined();
    expect(departuresPerRunwayPerDay(undefined, 365, { runways: 1, commercialRunways: 1, longestFt: 9000 })).toBeUndefined();
    expect(departuresPerRunwayPerDay(1, 365, undefined)).toBeUndefined();
  });
});

describe('screen', () => {
  const rows: ScreenRow[] = [
    toScreenRow(metricsFor({ code: 'AAA', latest: 5_000_000, prior: 4_000_000, taxi: 20 })),
    toScreenRow(metricsFor({ code: 'BBB', latest: 2_000_000, prior: 2_000_000, taxi: 10 })),
    toScreenRow(metricsFor({ code: 'CCC', latest: 8_000_000, prior: 7_000_000, taxi: 'none' })),
  ];
  it('filters by range and sorts descending by default', () => {
    const r = screen(rows, { filters: [{ metric: 'passengers12m', min: 3_000_000 }], sortBy: 'passengerGrowthPct' });
    expect(r.rows.map((x) => x.code)).toEqual(['AAA', 'CCC']);
    expect(r.matched).toBe(2);
  });
  it('reports airports lacking a filtered metric instead of treating them as zero', () => {
    const r = screen(rows, { filters: [{ metric: 'medianTaxiOutMin', max: 15 }] });
    expect(r.rows.map((x) => x.code)).toEqual(['BBB']);
    expect(r.missingMetric).toEqual([{ code: 'CCC', metric: 'medianTaxiOutMin' }]);
  });
  it('sorts ascending, applies limits and rejects unknown metrics', () => {
    expect(screen(rows, { sortBy: 'passengers12m', descending: false, limit: 1 }).rows[0]?.code).toBe('BBB');
    expect(() => screen(rows, { sortBy: 'nonsense' as never })).toThrow(/unknown sort metric/);
    expect(() => screen(rows, { filters: [{ metric: 'nonsense' as never }] })).toThrow(/unknown metric/);
  });
  it('is deterministic when values tie', () => {
    const tied = rows.map((r) => ({ ...r, passengers12m: 1 }));
    expect(screen(tied, { sortBy: 'passengers12m' }).rows.map((r) => r.code)).toEqual(['AAA', 'BBB', 'CCC']);
  });
  it('blanks operational figures for airports whose on-time coverage is weak', () => {
    const m = metricsFor({ code: 'WWW', latest: 1_000_000, prior: 900_000, taxi: 15 });
    const weak = { ...m, operations: { ...m.operations, reliable: false } };
    expect(toScreenRow(weak).medianTaxiOutMin).toBeUndefined();
    expect(toScreenRow(m).medianTaxiOutMin).toBe(15);
  });
});

describe('demand pressure', () => {
  it('positions a value among peers, needs enough peers, and counts ties as half', () => {
    expect(peerPercentile(5, [1, 2, 3, 4, 6, 7, 8, 9])).toBe(50);
    expect(peerPercentile(5, [5, 5, 5, 5, 5])).toBe(50);
    expect(peerPercentile(5, [1, 2, 3])).toBeUndefined();
    expect(peerPercentile(undefined, [1, 2, 3, 4, 5])).toBeUndefined();
  });
  it('never reports a measured unmet demand and lists what the indicators do not show', () => {
    const target = metricsFor({ code: 'TGT', latest: 20_000_000, prior: 19_000_000, taxi: 25 });
    const peers = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'].map((c, i) => metricsFor({ code: c, latest: 6_000_000 + i * 1_000_000, prior: 5_800_000, taxi: 10 + i }));
    const rows = trafficRows('TGT', { latestPassengers: 20_000_000, priorPassengers: 19_000_000 });
    const p = demandPressureProfile(target, peers, rows, 'test peers');
    expect(p.measuredUnmetDemand).toBeNull();
    expect(p.limitations.join(' ')).toMatch(/Unmet demand cannot be measured/);
    expect(p.indicators.find((i) => i.id === 'medianTaxiOut')).toMatchObject({ value: 25, peerPercentile: 100, standsOut: true });
    expect(p.standouts).toContain('medianTaxiOut');
    for (const i of p.indicators) expect(i.doesNotShow.length).toBeGreaterThan(0);
    expect(p.monthlyLoadFactor).toHaveLength(12);
    expect(p.peerGroup.size).toBe(6);
  });
  it('leaves an indicator without a percentile when too few peers have it', () => {
    const target = metricsFor({ code: 'TGT', latest: 20_000_000, prior: 19_000_000, taxi: 25 });
    const p = demandPressureProfile(target, [metricsFor({ code: 'P1', latest: 6_000_000, prior: 5_000_000 })], [], 'tiny');
    expect(p.indicators.every((i) => i.peerPercentile === undefined)).toBe(true);
    expect(p.standouts).toEqual([]);
  });
});
