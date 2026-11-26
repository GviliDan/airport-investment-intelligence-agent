import type { SegmentRecord } from '../data/aggregate.js';
import type { Month } from '../data/types.js';
import { safeDiv } from './stats.js';

/** BTS T-100 service classes as published; F is what most people mean by "passenger flights". */
export const SERVICE_CLASS_LABELS: Readonly<Record<string, string>> = {
  F: 'scheduled passenger/cargo',
  G: 'scheduled all-cargo',
  L: 'non-scheduled civilian passenger/cargo',
  P: 'non-scheduled civilian all-cargo',
};
export const DEFAULT_LONG_HAUL_MILES = 3000;
export const DEFAULT_SERVICE_CLASSES: readonly string[] = ['F'];

export type DepartureBasis = 'performed' | 'scheduled';
const deps = (r: SegmentRecord, basis: DepartureBasis): number => (basis === 'performed' ? r.depsPerformed : r.depsScheduled);

export interface RouteFilter {
  readonly origins?: readonly string[];
  readonly dests?: readonly string[];
  readonly minMiles?: number;
  readonly maxMiles?: number;
  /** Defaults to scheduled passenger service (class F). Pass all four classes to include cargo and charters. */
  readonly classes?: readonly string[];
  readonly months?: readonly Month[];
  readonly destinations?: 'domestic' | 'international' | 'any';
}

export function filterSegments(segments: readonly SegmentRecord[], f: RouteFilter): SegmentRecord[] {
  const classes = new Set(f.classes ?? DEFAULT_SERVICE_CLASSES);
  const origins = f.origins ? new Set(f.origins) : undefined;
  const dests = f.dests ? new Set(f.dests) : undefined;
  const months = f.months ? new Set(f.months) : undefined;
  return segments.filter((r) => {
    if (!classes.has(r.cls)) return false;
    if (origins && !origins.has(r.origin)) return false;
    if (dests && !dests.has(r.dest)) return false;
    if (months && !months.has(r.month)) return false;
    if (f.minMiles !== undefined && r.distance < f.minMiles) return false;
    if (f.maxMiles !== undefined && r.distance >= f.maxMiles) return false;
    if (f.destinations === 'domestic' && r.destCountry !== 'US') return false;
    if (f.destinations === 'international' && r.destCountry === 'US') return false;
    return true;
  });
}

export interface RouteRow {
  readonly origin: string;
  readonly dest: string;
  readonly distanceMiles: number;
  readonly departures: number;
  readonly seats: number;
  readonly passengers: number;
  readonly loadFactor: number | undefined;
  readonly destCountry: string;
}

export type RouteSort = 'departures' | 'seats' | 'passengers' | 'distance';

/** Routes (origin-destination pairs) summed over the selected months and classes. */
export function queryRoutes(segments: readonly SegmentRecord[], f: RouteFilter & { basis?: DepartureBasis; sortBy?: RouteSort; limit?: number }): RouteRow[] {
  const basis = f.basis ?? 'performed';
  const acc = new Map<string, { origin: string; dest: string; distanceMiles: number; departures: number; seats: number; passengers: number; destCountry: string }>();
  for (const r of filterSegments(segments, f)) {
    const key = `${r.origin}|${r.dest}`;
    const cur = acc.get(key) ?? { origin: r.origin, dest: r.dest, distanceMiles: r.distance, departures: 0, seats: 0, passengers: 0, destCountry: r.destCountry };
    cur.departures += deps(r, basis);
    cur.seats += r.seats;
    cur.passengers += r.passengers;
    acc.set(key, cur);
  }
  const sortBy = f.sortBy ?? 'departures';
  const value = (r: RouteRow): number => (sortBy === 'distance' ? r.distanceMiles : r[sortBy]);
  const rows = [...acc.values()]
    .map((r) => ({ ...r, loadFactor: safeDiv(r.passengers, r.seats) }))
    .filter((r) => r.departures > 0 || r.seats > 0 || r.passengers > 0)
    .sort((a, b) => value(b) - value(a) || (a.origin + a.dest).localeCompare(b.origin + b.dest));
  return f.limit === undefined ? rows : rows.slice(0, f.limit);
}

export interface LongHaulResult {
  readonly origin: string;
  readonly thresholdMiles: number;
  readonly classes: readonly string[];
  readonly basis: DepartureBasis;
  readonly months: readonly Month[];
  readonly totalDepartures: number;
  readonly longHaulDepartures: number;
  /** Fraction 0..1. Undefined when the airport has no departures of the selected kind (which is not 0%). */
  readonly share: number | undefined;
  readonly sensitivity: ReadonlyArray<{ thresholdMiles: number; longHaulDepartures: number; share: number | undefined }>;
  /**
   * The same threshold, basis and months under different service-class definitions: scheduled passenger/cargo (F) only, and every
   * class (F, G, L, P). Each row carries its own denominator, so the two shares are never compared across different bases.
   */
  readonly classSensitivity: ReadonlyArray<{ label: string; classes: readonly string[]; totalDepartures: number; longHaulDepartures: number; share: number | undefined }>;
  readonly distanceBands: ReadonlyArray<{ label: string; minMiles: number; maxMiles: number | undefined; departures: number; share: number | undefined }>;
  readonly topLongHaulRoutes: readonly RouteRow[];
  readonly notes: readonly string[];
}

const BANDS: ReadonlyArray<[number, number | undefined]> = [[0, 500], [500, 1500], [1500, 3000], [3000, 5000], [5000, undefined]];
const SENSITIVITY = [1500, 2300, 3000, 3500, 5000];

