import type { AirportRecord } from '../data/airportBuild.js';
import type { FaaNasStatusClient, NasEvent, NasSnapshot } from '../data/faaNasStatus.js';
import type { DataStore } from '../data/store.js';
import type { MonthlyTraffic } from '../data/btsSocrata.js';
import type { TrafficMode, TrafficProvider } from '../data/trafficProvider.js';
import { shiftMonth, type Month, type Provenance } from '../data/types.js';
import { demandPressureProfile, type DemandPressureProfile } from './demandPressure.js';
import { computeAirportMetrics, type AirportMetrics, type AnalyticsData } from './metrics.js';
import { compareOperations, type OperationalComparison, type RunwayInfo } from './operations.js';
import { longHaulShare, queryRoutes, routeNetwork, type LongHaulResult, type RouteFilter, type RouteNetwork, type RouteRow, type RouteSort, type DepartureBasis } from './routes.js';
import { rankOpportunities, type OpportunityRanking, type ScoringConfig } from './scoring.js';
import { screen, toScreenRow, type ScreenQuery, type ScreenResult } from './screen.js';
import { analyzeTraffic, type Baseline, type TrafficAnalysis } from './traffic.js';
import { distanceMiles, normalizeState } from '../data/geo.js';

export class AnalyticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsError';
  }
}

/** Where the numbers came from, attached to every analytical result. */
export interface AnalysisMeta {
  readonly asOf: Month | undefined;
  readonly traffic: { readonly mode: TrafficMode; readonly provenance: Provenance; readonly liveError?: string };
  /** Months of the on-time and route datasets (committed, prefetched from BTS). */
  readonly operationalMonths: readonly Month[];
  readonly datasetNotes: readonly string[];
}

export interface Scope {
  readonly states?: readonly string[];
  readonly codes?: readonly string[];
  readonly near?: { readonly lat: number; readonly lon: number; readonly radiusMiles: number };
}

export interface ServiceDeps {
  readonly store: DataStore & AnalyticsData;
  readonly traffic: TrafficProvider;
  /** `current` is optional so lightweight stubs (tests) can provide only per-airport lookups. */
  readonly nas?: Pick<FaaNasStatusClient, 'forAirport'> & Partial<Pick<FaaNasStatusClient, 'current'>>;
  readonly now?: () => Date;
}

/** Longest list of airport codes that fits comfortably in one API request URL. */
const MAX_CODES_PER_QUERY = 150;
const PEER_MIN_PASSENGERS = 5_000_000;
const MAX_LISTED_EXCLUSIONS = 200;

export class AnalyticsService {
  constructor(private readonly deps: ServiceDeps) {}

  private get store() {
    return this.deps.store;
  }
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Airports matching a scope. With no scope at all this is every US airport with traffic data: never a hidden region. */
  selectAirports(scope: Scope = {}): { airports: AirportRecord[]; description: string; issues: string[] } {
    const issues: string[] = [];
    const parts: string[] = [];
    let pool: AirportRecord[] = this.store.airports.airports.filter((a) => a.country === 'US' && this.store.trafficByAirport.has(a.code));
    if (scope.codes && scope.codes.length > 0) {
      const wanted = new Set(scope.codes.map((c) => c.toUpperCase()));
      const found = pool.filter((a) => wanted.has(a.code));
      for (const c of wanted) if (!found.some((a) => a.code === c)) issues.push(`${c} is not a US airport with traffic data`);
      pool = found;
      parts.push(`airports ${[...wanted].join(', ')}`);
    }
    if (scope.states && scope.states.length > 0) {
      const states = new Set<string>();
      for (const s of scope.states) {
        const n = normalizeState(s);
        if (n) states.add(n);
        else issues.push(`unknown state "${s}"`);
      }
      pool = pool.filter((a) => a.state !== undefined && states.has(a.state));
      parts.push(`states ${[...states].join(', ')}`);
    }
    if (scope.near) {
      const { lat, lon, radiusMiles } = scope.near;
      if (!(radiusMiles > 0)) throw new AnalyticsError('radiusMiles must be positive');
      const missing = pool.filter((a) => a.lat === undefined).length;
      pool = pool.filter((a) => a.lat !== undefined && a.lon !== undefined && distanceMiles({ lat, lon }, { lat: a.lat, lon: a.lon }) <= radiusMiles);
      parts.push(`within ${radiusMiles} miles of (${lat.toFixed(2)}, ${lon.toFixed(2)})`);
      if (missing > 0) issues.push(`${missing} airports in scope have no coordinates and could not be placed for the radius filter`);
    }
    return { airports: pool, description: parts.length ? parts.join('; ') : 'all US airports with traffic data', issues };
  }

