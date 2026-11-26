/**
 * Demand-pressure indicators for one airport, positioned against its peers.
 *
 * This is NOT a measure of unmet demand. Unmet demand (passengers who wanted to fly but could not, or did not because of
 * price, schedule or capacity) is not published in any public dataset used here. BTS counts passengers who flew. What can
 * be shown is whether existing capacity looks tight and whether the airfield shows strain, each relative to peers.
 */
import type { AirportMetrics } from './metrics.js';
import { monthlySeries, type MonthPoint } from './traffic.js';
import type { MonthlyTraffic } from '../data/btsSocrata.js';
import type { Month } from '../data/types.js';
import { shiftMonth } from '../data/types.js';

export interface PressureIndicator {
  readonly id: string;
  readonly label: string;
  readonly value: number | undefined;
  readonly unit: string;
  /** Position among peers (0 = lowest, 100 = highest). Undefined when the airport or enough peers lack the value. */
  readonly peerPercentile: number | undefined;
  readonly peerCount: number;
  /** What a high reading would suggest, and what it does not show. */
  readonly suggests: string;
  readonly doesNotShow: string;
  readonly standsOut: boolean;
}

export interface DemandPressureProfile {
  readonly airport: string;
  readonly asOf: Month;
  readonly peerGroup: { readonly definition: string; readonly size: number };
  readonly indicators: readonly PressureIndicator[];
  readonly monthlyLoadFactor: readonly MonthPoint[];
  readonly peakLoadFactorMonth: { readonly month: Month; readonly loadFactor: number } | undefined;
  /** Indicators at or above the 75th peer percentile. Empty means none stands out; it is not evidence of low demand. */
  readonly standouts: readonly string[];
  readonly measuredUnmetDemand: null;
  readonly limitations: readonly string[];
}

/** Share of peers below the value, counting ties as half. Needs at least 5 peer values to say anything. */
export function peerPercentile(value: number | undefined, peers: ReadonlyArray<number | undefined>): number | undefined {
  if (value === undefined) return undefined;
  const defined = peers.filter((p): p is number => p !== undefined);
  if (defined.length < 5) return undefined;
  const below = defined.filter((p) => p < value).length;
  const equal = defined.filter((p) => p === value).length;
  return ((below + equal / 2) / defined.length) * 100;
}

type Extract = (m: AirportMetrics) => number | undefined;
interface Spec {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly get: Extract;
  readonly suggests: string;
  readonly doesNotShow: string;
}

const pct = (v: number | undefined): number | undefined => (v === undefined ? undefined : v * 100);
const opsValue = (pick: (m: AirportMetrics) => number | undefined): Extract => (m) => (m.operations.reliable ? pick(m) : undefined);

