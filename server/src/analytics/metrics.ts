import type { OnTimeAirportMonth, SegmentRecord } from '../data/aggregate.js';
import type { AirportRecord } from '../data/airportBuild.js';
import type { MonthlyTraffic } from '../data/btsSocrata.js';
import type { Month } from '../data/types.js';
import { departuresPerRunwayPerDay, runwayInfo, summarizeOperations, type OnTimeCoverage, type OperationalSummary, type RunwayInfo } from './operations.js';
import { routeNetwork, type RouteNetwork } from './routes.js';
import { analyzeTraffic, type Baseline, type TrafficAnalysis } from './traffic.js';

/** The slice of the data store that analytics needs. `DataStore` satisfies it; tests supply small fakes. */
export interface AnalyticsData {
  readonly alignedMonths: readonly Month[];
  readonly onTimeByAirport: ReadonlyMap<string, readonly OnTimeAirportMonth[]>;
  readonly segmentsByOrigin: ReadonlyMap<string, readonly SegmentRecord[]>;
  onTimeCoverage(airport: string, months?: readonly string[]): OnTimeCoverage;
}

export interface MetricsOptions {
  readonly endMonth: Month;
  readonly windowMonths?: number;
  readonly baseline?: Baseline;
  readonly minOnTimeCoverage?: number;
}

/** Everything known about one airport over the analysis windows, with missing values left missing. */
export interface AirportMetrics {
  readonly code: string;
  readonly name: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly faaMatched: boolean;
  readonly traffic: TrafficAnalysis;
  readonly runway: RunwayInfo | undefined;
  readonly departuresPerRunwayDay: number | undefined;
  readonly operations: OperationalSummary;
  readonly network: RouteNetwork | undefined;
}

export function computeAirportMetrics(airport: AirportRecord, rows: readonly MonthlyTraffic[], data: AnalyticsData, opts: MetricsOptions): AirportMetrics {
  const traffic = analyzeTraffic(airport.code, rows, { endMonth: opts.endMonth, windowMonths: opts.windowMonths ?? 12, baseline: opts.baseline ?? 'year-over-year' });
  const runway = runwayInfo(airport);
  const months = data.alignedMonths;
  const segments = data.segmentsByOrigin.get(airport.code) ?? [];
  const operations = summarizeOperations(airport.code, data.onTimeByAirport.get(airport.code) ?? [], months, data.onTimeCoverage(airport.code, months), opts.minOnTimeCoverage);
  const windowDays = traffic.current.complete ? daysIn(traffic.current.from, traffic.current.to) : undefined;
  return {
    code: airport.code,
    name: airport.name,
    city: airport.city,
    state: airport.state,
    faaMatched: airport.faaMatched,
    traffic,
    runway,
    departuresPerRunwayDay: windowDays === undefined ? undefined : departuresPerRunwayPerDay(traffic.current.departures, windowDays, runway),
    operations,
    network: segments.length > 0 ? routeNetwork(segments, airport.code, { months, top: 5 }) : undefined,
  };
}

/** Calendar days from the first day of `from` to the last day of `to`. */
export function daysIn(from: Month, to: Month): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return Math.round((Date.UTC(ty, tm, 1) - Date.UTC(fy, fm - 1, 1)) / 86_400_000);
}