  private async loadTraffic(codes: readonly string[]): Promise<{ rows: MonthlyTraffic[]; meta: AnalysisMeta['traffic'] }> {
    const to = this.now().toISOString().slice(0, 7);
    const from = shiftMonth(to, 35);
    const result = await this.deps.traffic.monthly(codes.length > MAX_CODES_PER_QUERY ? undefined : codes, from, to);
    const wanted = new Set(codes);
    return {
      rows: result.data.filter((r) => wanted.has(r.airport)),
      meta: { mode: result.mode, provenance: result.provenance, ...(result.liveError ? { liveError: result.liveError } : {}) },
    };
  }

  /** The latest month for which nearly every airport reporting in the previous month also has a row (guards against a partly published month). */
  private commonLatestMonth(rows: readonly MonthlyTraffic[]): Month | undefined {
    const perMonth = new Map<Month, Set<string>>();
    for (const r of rows) perMonth.set(r.month, (perMonth.get(r.month) ?? new Set()).add(r.airport));
    const months = [...perMonth.keys()].sort().reverse();
    const best = Math.max(0, ...[...perMonth.values()].map((s) => s.size));
    return months.find((m) => (perMonth.get(m)?.size ?? 0) >= 0.8 * best);
  }

  private async metricsFor(airports: readonly AirportRecord[], opts: { endMonth?: Month; windowMonths?: number; baseline?: Baseline } = {}): Promise<{ metrics: AirportMetrics[]; meta: AnalysisMeta; rows: MonthlyTraffic[] }> {
    const { rows, meta } = await this.loadTraffic(airports.map((a) => a.code));
    const asOf = opts.endMonth ?? this.commonLatestMonth(rows);
    if (asOf === undefined) throw new AnalyticsError('no passenger traffic data is available for the selected airports');
    const byAirport = new Map<string, MonthlyTraffic[]>();
    for (const r of rows) byAirport.set(r.airport, [...(byAirport.get(r.airport) ?? []), r]);
    const metrics = airports.map((a) => computeAirportMetrics(a, byAirport.get(a.code) ?? [], this.store, { endMonth: asOf, ...(opts.windowMonths ? { windowMonths: opts.windowMonths } : {}), ...(opts.baseline ? { baseline: opts.baseline } : {}) }));
    return { metrics, rows, meta: { asOf, traffic: meta, operationalMonths: this.store.alignedMonths, datasetNotes: this.datasetNotes() } };
  }

  private datasetNotes(): string[] {
    const d = this.store.manifest.datasets;
    return [
      `Passenger, seat and departure totals: ${d['traffic-monthly']?.source ?? 'BTS T-100'} (live API, snapshot only if the API fails).`,
      `Routes and distances: ${d['route-segments']?.source ?? 'BTS T-100 Segment'}, prefetched for ${this.store.alignedMonths.join(', ')}.`,
      `Delays, cancellations and taxi-out: ${d['ontime-airport-month']?.source ?? 'BTS On-Time Performance'}, prefetched for ${this.store.alignedMonths.join(', ')}; reporting carriers only.`,
      'Runways and coordinates: FAA Aviation Facilities (NTAD ArcGIS), committed snapshot.',
    ];
  }

  private require(codes: readonly string[]): AirportRecord[] {
    return codes.map((c) => {
      const a = this.store.airports.get(c);
      if (!a) throw new AnalyticsError(`unknown airport code "${c}"`);
      return a;
    });
  }

