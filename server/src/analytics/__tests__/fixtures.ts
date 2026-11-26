import type { SegmentRecord } from '../../data/aggregate.js';
import type { AirportRecord } from '../../data/airportBuild.js';
import type { MonthlyTraffic } from '../../data/btsSocrata.js';
import { monthRange, type Month } from '../../data/types.js';
import { computeAirportMetrics, type AirportMetrics, type AnalyticsData } from '../metrics.js';
import type { OperationalSummary } from '../operations.js';

/** 24 months of uniform traffic: `prior` per month for the older 12, `latest` per month for the newest 12. */
export function trafficRows(code: string, o: { endMonth?: Month; latestPassengers: number; priorPassengers: number; latestSeats?: number; priorSeats?: number; latestDepartures?: number; priorDepartures?: number }): MonthlyTraffic[] {
  const end = o.endMonth ?? '2026-08';
  const months = monthRange(shift(end, -23), end);
  return months.map((month, i) => {
    const latest = i >= 12;
    return {
      airport: code, month,
      passengers: (latest ? o.latestPassengers : o.priorPassengers) / 12,
      seats: ((latest ? o.latestSeats : o.priorSeats) ?? (latest ? o.latestPassengers : o.priorPassengers) * 1.25) / 12,
      departures: ((latest ? o.latestDepartures : o.priorDepartures) ?? 1200) / 12,
    };
  });
}

function shift(month: Month, n: number): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

export const airport = (code: string, o: Partial<AirportRecord> = {}): AirportRecord => ({
  code, name: `${code} Airport`, city: `${code} City, ST`, state: 'ST', country: 'US', runways: [{ id: '1/19', lengthFt: 8000 }], faaMatched: true, ambiguousCode: false, ...o,
});

const reliableOps = (code: string, taxi: number | undefined, delay: number): OperationalSummary => ({
  airport: code, months: ['2026-06', '2026-07', '2026-08'], monthsMissing: [], available: true, reliable: true,
  coverage: { ratio: 0.9, onTimeFlights: 900, t100ScheduledDepartures: 1000 }, scheduledDepartures: 900,
  derived: { scheduledDepartures: 900, cancellationRate: 0.01, departureDelayRate15: delay, meanDepartureDelayMin: 10, arrivalDelayRate15: delay, medianTaxiOutMin: taxi, meanTaxiOutMin: taxi, delayCauseShare: undefined },
  cancellationCauseShare: undefined, notes: [],
});

export const emptyData: AnalyticsData = {
  alignedMonths: ['2026-06', '2026-07', '2026-08'],
  onTimeByAirport: new Map(),
  segmentsByOrigin: new Map<string, readonly SegmentRecord[]>(),
  onTimeCoverage: () => ({ ratio: undefined, onTimeFlights: 0, t100ScheduledDepartures: 0 }),
};

export interface Spec {
  code: string;
  latest: number;
  prior: number;
  latestSeats?: number;
  priorSeats?: number;
  deps?: number;
  runways?: number | null; // null => no FAA match
  taxi?: number | undefined | 'none'; // 'none' => no on-time data
  delay?: number;
}

/** Builds metrics through the real computation path, then swaps in a fixed operational summary. */
export function metricsFor(spec: Spec): AirportMetrics {
  const a = spec.runways === null ? airport(spec.code, { faaMatched: false, runways: [] }) : airport(spec.code, { runways: Array.from({ length: spec.runways ?? 2 }, (_, i) => ({ id: `${i}`, lengthFt: 8000 })) });
  const rows = trafficRows(spec.code, { latestPassengers: spec.latest, priorPassengers: spec.prior, ...(spec.latestSeats ? { latestSeats: spec.latestSeats } : {}), ...(spec.priorSeats ? { priorSeats: spec.priorSeats } : {}), latestDepartures: spec.deps ?? 36_500, priorDepartures: spec.deps ?? 36_500 });
  const m = computeAirportMetrics(a, rows, emptyData, { endMonth: '2026-08' });
  const operations: OperationalSummary =
    spec.taxi === 'none'
      ? { ...reliableOps(spec.code, undefined, 0), available: false, reliable: false, derived: undefined, coverage: { ratio: undefined, onTimeFlights: 0, t100ScheduledDepartures: 0 } }
      : reliableOps(spec.code, spec.taxi, spec.delay ?? 0.2);
  return { ...m, operations };
}
