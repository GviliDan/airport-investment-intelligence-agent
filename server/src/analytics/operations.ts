import { deriveOnTime, sumOnTime, type DerivedOnTime, type OnTimeAirportMonth } from '../data/aggregate.js';
import type { AirportRecord } from '../data/airportBuild.js';
import type { Month } from '../data/types.js';
import { compareRates, safeDiv, type RateComparison } from './stats.js';

/** A runway counts toward commercial-service capacity only if it is at least this long (assumption; shorter ones serve small aircraft). */
export const MIN_COMMERCIAL_RUNWAY_FT = 5000;
/** Below this share of scheduled passenger departures, on-time statistics are treated as unreliable for the airport. */
export const MIN_ONTIME_COVERAGE = 0.5;

/**
 * Smallest gap in rates treated as a real difference. Flights on a given day share weather and air-traffic conditions, so a
 * binomial interval is too narrow; these floors (2 points for delays, 0.5 for cancellations) are an assumption that stops
 * trivial gaps from being reported as differences.
 */
export const MIN_PRACTICAL_DELAY_DIFF = 0.02;
export const MIN_PRACTICAL_CANCEL_DIFF = 0.005;

export interface OnTimeCoverage {
  readonly ratio: number | undefined;
  readonly onTimeFlights: number;
  readonly t100ScheduledDepartures: number;
}

export interface OperationalSummary {
  readonly airport: string;
  readonly months: readonly Month[];
  readonly monthsMissing: readonly Month[];
  /** False when there is no on-time data at all for the airport and months. */
  readonly available: boolean;
  /** False when coverage is below the threshold; the figures are then shown but must not be used for ranking. */
  readonly reliable: boolean;
  readonly coverage: OnTimeCoverage;
  readonly scheduledDepartures: number;
  readonly derived: DerivedOnTime | undefined;
  /** Share of cancellations by BTS cause code (A carrier, B weather, C national air system, D security). */
  readonly cancellationCauseShare: Readonly<Record<string, number>> | undefined;
  readonly notes: readonly string[];
}

export const CANCELLATION_CODES: Readonly<Record<string, string>> = { A: 'carrier', B: 'weather', C: 'national air system', D: 'security' };

export function summarizeOperations(
  airport: string,
  records: readonly OnTimeAirportMonth[],
  months: readonly Month[],
  coverage: OnTimeCoverage,
  minCoverage: number = MIN_ONTIME_COVERAGE,
): OperationalSummary {
  const wanted = new Set(months);
  const mine = records.filter((r) => r.airport === airport && wanted.has(r.month));
  const have = new Set(mine.map((r) => r.month));
  const monthsMissing = months.filter((m) => !have.has(m));
  const notes: string[] = [
    'Covers flights of BTS reporting carriers only; smaller carriers, cargo operators and non-reporting regional partners are absent.',
    'Delays and taxi times describe airfield and airline operations. They are not a measure of terminal capacity.',
  ];
  if (mine.length === 0) {
    return { airport, months, monthsMissing, available: false, reliable: false, coverage, scheduledDepartures: 0, derived: undefined, cancellationCauseShare: undefined, notes: [`No on-time data for ${airport} in ${months.join(', ')}.`, ...notes] };
  }
  const totals = sumOnTime(mine);
  const cancelledByCode = totals.dep.cancelledByCode;
  const cancelTotal = Object.values(cancelledByCode).reduce((a, b) => a + b, 0);
  const reliable = coverage.ratio !== undefined && coverage.ratio >= minCoverage;
  if (coverage.ratio === undefined) notes.push('T-100 shows no scheduled passenger departures to compare against, so coverage of the on-time data cannot be judged.');
  else if (!reliable) notes.push(`On-time data covers only ${(coverage.ratio * 100).toFixed(0)}% of scheduled passenger departures (threshold ${(minCoverage * 100).toFixed(0)}%); treat these figures as indicative.`);
  else notes.push(`On-time data covers about ${(coverage.ratio * 100).toFixed(0)}% of scheduled passenger departures.`);
  if (monthsMissing.length > 0) notes.push(`Missing months: ${monthsMissing.join(', ')}.`);
  return {
    airport, months, monthsMissing, available: true, reliable, coverage,
    scheduledDepartures: totals.dep.scheduled,
    derived: deriveOnTime(totals),
    cancellationCauseShare: cancelTotal > 0 ? Object.fromEntries(Object.entries(cancelledByCode).map(([k, v]) => [k, v / cancelTotal])) : undefined,
    notes,
  };
}