/**
 * Share of departures from an airport whose route is at least `thresholdMiles` long. Counts actual (performed) departures
 * by default, summed over every selected month and carrier, so it is a measurement, not a schedule-based estimate.
 */
export function longHaulShare(
  segments: readonly SegmentRecord[],
  origin: string,
  opts: { thresholdMiles?: number; classes?: readonly string[]; basis?: DepartureBasis; months?: readonly Month[] } = {},
): LongHaulResult {
  const thresholdMiles = opts.thresholdMiles ?? DEFAULT_LONG_HAUL_MILES;
  if (!(thresholdMiles > 0)) throw new RangeError('thresholdMiles must be positive');
  const classes = opts.classes ?? DEFAULT_SERVICE_CLASSES;
  const basis = opts.basis ?? 'performed';
  const rows = filterSegments(segments, { origins: [origin], classes, ...(opts.months ? { months: opts.months } : {}) });
  const months = [...new Set(rows.map((r) => r.month))].sort();
  const total = rows.reduce((s, r) => s + deps(r, basis), 0);
  const share = (miles: number) => {
    const n = rows.filter((r) => r.distance >= miles).reduce((s, r) => s + deps(r, basis), 0);
    return { thresholdMiles: miles, longHaulDepartures: n, share: total > 0 ? n / total : undefined };
  };
  const main = share(thresholdMiles);
  const notes = [
    `Distance is the great-circle route distance in statute miles; "long haul" here means ${thresholdMiles}+ miles (a configurable assumption, not an industry standard).`,
    `Service class: ${classes.map((c) => `${c} (${SERVICE_CLASS_LABELS[c] ?? 'unknown'})`).join(', ')}. Counts ${basis} departures of all carriers in BTS T-100, including foreign carriers.`,
    'Departures are weighted equally; passengers and seats are not considered.',
    'Class F is the default because it matches "passenger flights"; all-cargo (G) and non-scheduled (L, P) departures can change the share substantially at cargo hubs. See classSensitivity for both, each with its own denominator.',
  ];
  if (total === 0) notes.push(`No ${basis} departures from ${origin} for the selected classes and months, so no share can be computed.`);
  return {
    origin, thresholdMiles, classes, basis, months,
    totalDepartures: total,
    longHaulDepartures: main.longHaulDepartures,
    share: main.share,
    sensitivity: [...new Set([...SENSITIVITY, thresholdMiles])].sort((a, b) => a - b).map(share),
    classSensitivity: [
      { label: 'Scheduled passenger/cargo service only (class F)', classes: DEFAULT_SERVICE_CLASSES },
      { label: 'All service classes, including all-cargo and non-scheduled flights (F, G, L, P)', classes: Object.keys(SERVICE_CLASS_LABELS) },
    ].map(({ label, classes: cls }) => {
      const r = filterSegments(segments, { origins: [origin], classes: cls, ...(opts.months ? { months: opts.months } : {}) });
      const all = r.reduce((s, x) => s + deps(x, basis), 0);
      const n = r.filter((x) => x.distance >= thresholdMiles).reduce((s, x) => s + deps(x, basis), 0);
      return { label, classes: cls, totalDepartures: all, longHaulDepartures: n, share: all > 0 ? n / all : undefined };
    }),
    distanceBands: BANDS.map(([lo, hi]) => {
      const n = rows.filter((r) => r.distance >= lo && (hi === undefined || r.distance < hi)).reduce((s, r) => s + deps(r, basis), 0);
      return { label: hi === undefined ? `${lo}+ mi` : `${lo}-${hi} mi`, minMiles: lo, maxMiles: hi, departures: n, share: total > 0 ? n / total : undefined };
    }),
    topLongHaulRoutes: queryRoutes(segments, { origins: [origin], classes, minMiles: thresholdMiles, basis, ...(opts.months ? { months: opts.months } : {}), limit: 5 }),
    notes,
  };
}

export interface RouteNetwork {
  readonly origin: string;
  readonly months: readonly Month[];
  readonly destinations: number;
  readonly internationalDestinations: number;
  readonly departures: number;
  readonly internationalDepartureShare: number | undefined;
  readonly seats: number;
  readonly passengers: number;
  readonly topRoutes: readonly RouteRow[];
}

/** Nonstop network of one origin: breadth, international exposure and the busiest routes. */
export function routeNetwork(segments: readonly SegmentRecord[], origin: string, opts: { classes?: readonly string[]; months?: readonly Month[]; top?: number } = {}): RouteNetwork {
  const f = { origins: [origin], ...(opts.classes ? { classes: opts.classes } : {}), ...(opts.months ? { months: opts.months } : {}) };
  const routes = queryRoutes(segments, f);
  const active = routes.filter((r) => r.departures > 0);
  const intl = active.filter((r) => r.destCountry !== 'US');
  const departures = active.reduce((s, r) => s + r.departures, 0);
  return {
    origin,
    months: [...new Set(filterSegments(segments, f).map((r) => r.month))].sort(),
    destinations: active.length,
    internationalDestinations: intl.length,
    departures,
    internationalDepartureShare: safeDiv(intl.reduce((s, r) => s + r.departures, 0), departures),
    seats: active.reduce((s, r) => s + r.seats, 0),
    passengers: active.reduce((s, r) => s + r.passengers, 0),
    topRoutes: active.slice(0, opts.top ?? 10),
  };
}
