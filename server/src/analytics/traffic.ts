import type { MonthlyTraffic } from '../data/btsSocrata.js';
import { monthRange, shiftMonth, type Month } from '../data/types.js';
import { safeDiv } from './stats.js';

/** Totals over a run of consecutive months. A window with any missing month is incomplete and reports no totals. */
export interface WindowTotals {
  readonly from: Month;
  readonly to: Month;
  readonly missingMonths: readonly Month[];
  readonly complete: boolean;
  /** Months in the window that have a row, and the passengers they carry (a lower bound when the window is incomplete). */
  readonly monthsPresent: number;
  readonly passengersPresent: number;
  readonly passengers?: number;
  readonly seats?: number;
  readonly departures?: number;
  /** passengers / seats over the whole window, as a fraction (not an average of monthly percentages). */
  readonly loadFactor?: number;
}

export interface Change {
  readonly current?: number;
  readonly baseline?: number;
  readonly absolute?: number;
  /** Fraction (0.05 = +5%). Undefined when the baseline is 0 or either side is missing. */
  readonly pct?: number;
}

export const change = (current: number | undefined, baseline: number | undefined): Change => ({
  ...(current !== undefined ? { current } : {}),
  ...(baseline !== undefined ? { baseline } : {}),
  ...(current !== undefined && baseline !== undefined ? { absolute: current - baseline } : {}),
  ...(current !== undefined && baseline !== undefined && baseline > 0 ? { pct: current / baseline - 1 } : {}),
});

/** Sums a field across the window; undefined if any month in the window lacks that field. */
function sumField(rows: readonly MonthlyTraffic[], pick: (r: MonthlyTraffic) => number | undefined): number | undefined {
  let total = 0;
  for (const r of rows) {
    const v = pick(r);
    if (v === undefined) return undefined;
    total += v;
  }
  return total;
}

export function sumWindow(rows: readonly MonthlyTraffic[], from: Month, to: Month): WindowTotals {
  const expected = monthRange(from, to);
  const inWindow = rows.filter((r) => r.month >= from && r.month <= to);
  const present = new Set(inWindow.map((r) => r.month));
  const missingMonths = expected.filter((m) => !present.has(m));
  const passengersPresent = inWindow.reduce((sum, r) => sum + (r.passengers ?? 0), 0);
  if (missingMonths.length > 0 || inWindow.length !== expected.length) return { from, to, missingMonths, complete: false, monthsPresent: present.size, passengersPresent };
  const passengers = sumField(inWindow, (r) => r.passengers);
  const seats = sumField(inWindow, (r) => r.seats);
  const departures = sumField(inWindow, (r) => r.departures);
  const loadFactor = safeDiv(passengers, seats);
  return {
    from, to, missingMonths, complete: true, monthsPresent: present.size, passengersPresent,
    ...(passengers !== undefined ? { passengers } : {}),
    ...(seats !== undefined ? { seats } : {}),
    ...(departures !== undefined ? { departures } : {}),
    ...(loadFactor !== undefined ? { loadFactor } : {}),
  };
}

export type Baseline = 'year-over-year' | 'previous-period';

export interface TrafficAnalysis {
  readonly airport: string;
  readonly windowMonths: number;
  readonly baselineKind: Baseline;
  readonly current: WindowTotals;
  readonly baseline: WindowTotals;
  readonly passengers: Change;
  readonly seats: Change;
  readonly departures: Change;
  readonly loadFactor: { readonly current?: number; readonly baseline?: number; readonly changePoints?: number };
  /** Passenger growth minus seat growth, in percentage points. Positive: demand is outgrowing seat supply. */
  readonly passengerVsSeatGrowthPoints?: number;
  readonly seatsPerDeparture: { readonly current?: number; readonly baseline?: number };
  /** Plain-language reasons a figure is missing. Empty when everything needed was present. */
  readonly issues: readonly string[];
}

/**
 * Growth over a configurable window ending at `endMonth`, against the same months a year earlier (default, removes
 * seasonality) or the immediately preceding window of equal length.
 */
export function analyzeTraffic(
  airport: string,
  rows: readonly MonthlyTraffic[],
  opts: { endMonth: Month; windowMonths?: number; baseline?: Baseline },
): TrafficAnalysis {
  const windowMonths = opts.windowMonths ?? 12;
  const baselineKind = opts.baseline ?? 'year-over-year';
  if (!Number.isInteger(windowMonths) || windowMonths < 1 || windowMonths > 36) throw new RangeError('windowMonths must be an integer from 1 to 36');
  const shift = baselineKind === 'year-over-year' ? 12 : windowMonths;
  const mine = rows.filter((r) => r.airport === airport);
  const current = sumWindow(mine, shiftMonth(opts.endMonth, windowMonths - 1), opts.endMonth);
  const baseline = sumWindow(mine, shiftMonth(opts.endMonth, windowMonths - 1 + shift), shiftMonth(opts.endMonth, shift));
  const issues: string[] = [];
  if (!current.complete) issues.push(`current window ${current.from}..${current.to} is missing months: ${current.missingMonths.join(', ')}`);
  if (!baseline.complete) issues.push(`baseline window ${baseline.from}..${baseline.to} is missing months: ${baseline.missingMonths.join(', ')}`);
  const passengers = change(current.passengers, baseline.passengers);
  const seats = change(current.seats, baseline.seats);
  const gap = passengers.pct !== undefined && seats.pct !== undefined ? (passengers.pct - seats.pct) * 100 : undefined;
  const lfChange = current.loadFactor !== undefined && baseline.loadFactor !== undefined ? (current.loadFactor - baseline.loadFactor) * 100 : undefined;
  return {
    airport, windowMonths, baselineKind, current, baseline,
    passengers, seats, departures: change(current.departures, baseline.departures),
    loadFactor: { ...(current.loadFactor !== undefined ? { current: current.loadFactor } : {}), ...(baseline.loadFactor !== undefined ? { baseline: baseline.loadFactor } : {}), ...(lfChange !== undefined ? { changePoints: lfChange } : {}) },
    ...(gap !== undefined ? { passengerVsSeatGrowthPoints: gap } : {}),
    seatsPerDeparture: {
      ...(safeDiv(current.seats, current.departures) !== undefined ? { current: safeDiv(current.seats, current.departures) as number } : {}),
      ...(safeDiv(baseline.seats, baseline.departures) !== undefined ? { baseline: safeDiv(baseline.seats, baseline.departures) as number } : {}),
    },
    issues,
  };
}

export interface MonthPoint {
  readonly month: Month;
  readonly passengers?: number;
  readonly seats?: number;
  readonly departures?: number;
  readonly loadFactor?: number;
}

/** One entry per month in the range; a month without data is present with no values, never filled with 0. */
export function monthlySeries(rows: readonly MonthlyTraffic[], from: Month, to: Month): MonthPoint[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return monthRange(from, to).map((month) => {
    const r = byMonth.get(month);
    if (!r) return { month };
    const lf = safeDiv(r.passengers, r.seats);
    return {
      month,
      ...(r.passengers !== undefined ? { passengers: r.passengers } : {}),
      ...(r.seats !== undefined ? { seats: r.seats } : {}),
      ...(r.departures !== undefined ? { departures: r.departures } : {}),
      ...(lf !== undefined ? { loadFactor: lf } : {}),
    };
  });
}

export const latestMonth = (rows: readonly MonthlyTraffic[]): Month | undefined => rows.reduce<Month | undefined>((m, r) => (m === undefined || r.month > m ? r.month : m), undefined);