export interface RunwayInfo {
  readonly runways: number;
  readonly commercialRunways: number;
  readonly longestFt: number | undefined;
}

export function runwayInfo(airport: AirportRecord | undefined): RunwayInfo | undefined {
  if (!airport || !airport.faaMatched) return undefined;
  const lengths = airport.runways.map((r) => r.lengthFt).filter((l): l is number => l !== undefined);
  return { runways: airport.runways.length, commercialRunways: lengths.filter((l) => l >= MIN_COMMERCIAL_RUNWAY_FT).length, longestFt: lengths.length ? Math.max(...lengths) : undefined };
}

/** Average daily departures per commercial runway. A runway-utilisation proxy only; says nothing about terminals. */
export function departuresPerRunwayPerDay(departures: number | undefined, days: number, info: RunwayInfo | undefined): number | undefined {
  if (departures === undefined || !info || info.commercialRunways === 0) return undefined;
  return safeDiv(departures, days * info.commercialRunways);
}

export interface OperationalComparison {
  readonly a: string;
  readonly b: string;
  readonly months: readonly Month[];
  readonly departureDelayRate15: RateComparison | undefined;
  readonly cancellationRate: RateComparison | undefined;
  /** a minus b, minutes. Undefined if either is unavailable. */
  readonly medianTaxiOutDifferenceMin: number | undefined;
  readonly meanDepartureDelayDifferenceMin: number | undefined;
  readonly notes: readonly string[];
}

/** Side-by-side operational comparison. Rate verdicts come from counts, and are withheld when the gap is within sampling noise. */
export function compareOperations(a: OperationalSummary, b: OperationalSummary, recordsA: readonly OnTimeAirportMonth[], recordsB: readonly OnTimeAirportMonth[]): OperationalComparison {
  const months = a.months.filter((m) => b.months.includes(m));
  const pick = (recs: readonly OnTimeAirportMonth[], code: string) => sumOnTime(recs.filter((r) => r.airport === code && months.includes(r.month)));
  const ta = pick(recordsA, a.airport);
  const tb = pick(recordsB, b.airport);
  const notes = [...new Set([...a.notes, ...b.notes])];
  notes.push(`A difference is reported only if the sampling interval excludes zero and the gap is at least ${MIN_PRACTICAL_DELAY_DIFF * 100} points (delays) or ${MIN_PRACTICAL_CANCEL_DIFF * 100} points (cancellations). The interval treats flights as independent, so it understates real uncertainty.`);
  if (!a.reliable || !b.reliable) notes.push('At least one airport has weak on-time coverage; do not treat differences as conclusive.');
  const diff = (x: number | undefined, y: number | undefined): number | undefined => (x === undefined || y === undefined ? undefined : x - y);
  return {
    a: a.airport, b: b.airport, months,
    departureDelayRate15: compareRates(ta.dep.delayed15, ta.dep.delayMeasured, tb.dep.delayed15, tb.dep.delayMeasured, MIN_PRACTICAL_DELAY_DIFF),
    cancellationRate: compareRates(ta.dep.cancelled, ta.dep.scheduled, tb.dep.cancelled, tb.dep.scheduled, MIN_PRACTICAL_CANCEL_DIFF),
    medianTaxiOutDifferenceMin: diff(deriveOnTime(ta).medianTaxiOutMin, deriveOnTime(tb).medianTaxiOutMin),
    meanDepartureDelayDifferenceMin: diff(deriveOnTime(ta).meanDepartureDelayMin, deriveOnTime(tb).meanDepartureDelayMin),
    notes,
  };
}