const SPECS: readonly Spec[] = [
  { id: 'loadFactor12m', label: 'Seat load factor, latest 12 months', unit: '%', get: (m) => pct(m.traffic.current.loadFactor),
    suggests: 'Airlines are filling a large share of the seats they offer, so there is little spare seat capacity.', doesNotShow: 'Terminal or runway congestion, or passengers turned away.' },
  { id: 'passengerGrowth', label: 'Passenger growth, year over year', unit: '%', get: (m) => pct(m.traffic.passengers.pct),
    suggests: 'Demand is rising.', doesNotShow: 'Whether the airport can handle the additional passengers.' },
  { id: 'seatGrowth', label: 'Seat capacity growth, year over year', unit: '%', get: (m) => pct(m.traffic.seats.pct),
    suggests: 'Airlines are adding capacity.', doesNotShow: 'Whether the added capacity is enough.' },
  { id: 'passengerVsSeatGap', label: 'Passenger growth minus seat growth', unit: 'percentage points', get: (m) => m.traffic.passengerVsSeatGrowthPoints,
    suggests: 'Demand is outgrowing the seats being added, so existing seats are filling up.', doesNotShow: 'Unserved demand; airlines may be deliberately holding capacity.' },
  { id: 'seatsPerDeparture', label: 'Seats per departure', unit: 'seats', get: (m) => m.traffic.seatsPerDeparture.current,
    suggests: 'Larger aircraft on average, which means growth is coming from upsizing rather than more flights.', doesNotShow: 'Gate or terminal capacity. Seats come from passenger flights but the departure count includes cargo and charter flights, so this is understated at cargo-heavy airports.' },
  { id: 'departuresPerRunwayDay', label: 'Departures per commercial runway per day', unit: 'departures', get: (m) => m.departuresPerRunwayDay,
    suggests: 'The existing runways are used intensively.', doesNotShow: 'Terminal capacity or whether runway slots are exhausted. Counts all service classes, including cargo and charter departures, which do not use passenger terminals.' },
  { id: 'medianTaxiOut', label: 'Median taxi-out time', unit: 'minutes', get: opsValue((m) => m.operations.derived?.medianTaxiOutMin),
    suggests: 'Aircraft wait longer between gate and takeoff, which is typical of airfield congestion.', doesNotShow: 'Terminal congestion; layout also affects taxi times.' },
  { id: 'departureDelayRate15', label: 'Departures delayed 15+ minutes', unit: '%', get: opsValue((m) => pct(m.operations.derived?.departureDelayRate15)),
    suggests: 'Less reliable operations.', doesNotShow: 'A capacity shortage: weather and airline problems cause many delays.' },
  { id: 'cancellationRate', label: 'Cancellation rate', unit: '%', get: opsValue((m) => pct(m.operations.derived?.cancellationRate)),
    suggests: 'Less reliable operations.', doesNotShow: 'A capacity shortage: weather and airline problems cause most cancellations.' },
];

export function demandPressureProfile(
  target: AirportMetrics,
  peers: readonly AirportMetrics[],
  trafficRows: readonly MonthlyTraffic[],
  peerDefinition: string,
): DemandPressureProfile {
  const others = peers.filter((p) => p.code !== target.code);
  const indicators: PressureIndicator[] = SPECS.map((spec) => {
    const value = spec.get(target);
    const peerValues = others.map(spec.get);
    const percentile = peerPercentile(value, peerValues);
    return {
      id: spec.id, label: spec.label, value, unit: spec.unit,
      peerPercentile: percentile, peerCount: peerValues.filter((v) => v !== undefined).length,
      suggests: spec.suggests, doesNotShow: spec.doesNotShow,
      standsOut: percentile !== undefined && percentile >= 75,
    };
  });
  const end = target.traffic.current.to;
  const series = monthlySeries(trafficRows.filter((r) => r.airport === target.code), shiftMonth(end, 11), end);
  const withLf = series.filter((p): p is MonthPoint & { loadFactor: number } => p.loadFactor !== undefined);
  const peak = withLf.length ? withLf.reduce((best, p) => (p.loadFactor > best.loadFactor ? p : best)) : undefined;
  return {
    airport: target.code,
    asOf: end,
    peerGroup: { definition: peerDefinition, size: others.length },
    indicators,
    monthlyLoadFactor: series,
    peakLoadFactorMonth: peak ? { month: peak.month, loadFactor: peak.loadFactor } : undefined,
    standouts: indicators.filter((i) => i.standsOut).map((i) => i.id),
    measuredUnmetDemand: null,
    limitations: [
      'Unmet demand cannot be measured from public data: BTS reports passengers who flew, not passengers denied, spilled, priced out or discouraged by schedules.',
      'These indicators describe how tight existing capacity looks relative to peers. They do not identify the cause of any tightness, which could be airline decisions, slot or gate limits, weather, or pricing.',
      'Seat load factor measures aircraft fullness. It is not terminal or runway congestion.',
      'Delays and taxi-out times cover June-August and BTS reporting carriers only; delays are driven mostly by weather and airline operations.',
    ],
  };
}
