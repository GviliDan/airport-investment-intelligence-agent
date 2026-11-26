import type { AirportMetrics } from './metrics.js';

/** One flat row per airport, for filtering, sorting and side-by-side comparison. Missing values are `undefined`. */
export interface ScreenRow {
  readonly code: string;
  readonly name: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly faaMatched: boolean;
  readonly passengers12m: number | undefined;
  readonly passengerGrowthPct: number | undefined;
  readonly seatGrowthPct: number | undefined;
  readonly departures12m: number | undefined;
  readonly departureGrowthPct: number | undefined;
  readonly loadFactorPct: number | undefined;
  readonly passengerVsSeatGapPoints: number | undefined;
  readonly seatsPerDeparture: number | undefined;
  readonly commercialRunways: number | undefined;
  readonly departuresPerRunwayDay: number | undefined;
  readonly nonstopDestinations: number | undefined;
  readonly internationalDepartureSharePct: number | undefined;
  readonly medianTaxiOutMin: number | undefined;
  readonly departureDelayRatePct: number | undefined;
  readonly cancellationRatePct: number | undefined;
  readonly onTimeCoveragePct: number | undefined;
}

export type ScreenMetric = Exclude<keyof ScreenRow, 'code' | 'name' | 'city' | 'state' | 'faaMatched'>;
export const SCREEN_METRICS: readonly ScreenMetric[] = [
  'passengers12m', 'passengerGrowthPct', 'seatGrowthPct', 'departures12m', 'departureGrowthPct', 'loadFactorPct', 'passengerVsSeatGapPoints',
  'seatsPerDeparture', 'commercialRunways', 'departuresPerRunwayDay', 'nonstopDestinations', 'internationalDepartureSharePct',
  'medianTaxiOutMin', 'departureDelayRatePct', 'cancellationRatePct', 'onTimeCoveragePct',
];

const pct = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * 100);

/** Operational figures are blanked when on-time coverage is weak, so they cannot slip into comparisons unnoticed. */
export function toScreenRow(m: AirportMetrics): ScreenRow {
  const t = m.traffic;
  const d = m.operations.reliable ? m.operations.derived : undefined;
  return {
    code: m.code, name: m.name, city: m.city, state: m.state, faaMatched: m.faaMatched,
    passengers12m: t.current.passengers, passengerGrowthPct: pct(t.passengers.pct), seatGrowthPct: pct(t.seats.pct),
    departures12m: t.current.departures, departureGrowthPct: pct(t.departures.pct), loadFactorPct: pct(t.current.loadFactor),
    passengerVsSeatGapPoints: t.passengerVsSeatGrowthPoints, seatsPerDeparture: t.seatsPerDeparture.current,
    commercialRunways: m.runway?.commercialRunways, departuresPerRunwayDay: m.departuresPerRunwayDay,
    nonstopDestinations: m.network?.destinations, internationalDepartureSharePct: pct(m.network?.internationalDepartureShare),
    medianTaxiOutMin: d?.medianTaxiOutMin, departureDelayRatePct: pct(d?.departureDelayRate15), cancellationRatePct: pct(d?.cancellationRate),
    onTimeCoveragePct: pct(m.operations.coverage.ratio),
  };
}

export interface ScreenFilter {
  readonly metric: ScreenMetric;
  readonly min?: number;
  readonly max?: number;
}

export interface ScreenQuery {
  readonly filters?: readonly ScreenFilter[];
  readonly sortBy?: ScreenMetric;
  readonly descending?: boolean;
  readonly limit?: number;
}

export interface ScreenResult {
  readonly rows: readonly ScreenRow[];
  /** Airports dropped because a filtered or sorted metric was missing for them (listed, not silently lost). */
  readonly missingMetric: ReadonlyArray<{ code: string; metric: ScreenMetric }>;
  readonly matched: number;
}

/** Applies range filters and a sort. An airport missing a filtered metric is not "zero"; it is reported in `missingMetric`. */
export function screen(rows: readonly ScreenRow[], q: ScreenQuery = {}): ScreenResult {
  for (const f of q.filters ?? []) if (!SCREEN_METRICS.includes(f.metric)) throw new RangeError(`unknown metric "${f.metric}"`);
  if (q.sortBy !== undefined && !SCREEN_METRICS.includes(q.sortBy)) throw new RangeError(`unknown sort metric "${q.sortBy}"`);
  const missing: Array<{ code: string; metric: ScreenMetric }> = [];
  const kept = rows.filter((r) => {
    for (const f of q.filters ?? []) {
      const v = r[f.metric];
      if (v === undefined) {
        missing.push({ code: r.code, metric: f.metric });
        return false;
      }
      if ((f.min !== undefined && v < f.min) || (f.max !== undefined && v > f.max)) return false;
    }
    return true;
  });
  let ordered = kept;
  if (q.sortBy !== undefined) {
    const key = q.sortBy;
    const dir = q.descending === false ? 1 : -1;
    const withValue = kept.filter((r) => r[key] !== undefined);
    for (const r of kept) if (r[key] === undefined) missing.push({ code: r.code, metric: key });
    ordered = [...withValue].sort((a, b) => dir * ((a[key] as number) - (b[key] as number)) || a.code.localeCompare(b.code));
  } else {
    ordered = [...kept].sort((a, b) => a.code.localeCompare(b.code));
  }
  return { rows: q.limit === undefined ? ordered : ordered.slice(0, q.limit), missingMetric: missing, matched: ordered.length };
}
