/**
 * Pure aggregation of BTS rows into the lightweight processed datasets.
 * Everything stored is a count, a sum or a histogram, so months and airports can be combined exactly later.
 * Rates and medians are derived at read time (see `deriveOnTime`), never stored or averaged.
 */
import type { Month } from './types.js';

export type Row = Record<string, string>;

const BLANK = (s: string | undefined): boolean => s === undefined || s.trim() === '';
/** Parses a numeric cell; blank or non-numeric becomes undefined (missing is never 0). */
export function cell(row: Row, name: string): number | undefined {
  const raw = row[name];
  if (BLANK(raw)) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/* ---------------------------------------------------------------- T-100 segment (route level) */

/** One origin-destination pair, service class and month, summed over carriers and aircraft types. */
export interface SegmentRecord {
  readonly month: Month;
  readonly origin: string;
  readonly dest: string;
  /** BTS service class: F scheduled passenger, G scheduled all-cargo, L/P non-scheduled, etc. */
  readonly cls: string;
  /** Great-circle route distance, statute miles. */
  readonly distance: number;
  readonly depsScheduled: number;
  readonly depsPerformed: number;
  readonly seats: number;
  readonly passengers: number;
  readonly freightLbs: number;
  readonly mailLbs: number;
  readonly originCountry: string;
  readonly destCountry: string;
}

export interface AirportIdentity {
  readonly code: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  /** BTS numeric airport ids seen for this code; more than one means the code is ambiguous over time. */
  readonly btsIds: string[];
}

export interface SegmentStats {
  rowsRead: number;
  rowsKept: number;
  rowsInactive: number;
  rowsInvalid: number;
  rowsOutsideMonth: number;
  distanceConflicts: number;
}

export class SegmentAggregator {
  readonly stats: SegmentStats = { rowsRead: 0, rowsKept: 0, rowsInactive: 0, rowsInvalid: 0, rowsOutsideMonth: 0, distanceConflicts: 0 };
  private readonly map = new Map<string, { -readonly [K in keyof SegmentRecord]: SegmentRecord[K] }>();
  private readonly ids = new Map<string, { city?: string; state?: string; country?: string; btsIds: Set<string> }>();

  constructor(private readonly month: Month) {}

  add(row: Row): void {
    this.stats.rowsRead += 1;
    const month = `${row.YEAR}-${String(row.MONTH).padStart(2, '0')}`;
    if (month !== this.month) return void (this.stats.rowsOutsideMonth += 1);
    const origin = row.ORIGIN?.trim();
    const dest = row.DEST?.trim();
    const cls = row.CLASS?.trim();
    const distance = cell(row, 'DISTANCE');
    const sched = cell(row, 'DEPARTURES_SCHEDULED');
    const perf = cell(row, 'DEPARTURES_PERFORMED');
    const seats = cell(row, 'SEATS');
    const pax = cell(row, 'PASSENGERS');
    if (!origin || !dest || !cls || distance === undefined || sched === undefined || perf === undefined || seats === undefined || pax === undefined) {
      return void (this.stats.rowsInvalid += 1);
    }
    this.noteAirport(origin, row, 'ORIGIN');
    this.noteAirport(dest, row, 'DEST');
    const freight = cell(row, 'FREIGHT') ?? 0;
    const mail = cell(row, 'MAIL') ?? 0;
    if (sched === 0 && perf === 0 && seats === 0 && pax === 0 && freight === 0 && mail === 0) {
      return void (this.stats.rowsInactive += 1);
    }
    this.stats.rowsKept += 1;
    const key = `${origin}|${dest}|${cls}`;
    const cur = this.map.get(key);
    if (!cur) {
      this.map.set(key, {
        month, origin, dest, cls, distance,
        depsScheduled: sched, depsPerformed: perf, seats, passengers: pax, freightLbs: freight, mailLbs: mail,
        originCountry: row.ORIGIN_COUNTRY ?? '', destCountry: row.DEST_COUNTRY ?? '',
      });
      return;
    }
    if (Math.abs(cur.distance - distance) > 1) this.stats.distanceConflicts += 1;
    cur.depsScheduled += sched;
    cur.depsPerformed += perf;
    cur.seats += seats;
    cur.passengers += pax;
    cur.freightLbs += freight;
    cur.mailLbs += mail;
  }

  private noteAirport(code: string, row: Row, side: 'ORIGIN' | 'DEST'): void {
    const entry = this.ids.get(code) ?? { btsIds: new Set<string>() };
    const city = row[`${side}_CITY_NAME`];
    const state = row[`${side}_STATE_ABR`];
    const country = row[`${side}_COUNTRY`];
    const id = row[`${side}_AIRPORT_ID`];
    if (!BLANK(city)) entry.city = city;
    if (!BLANK(state)) entry.state = state;
    if (!BLANK(country)) entry.country = country;
    if (!BLANK(id)) entry.btsIds.add(id as string);
    this.ids.set(code, entry);
  }

  records(): SegmentRecord[] {
    return [...this.map.values()].sort((a, b) => (a.origin + a.dest + a.cls).localeCompare(b.origin + b.dest + b.cls));
  }

  airports(): AirportIdentity[] {
    return [...this.ids.entries()].map(([code, e]) => ({ code, ...(e.city ? { city: e.city } : {}), ...(e.state ? { state: e.state } : {}), ...(e.country ? { country: e.country } : {}), btsIds: [...e.btsIds].sort() }));
  }
}

/* ---------------------------------------------------------------- On-Time Performance (airport level) */

/** Taxi-out minutes at or above this share one overflow bin. */
export const TAXI_CAP = 180;
export type Histogram = Record<string, number>;

/** Departure-side counts for an origin airport and month. */
export interface DepartureCounts {
  /** Flights scheduled by BTS reporting carriers (includes cancelled and diverted). */
  scheduled: number;
  cancelled: number;
  /** Cancellations by BTS code: A carrier, B weather, C national air system, D security. */
  cancelledByCode: Record<string, number>;
  /** Flights that departed and have a known departure delay (the denominator for delay rates). */
  delayMeasured: number;
  delayed15: number;
  /** Sum of departure delay minutes, early departures counted as 0 (BTS DEP_DELAY_NEW). */
  delayMinutes: number;
  taxiOutN: number;
  taxiOutSum: number;
  taxiOutHist: Histogram;
}

/** Arrival-side counts for a destination airport and month. Delay causes are only reported for arrivals. */
export interface ArrivalCounts {
  scheduled: number;
  cancelled: number;
  diverted: number;
  delayMeasured: number;
  delayed15: number;
  delayMinutes: number;
  taxiInN: number;
  taxiInSum: number;
  /** Arrivals delayed 15+ minutes that carry a cause breakdown (the denominator for cause shares). */
  causeFlights: number;
  causeMinutes: { carrier: number; weather: number; nas: number; security: number; lateAircraft: number };
}

export interface OnTimeAirportMonth {
  readonly airport: string;
  readonly month: Month;
  readonly dep: DepartureCounts;
  readonly arr: ArrivalCounts;
  /** Distinct reporting carriers seen. Carriers below the BTS reporting threshold are absent from this dataset. */
  readonly reportingCarriers: number;
}

export interface OnTimeStats {
  rowsRead: number;
  rowsOutsideMonth: number;
  rowsInvalid: number;
}

const emptyDep = (): DepartureCounts => ({ scheduled: 0, cancelled: 0, cancelledByCode: {}, delayMeasured: 0, delayed15: 0, delayMinutes: 0, taxiOutN: 0, taxiOutSum: 0, taxiOutHist: {} });
const emptyArr = (): ArrivalCounts => ({ scheduled: 0, cancelled: 0, diverted: 0, delayMeasured: 0, delayed15: 0, delayMinutes: 0, taxiInN: 0, taxiInSum: 0, causeFlights: 0, causeMinutes: { carrier: 0, weather: 0, nas: 0, security: 0, lateAircraft: 0 } });

export class OnTimeAggregator {
  readonly stats: OnTimeStats = { rowsRead: 0, rowsOutsideMonth: 0, rowsInvalid: 0 };
  private readonly airports = new Map<string, { dep: DepartureCounts; arr: ArrivalCounts; carriers: Set<string> }>();

  constructor(private readonly month: Month) {}

  private entry(code: string) {
    let e = this.airports.get(code);
    if (!e) this.airports.set(code, (e = { dep: emptyDep(), arr: emptyArr(), carriers: new Set() }));
    return e;
  }

  add(row: Row): void {
    this.stats.rowsRead += 1;
    const month = `${row.YEAR}-${String(row.MONTH).padStart(2, '0')}`;
    if (month !== this.month) return void (this.stats.rowsOutsideMonth += 1);
    const origin = row.ORIGIN?.trim();
    const dest = row.DEST?.trim();
    const cancelled = cell(row, 'CANCELLED');
    if (!origin || !dest || cancelled === undefined) return void (this.stats.rowsInvalid += 1);
    const diverted = cell(row, 'DIVERTED') === 1;
    const carrier = row.OP_UNIQUE_CARRIER?.trim();

    const o = this.entry(origin);
    if (carrier) o.carriers.add(carrier);
    o.dep.scheduled += 1;
    if (cancelled === 1) {
      o.dep.cancelled += 1;
      const code = row.CANCELLATION_CODE?.trim();
      if (code) o.dep.cancelledByCode[code] = (o.dep.cancelledByCode[code] ?? 0) + 1;
    } else {
      const del15 = cell(row, 'DEP_DEL15');
      if (del15 !== undefined) {
        o.dep.delayMeasured += 1;
        if (del15 === 1) o.dep.delayed15 += 1;
        o.dep.delayMinutes += cell(row, 'DEP_DELAY_NEW') ?? 0;
      }
      const taxi = cell(row, 'TAXI_OUT');
      if (taxi !== undefined && taxi >= 0) {
        o.dep.taxiOutN += 1;
        o.dep.taxiOutSum += taxi;
        const bin = String(Math.min(Math.round(taxi), TAXI_CAP));
        o.dep.taxiOutHist[bin] = (o.dep.taxiOutHist[bin] ?? 0) + 1;
      }
    }

    const d = this.entry(dest);
    if (carrier) d.carriers.add(carrier);
    d.arr.scheduled += 1;
    if (cancelled === 1) d.arr.cancelled += 1;
    else if (diverted) d.arr.diverted += 1;
    else {
      const del15 = cell(row, 'ARR_DEL15');
      if (del15 !== undefined) {
        d.arr.delayMeasured += 1;
        if (del15 === 1) d.arr.delayed15 += 1;
        d.arr.delayMinutes += cell(row, 'ARR_DELAY_NEW') ?? 0;
      }
      const taxiIn = cell(row, 'TAXI_IN');
      if (taxiIn !== undefined && taxiIn >= 0) {
        d.arr.taxiInN += 1;
        d.arr.taxiInSum += taxiIn;
      }
      const causes = [cell(row, 'CARRIER_DELAY'), cell(row, 'WEATHER_DELAY'), cell(row, 'NAS_DELAY'), cell(row, 'SECURITY_DELAY'), cell(row, 'LATE_AIRCRAFT_DELAY')];
      if (causes.every((c) => c !== undefined)) {
        const [c, w, n, s, l] = causes as number[];
        d.arr.causeFlights += 1;
        d.arr.causeMinutes.carrier += c as number;
        d.arr.causeMinutes.weather += w as number;
        d.arr.causeMinutes.nas += n as number;
        d.arr.causeMinutes.security += s as number;
        d.arr.causeMinutes.lateAircraft += l as number;
      }
    }
  }

  records(): OnTimeAirportMonth[] {
    return [...this.airports.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([airport, e]) => ({ airport, month: this.month, dep: e.dep, arr: e.arr, reportingCarriers: e.carriers.size }));
  }
}

/* ---------------------------------------------------------------- combining and deriving */

const addHist = (a: Histogram, b: Histogram): Histogram => {
  const out: Histogram = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** Exact sum of airport-month records (any mix of months). Rates must be derived from the sum, not averaged. */
export function sumOnTime(records: readonly OnTimeAirportMonth[]): { dep: DepartureCounts; arr: ArrivalCounts; months: Month[] } {
  const dep = emptyDep();
  const arr = emptyArr();
  for (const r of records) {
    dep.scheduled += r.dep.scheduled;
    dep.cancelled += r.dep.cancelled;
    for (const [k, v] of Object.entries(r.dep.cancelledByCode)) dep.cancelledByCode[k] = (dep.cancelledByCode[k] ?? 0) + v;
    dep.delayMeasured += r.dep.delayMeasured;
    dep.delayed15 += r.dep.delayed15;
    dep.delayMinutes += r.dep.delayMinutes;
    dep.taxiOutN += r.dep.taxiOutN;
    dep.taxiOutSum += r.dep.taxiOutSum;
    dep.taxiOutHist = addHist(dep.taxiOutHist, r.dep.taxiOutHist);
    arr.scheduled += r.arr.scheduled;
    arr.cancelled += r.arr.cancelled;
    arr.diverted += r.arr.diverted;
    arr.delayMeasured += r.arr.delayMeasured;
    arr.delayed15 += r.arr.delayed15;
    arr.delayMinutes += r.arr.delayMinutes;
    arr.taxiInN += r.arr.taxiInN;
    arr.taxiInSum += r.arr.taxiInSum;
    arr.causeFlights += r.arr.causeFlights;
    for (const k of ['carrier', 'weather', 'nas', 'security', 'lateAircraft'] as const) arr.causeMinutes[k] += r.arr.causeMinutes[k];
  }
  return { dep, arr, months: [...new Set(records.map((r) => r.month))].sort() };
}

/** Exact median of integer values stored as a histogram (average of the two middle values when n is even). */
export function medianFromHistogram(hist: Histogram): number | undefined {
  const bins = Object.entries(hist).map(([k, v]) => [Number(k), v] as const).sort((a, b) => a[0] - b[0]);
  const n = bins.reduce((s, [, v]) => s + v, 0);
  if (n === 0) return undefined;
  const at = (rank: number): number => {
    let seen = 0;
    for (const [value, count] of bins) {
      seen += count;
      if (rank <= seen) return value;
    }
    return (bins.at(-1) as readonly [number, number])[0];
  };
  return n % 2 === 1 ? at((n + 1) / 2) : (at(n / 2) + at(n / 2 + 1)) / 2;
}

const ratio = (num: number, den: number): number | undefined => (den > 0 ? num / den : undefined);

export interface DerivedOnTime {
  readonly scheduledDepartures: number;
  /** Fractions 0..1; undefined when the denominator is zero (no data), which is not the same as 0%. */
  readonly cancellationRate: number | undefined;
  readonly departureDelayRate15: number | undefined;
  readonly meanDepartureDelayMin: number | undefined;
  readonly arrivalDelayRate15: number | undefined;
  readonly medianTaxiOutMin: number | undefined;
  readonly meanTaxiOutMin: number | undefined;
  /** Share of cause-attributed delay minutes by cause (arrivals delayed 15+). */
  readonly delayCauseShare: Record<'carrier' | 'weather' | 'nas' | 'security' | 'lateAircraft', number> | undefined;
}

export function deriveOnTime(t: ReturnType<typeof sumOnTime>): DerivedOnTime {
  const causeTotal = Object.values(t.arr.causeMinutes).reduce((a, b) => a + b, 0);
  const share = (v: number): number => v / causeTotal;
  return {
    scheduledDepartures: t.dep.scheduled,
    cancellationRate: ratio(t.dep.cancelled, t.dep.scheduled),
    departureDelayRate15: ratio(t.dep.delayed15, t.dep.delayMeasured),
    meanDepartureDelayMin: ratio(t.dep.delayMinutes, t.dep.delayMeasured),
    arrivalDelayRate15: ratio(t.arr.delayed15, t.arr.delayMeasured),
    medianTaxiOutMin: medianFromHistogram(t.dep.taxiOutHist),
    meanTaxiOutMin: ratio(t.dep.taxiOutSum, t.dep.taxiOutN),
    delayCauseShare: causeTotal > 0 ? { carrier: share(t.arr.causeMinutes.carrier), weather: share(t.arr.causeMinutes.weather), nas: share(t.arr.causeMinutes.nas), security: share(t.arr.causeMinutes.security), lateAircraft: share(t.arr.causeMinutes.lateAircraft) } : undefined,
  };
}
