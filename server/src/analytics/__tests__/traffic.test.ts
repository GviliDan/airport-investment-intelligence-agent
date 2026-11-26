import { describe, expect, it } from 'vitest';
import type { MonthlyTraffic } from '../../data/btsSocrata.js';
import { analyzeTraffic, change, latestMonth, monthlySeries, sumWindow } from '../traffic.js';

const row = (month: string, passengers?: number, seats?: number, departures?: number): MonthlyTraffic => ({
  airport: 'AAA', month, ...(passengers !== undefined ? { passengers } : {}), ...(seats !== undefined ? { seats } : {}), ...(departures !== undefined ? { departures } : {}),
});
/** 2024-09..2026-08: the first 12 months have 100/130/10, the last 12 have 110/132/11 (per month). */
const TWO_YEARS = [
  ...Array.from({ length: 12 }, (_, i) => row(`${i < 4 ? 2024 : 2025}-${String(((i + 8) % 12) + 1).padStart(2, '0')}`, 100, 130, 10)),
  ...Array.from({ length: 12 }, (_, i) => row(`${i < 4 ? 2025 : 2026}-${String(((i + 8) % 12) + 1).padStart(2, '0')}`, 110, 132, 11)),
];

describe('sumWindow', () => {
  it('sums a complete window and derives load factor from totals', () => {
    const w = sumWindow([row('2026-01', 80, 100), row('2026-02', 10, 100)], '2026-01', '2026-02');
    expect(w).toMatchObject({ complete: true, passengers: 90, seats: 200, loadFactor: 0.45 });
    // not the mean of 80% and 10%: that would be 45% only by coincidence; use a case where they differ
    const w2 = sumWindow([row('2026-01', 90, 100), row('2026-02', 10, 900)], '2026-01', '2026-02');
    expect(w2.loadFactor).toBeCloseTo(0.1, 10);
  });
  it('reports missing months instead of treating them as zero', () => {
    const w = sumWindow([row('2026-01', 5, 10), row('2026-03', 5, 10)], '2026-01', '2026-03');
    expect(w.complete).toBe(false);
    expect(w.missingMonths).toEqual(['2026-02']);
    expect(w.passengers).toBeUndefined();
    expect(w.passengersPresent).toBe(10);
    expect(w.monthsPresent).toBe(2);
  });
  it('leaves a total undefined when any month lacks that field', () => {
    const w = sumWindow([row('2026-01', 5, 10), row('2026-02', 5)], '2026-01', '2026-02');
    expect(w).toMatchObject({ complete: true, passengers: 10 });
    expect(w.seats).toBeUndefined();
    expect(w.loadFactor).toBeUndefined();
  });
  it('treats a real zero as zero', () => {
    expect(sumWindow([row('2026-01', 0, 0)], '2026-01', '2026-01')).toMatchObject({ passengers: 0, seats: 0 });
  });
});

describe('change', () => {
  it('computes absolute and percentage change, and refuses a percentage from a zero baseline', () => {
    expect(change(110, 100)).toEqual({ current: 110, baseline: 100, absolute: 10, pct: expect.closeTo(0.1, 10) });
    expect(change(5, 0)).toEqual({ current: 5, baseline: 0, absolute: 5 });
    expect(change(undefined, 100)).toEqual({ baseline: 100 });
  });
});

describe('analyzeTraffic', () => {
  it('year-over-year over 12 months: known growth, seat growth, gap and load factor', () => {
    const t = analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08' });
    expect(t.current).toMatchObject({ from: '2025-09', to: '2026-08', passengers: 1320, seats: 1584, departures: 132 });
    expect(t.baseline).toMatchObject({ from: '2024-09', to: '2025-08', passengers: 1200, seats: 1560 });
    expect(t.passengers.pct).toBeCloseTo(0.1, 10);
    expect(t.seats.pct).toBeCloseTo(1584 / 1560 - 1, 10);
    expect(t.passengerVsSeatGrowthPoints).toBeCloseTo((0.1 - (1584 / 1560 - 1)) * 100, 8);
    expect(t.loadFactor.current).toBeCloseTo(1320 / 1584, 10);
    expect(t.loadFactor.changePoints).toBeCloseTo((1320 / 1584 - 1200 / 1560) * 100, 8);
    expect(t.seatsPerDeparture.current).toBe(12);
    expect(t.issues).toEqual([]);
  });
  it('supports shorter windows against the same months a year earlier', () => {
    const t = analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08', windowMonths: 3 });
    expect(t.current).toMatchObject({ from: '2026-06', to: '2026-08', passengers: 330 });
    expect(t.baseline).toMatchObject({ from: '2025-06', to: '2025-08', passengers: 300 });
    expect(t.passengers.pct).toBeCloseTo(0.1, 10);
  });
  it('supports comparison with the immediately preceding window', () => {
    const t = analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08', windowMonths: 3, baseline: 'previous-period' });
    expect(t.baseline).toMatchObject({ from: '2026-03', to: '2026-05', passengers: 330 });
    expect(t.passengers.pct).toBeCloseTo(0, 10);
  });
  it('multi-month windows change with the configured window length', () => {
    const six = analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08', windowMonths: 6 });
    expect(six.current.passengers).toBe(660);
    expect(six.baseline.passengers).toBe(600);
  });
  it('reports incomplete windows as issues and withholds growth', () => {
    const t = analyzeTraffic('AAA', TWO_YEARS.filter((r) => r.month !== '2025-11'), { endMonth: '2026-08' });
    expect(t.current.complete).toBe(false);
    expect(t.passengers.pct).toBeUndefined();
    expect(t.issues[0]).toContain('2025-11');
  });
  it('does not mix airports', () => {
    const other = TWO_YEARS.map((r) => ({ ...r, airport: 'BBB', passengers: 1 }));
    expect(analyzeTraffic('AAA', [...TWO_YEARS, ...other], { endMonth: '2026-08' }).current.passengers).toBe(1320);
  });
  it('rejects an invalid window', () => {
    expect(() => analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08', windowMonths: 0 })).toThrow(RangeError);
    expect(() => analyzeTraffic('AAA', TWO_YEARS, { endMonth: '2026-08', windowMonths: 40 })).toThrow(RangeError);
  });
  it('a zero-passenger baseline gives no percentage growth', () => {
    const rows = [row('2025-08', 0, 0, 0), row('2026-08', 10, 20, 1)];
    const t = analyzeTraffic('AAA', rows, { endMonth: '2026-08', windowMonths: 1 });
    expect(t.passengers).toMatchObject({ current: 10, baseline: 0, absolute: 10 });
    expect(t.passengers.pct).toBeUndefined();
  });
});

describe('monthlySeries / latestMonth', () => {
  it('lists every month, leaving gaps without values', () => {
    const s = monthlySeries([row('2026-01', 50, 100), row('2026-03', 30, 100)], '2026-01', '2026-03');
    expect(s.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(s[1]).toEqual({ month: '2026-02' });
    expect(s[0]?.loadFactor).toBe(0.5);
  });
  it('finds the latest month', () => {
    expect(latestMonth(TWO_YEARS)).toBe('2026-08');
    expect(latestMonth([])).toBeUndefined();
  });
});