  /* ------------------------------------------------------------------ capabilities */

  async trafficGrowth(code: string, opts: { windowMonths?: number; baseline?: Baseline; endMonth?: Month } = {}): Promise<{ analysis: TrafficAnalysis; meta: AnalysisMeta }> {
    const [airport] = this.require([code]) as [AirportRecord];
    const { rows, meta } = await this.loadTraffic([airport.code]);
    const asOf = opts.endMonth ?? this.commonLatestMonth(rows);
    if (asOf === undefined) throw new AnalyticsError(`no traffic data for ${code}`);
    return { analysis: analyzeTraffic(airport.code, rows, { endMonth: asOf, ...(opts.windowMonths ? { windowMonths: opts.windowMonths } : {}), ...(opts.baseline ? { baseline: opts.baseline } : {}) }), meta: { asOf, traffic: meta, operationalMonths: this.store.alignedMonths, datasetNotes: this.datasetNotes() } };
  }

  async rankOpportunities(query: Scope & ScoringConfig & { windowMonths?: number }): Promise<{ scope: string; scopeIssues: readonly string[]; ranking: OpportunityRanking; meta: AnalysisMeta }> {
    const { airports, description, issues } = this.selectAirports(query);
    if (airports.length === 0) throw new AnalyticsError(`no airports match the scope (${description})${issues.length ? `: ${issues.join('; ')}` : ''}`);
    const { metrics, meta } = await this.metricsFor(airports, query.windowMonths ? { windowMonths: query.windowMonths } : {});
    const ranking = rankOpportunities(metrics, query);
    const trimmed = ranking.excluded.length > MAX_LISTED_EXCLUSIONS ? { ...ranking, excluded: ranking.excluded.slice(0, MAX_LISTED_EXCLUSIONS) } : ranking;
    return { scope: description, scopeIssues: issues, ranking: trimmed, meta };
  }

  /** Operational profile and pairwise comparison for two or more airports, plus live FAA status where reachable. */
  async compareOperations(codes: readonly string[]): Promise<{
    airports: Array<{ metrics: AirportMetrics; liveStatus: { events: readonly NasEvent[] } | { unavailable: string } }>;
    comparisons: OperationalComparison[];
    meta: AnalysisMeta;
  }> {
    if (codes.length < 2) throw new AnalyticsError('provide at least two airports to compare');
    const records = this.require(codes);
    const { metrics, meta } = await this.metricsFor(records);
    const airports = await Promise.all(
      metrics.map(async (m) => {
        if (!this.deps.nas) return { metrics: m, liveStatus: { unavailable: 'live FAA status not configured' } };
        try {
          return { metrics: m, liveStatus: { events: (await this.deps.nas.forAirport(m.code)).data } };
        } catch (err) {
          return { metrics: m, liveStatus: { unavailable: (err as Error).message } };
        }
      }),
    );
    const comparisons: OperationalComparison[] = [];
    for (let i = 0; i < metrics.length; i += 1) {
      for (let j = i + 1; j < metrics.length; j += 1) {
        const a = metrics[i] as AirportMetrics;
        const b = metrics[j] as AirportMetrics;
        comparisons.push(compareOperations(a.operations, b.operations, this.store.onTimeByAirport.get(a.code) ?? [], this.store.onTimeByAirport.get(b.code) ?? []));
      }
    }
    return { airports, comparisons, meta };
  }

  longHaul(code: string, opts: { thresholdMiles?: number; classes?: readonly string[]; basis?: DepartureBasis; months?: readonly Month[] } = {}): LongHaulResult & { meta: Pick<AnalysisMeta, 'operationalMonths' | 'datasetNotes'> } {
    const [airport] = this.require([code]) as [AirportRecord];
    const result = longHaulShare(this.store.segmentsByOrigin.get(airport.code) ?? [], airport.code, { ...opts, months: opts.months ?? this.store.alignedMonths });
    return { ...result, meta: { operationalMonths: this.store.alignedMonths, datasetNotes: this.datasetNotes() } };
  }

  network(code: string, opts: { classes?: readonly string[]; months?: readonly Month[]; top?: number } = {}): RouteNetwork {
    const [airport] = this.require([code]) as [AirportRecord];
    return routeNetwork(this.store.segmentsByOrigin.get(airport.code) ?? [], airport.code, { months: this.store.alignedMonths, ...opts });
  }

  routes(filter: RouteFilter & { basis?: DepartureBasis; sortBy?: RouteSort; limit?: number }): RouteRow[] {
    const origins = filter.origins;
    const source = origins ? origins.flatMap((o) => this.store.segmentsByOrigin.get(o) ?? []) : this.store.segments;
    return queryRoutes(source, { months: this.store.alignedMonths, ...filter });
  }

  /** Filter, sort and compare airports on any metric, within a scope. */
  async screen(scope: Scope & ScreenQuery & { minPassengers?: number }): Promise<{ scope: string; scopeIssues: readonly string[]; result: ScreenResult; meta: AnalysisMeta }> {
    const { airports, description, issues } = this.selectAirports(scope);
    const { metrics, meta } = await this.metricsFor(airports);
    const min = scope.minPassengers ?? 0;
    const rows = metrics.map(toScreenRow).filter((r) => r.passengers12m !== undefined && r.passengers12m >= min);
    return { scope: description, scopeIssues: issues, result: screen(rows, scope), meta };
  }

  /** FAA facility data and runway usage for airports: coordinates, runways, tower type and departures per commercial runway. */
  async infrastructure(codes: readonly string[]): Promise<{
    airports: Array<{ airport: AirportRecord; runwayInfo: RunwayInfo | undefined; departuresLatest12m: number | undefined; departuresPerRunwayDay: number | undefined }>;
    faaEffectiveDate: string | undefined;
    meta: AnalysisMeta;
  }> {
    const records = this.require(codes);
    const { metrics, meta } = await this.metricsFor(records);
    return {
      airports: metrics.map((m, i) => ({ airport: records[i] as AirportRecord, runwayInfo: m.runway, departuresLatest12m: m.traffic.current.departures, departuresPerRunwayDay: m.departuresPerRunwayDay })),
      faaEffectiveDate: this.store.airportsFile.faaEffectiveDate,
      meta,
    };
  }

  /** Current FAA NAS status (live). With `codes`, only events for those airports; without, every reported event. */
  async currentDisruptions(codes?: readonly string[]): Promise<{ snapshot: NasSnapshot; events: readonly NasEvent[]; retrievedAt: string; note: string | undefined }> {
    const nas = this.deps.nas;
    if (!nas?.current) throw new AnalyticsError('live FAA status is not configured');
    const { data, provenance } = await nas.current();
    const wanted = codes ? new Set(codes) : undefined;
    return { snapshot: data, events: wanted ? data.events.filter((e) => wanted.has(e.airport)) : data.events, retrievedAt: provenance.retrievedAt, note: provenance.note };
  }

  async demandPressure(code: string): Promise<{ profile: DemandPressureProfile; liveStatus: { events: readonly NasEvent[] } | { unavailable: string }; meta: AnalysisMeta }> {
    const [airport] = this.require([code]) as [AirportRecord];
    const all = this.selectAirports({}).airports;
    const { metrics, rows, meta } = await this.metricsFor(all);
    const target = metrics.find((m) => m.code === airport.code);
    if (!target) throw new AnalyticsError(`no traffic data for ${code}`);
    const peers = metrics.filter((m) => (m.traffic.current.passengers ?? 0) >= PEER_MIN_PASSENGERS);
    const profile = demandPressureProfile(target, peers, rows, `U.S. airports with at least ${PEER_MIN_PASSENGERS.toLocaleString('en-US')} passengers in the latest 12 months`);
    let liveStatus: { events: readonly NasEvent[] } | { unavailable: string };
    try {
      liveStatus = this.deps.nas ? { events: (await this.deps.nas.forAirport(airport.code)).data } : { unavailable: 'live FAA status not configured' };
    } catch (err) {
      liveStatus = { unavailable: (err as Error).message };
    }
    return { profile, liveStatus, meta };
  }
}
