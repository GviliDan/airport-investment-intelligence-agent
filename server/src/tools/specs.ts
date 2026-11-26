import { z } from 'zod';
import { AnalyticsError, type AnalysisMeta } from '../analytics/service.js';
import { METRIC_DEFINITIONS, METHOD_NOTES, READING_GUIDE, type MetricId, type OpportunityRanking } from '../analytics/scoring.js';
import { SCREEN_METRICS, type ScreenMetric } from '../analytics/screen.js';
import { SERVICE_CLASS_LABELS } from '../analytics/routes.js';
import { MIN_COMMERCIAL_RUNWAY_FT, MIN_ONTIME_COVERAGE } from '../analytics/operations.js';
import { DEFAULT_LONG_HAUL_MILES } from '../analytics/routes.js';
import { buildScope, intLimit, monthArg, offsetArg, REGION_NAMES, resolveAirports, scopeShape, serviceClassArg, airportRef, type ToolContext } from './common.js';
import { fail, paginate, STANDARD_LIMITATIONS, sourcesOf, succeed, type ToolOutput } from './envelope.js';

export interface ToolSpec<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  readonly run: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolOutput>;
  /** Trims a successful result before it is shown to the model; the full result still goes to the UI. */
  readonly slim?: (output: ToolOutput) => ToolOutput;
}

/**
 * Schemas are strict: an argument the tool does not know is an error, never silently ignored. Otherwise a mistyped parameter
 * such as `state` for `states` would drop the geographic scope and quietly widen the query to the whole country.
 */
const spec = <S extends z.ZodObject<z.ZodRawShape>>(s: ToolSpec<S>): ToolSpec<S> => ({ ...s, schema: s.schema.strict() as unknown as S });

const periodsOf = (meta: Pick<AnalysisMeta, 'asOf' | 'operationalMonths'>, extra: Record<string, string> = {}): Record<string, string> => ({
  ...(meta.asOf ? { passengerData: `latest month ${meta.asOf}` } : {}),
  operations: meta.operationalMonths.join(', '),
  ...extra,
});

const WINDOW = z.number().int().min(1).max(36).optional().describe('Window in months (default 12), compared with the same months a year earlier.');
const OPS_LIMITS = [
  'Delay, cancellation and taxi-out figures cover June-August only and BTS reporting carriers only; see each airport\'s on-time coverage.',
  'Delays and taxi times describe airfield and airline operations. They are not evidence of terminal capacity constraints.',
];

/* -------------------------------------------------------------------------- resolve_airport */

const resolveAirport = spec({
  name: 'resolve_airport',
  description:
    'Look up a US airport by code, city or name. Returns found, ambiguous (candidates, busiest first; never pick one yourself) or not_found.',
  schema: z.object({
    query: z.string().min(1).max(80).describe('Code or name.'),
    state: z.string().min(2).optional().describe('Optional state, e.g. "ME".'),
  }),
  run: async ({ query, state }, ctx) => {
    const r = ctx.store.airports.resolve(query, state ? { state } : {});
    const pick = (a: { code: string; name?: string | undefined; city?: string | undefined; state?: string | undefined; lat?: number | undefined; lon?: number | undefined; faaMatched: boolean }) => ({ code: a.code, name: a.name, city: a.city, state: a.state, faaMatched: a.faaMatched, ...(a.lat !== undefined ? { latitude: a.lat, longitude: a.lon } : {}) });
    const base = { sources: ['FAA Aviation Facilities (NTAD ArcGIS) joined to BTS airport identities, committed snapshot'], periods: { faaData: ctx.store.airportsFile.faaEffectiveDate ?? 'unknown' }, assumptions: [] as string[], limitations: ['Only airports with BTS traffic records are searchable. Some small airports have no FAA match (no coordinates or runways).'] };
    if (r.status === 'found') return succeed('resolve_airport', { status: 'found' as const, matchedBy: r.matchedBy, airport: pick(r.airport) }, base);
    if (r.status === 'ambiguous') {
      return succeed('resolve_airport', { status: 'ambiguous' as const, reason: r.reason, candidates: r.candidates.map(pick), suggested: r.suggested?.code, orderedBy: 'passengers in the latest 12 months' }, { ...base, warnings: ['Several airports match. Do not choose for the user without saying so.'] });
    }
    return succeed('resolve_airport', { status: 'not_found' as const, reason: r.reason }, base);
  },
});

/* -------------------------------------------------------------------------- find_airports */

const findAirports = spec({
  name: 'find_airports',
  description:
    'List US airports in a scope (states, region, radius or airport list) with FAA match status. No traffic metrics: use screen_airports for those. No scope = all US airports.',
  schema: z.object({ ...scopeShape, limit: intLimit(25, 100), offset: offsetArg }),
  run: async (args, ctx) => {
    const s = buildScope('find_airports', args, ctx);
    if ('ok' in s) return s;
    const sel = ctx.service.selectAirports(s.scope);
    if (sel.issues.some((i) => i.startsWith('unknown state'))) return fail('find_airports', 'unsupported_scope', sel.issues.join('; '));
    const sorted = [...sel.airports].sort((a, b) => a.code.localeCompare(b.code));
    const { items, page } = paginate(sorted, args.limit, args.offset);
    return succeed(
      'find_airports',
      { scope: sel.description, airports: items.map((a) => ({ code: a.code, name: a.name, city: a.city, state: a.state, scheduledService: a.scheduledService, faaMatched: a.faaMatched, ...(a.lat !== undefined ? { latitude: a.lat, longitude: a.lon } : {}) })) },
      {
        page, sources: ['FAA Aviation Facilities (NTAD ArcGIS) and BTS airport identities, committed snapshot'], periods: { faaData: ctx.store.airportsFile.faaEffectiveDate ?? 'unknown' },
        assumptions: ['Listed in code order; this list says nothing about airport size.'],
        limitations: ['Airports without an FAA match have no coordinates, so a radius search cannot include them.'],
        ...(sel.issues.length ? { warnings: sel.issues } : {}),
      },
    );
  },
});

/* -------------------------------------------------------------------------- get_traffic_metrics */

const getTrafficMetrics = spec({
  name: 'get_traffic_metrics',
  description:
    'Passengers, seats, departures, growth, seat load factor and passenger-vs-seat growth gap for 1-8 airports over a window (default 12 months vs the same months a year earlier; window_months 3 for recent trends). Load factor is aircraft fullness, not congestion.',
  schema: z.object({
    airports: z.array(airportRef).min(1).max(8).describe('One to eight airports (codes or names).'),
    window_months: WINDOW,
    comparison: z.enum(['year_over_year', 'previous_period']).optional().describe('year_over_year (default) or previous_period.'),
    end_month: monthArg.optional().describe('Last month, YYYY-MM (default latest).'),
  }),
  run: async (args, ctx) => {
    const r = resolveAirports('get_traffic_metrics', args.airports, ctx);
    if ('ok' in r) return r;
    const results = [];
    for (const code of r.codes) {
      results.push(await ctx.service.trafficGrowth(code, { ...(args.window_months ? { windowMonths: args.window_months } : {}), ...(args.comparison ? { baseline: args.comparison === 'year_over_year' ? 'year-over-year' : 'previous-period' } : {}), ...(args.end_month ? { endMonth: args.end_month } : {}) }));
    }
    const first = results[0];
    if (!first) return fail('get_traffic_metrics', 'invalid_arguments', 'no airports given');
    const a = first.analysis;
    return succeed(
      'get_traffic_metrics',
      { airports: results.map((x) => x.analysis), units: { passengers: 'passengers', seats: 'seats', departures: 'aircraft departures', loadFactor: 'fraction (0.8 = 80%)', growth: 'pct is a fraction (0.05 = +5%)', gap: 'percentage points' } },
      {
        periods: { current: `${a.current.from}..${a.current.to}`, baseline: `${a.baseline.from}..${a.baseline.to}`, comparison: a.baselineKind },
        sources: sourcesOf(first.meta).slice(0, 1),
        assumptions: ['Load factor is passengers / seats over the whole window.', 'A window with a month missing for an airport reports no totals or growth for it; see `issues`.'],
        limitations: ['T-100 counts all carriers, scheduled and non-scheduled, passengers and cargo flights; seats are capacity offered, not demand.', 'Load factor is not terminal or runway congestion.'],
        coverage: results.map((x) => ({ airport: x.analysis.airport, complete: x.analysis.current.complete && x.analysis.baseline.complete, issues: x.analysis.issues })),
        ...(first.meta.traffic.mode !== 'live' ? { warnings: [`Traffic data came from the committed snapshot (${first.meta.traffic.mode}).`] } : {}),
      },
    );
  },
});

/* -------------------------------------------------------------------------- screen_airports */

const filterSchema = z.object({
  metric: z.enum(SCREEN_METRICS as unknown as [ScreenMetric, ...ScreenMetric[]]).describe('Metric.'),
  min: z.number().optional().describe('At least.'),
  max: z.number().optional().describe('At most.'),
});

const screenAirports = spec({
  name: 'screen_airports',
  description:
    'Filter, sort and compare US airports on metrics: passengers, growth, load factor, departures per runway, destinations, international share, taxi-out, delays, cancellations. Scope by states, region, radius or airport list (none = all US). Paged. Airports lacking a filtered metric are reported, not treated as zero.',
  schema: z.object({
    ...scopeShape,
    min_passengers: z.number().min(0).optional().describe('Minimum passengers in the latest 12 months.'),
    filters: z.array(filterSchema).max(8).optional().describe('Range filters (all must match).'),
    sort_by: z.enum(SCREEN_METRICS as unknown as [ScreenMetric, ...ScreenMetric[]]).optional().describe('Sort by this metric.'),
    descending: z.boolean().optional().describe('High to low (default true).'),
    limit: intLimit(15, 50),
    offset: offsetArg,
  }),
  run: async (args, ctx) => {
    const s = buildScope('screen_airports', args, ctx);
    if ('ok' in s) return s;
    const res = await ctx.service.screen({ ...s.scope, ...(args.min_passengers !== undefined ? { minPassengers: args.min_passengers } : {}), ...(args.filters ? { filters: args.filters } : {}), ...(args.sort_by ? { sortBy: args.sort_by } : {}), ...(args.descending !== undefined ? { descending: args.descending } : {}) });
    if (res.scopeIssues.some((i) => i.startsWith('unknown state'))) return fail('screen_airports', 'unsupported_scope', res.scopeIssues.join('; '));
    const { items, page } = paginate(res.result.rows, args.limit, args.offset);
    const missing = res.result.missingMetric;
    return succeed(
      'screen_airports',
      {
        scope: res.scope,
        rows: items,
        units: { passengers12m: 'passengers', growthPct: 'percent', loadFactorPct: 'percent', gapPoints: 'percentage points', delay_cancellation: 'percent of departures', taxiOut: 'minutes', departuresPerRunwayDay: 'departures per commercial runway per day' },
        airportsMissingAFilteredOrSortedMetric: { count: missing.length, examples: missing.slice(0, 15) },
      },
      {
        page,
        periods: periodsOf(res.meta, { growthAndLoadFactor: 'latest 12 months vs same months a year earlier' }),
        sources: sourcesOf(res.meta),
        assumptions: ['Operational columns (taxi-out, delay, cancellation) are blank for airports whose on-time data covers under 50% of scheduled passenger departures.', 'Departures per runway counts runways of at least 5,000 ft.'],
        limitations: [...STANDARD_LIMITATIONS, ...OPS_LIMITS],
        coverage: { airportsMatched: res.result.matched },
        ...(res.scopeIssues.length ? { warnings: res.scopeIssues } : {}),
      },
    );
  },
});

/* -------------------------------------------------------------------------- compare_operations */

const compareOperations = spec({
  name: 'compare_operations',
  description:
    'Compare 2-5 airports: delayed-departure and cancellation rates, median taxi-out, departures per runway, on-time data coverage, live FAA status. Differences are called only beyond sampling noise. No single congestion score; delays are not evidence of terminal capacity.',
  schema: z.object({ airports: z.array(airportRef).min(2).max(5).describe('Two to five airports (codes or names) to compare.') }),
  run: async ({ airports }, ctx) => {
    const r = resolveAirports('compare_operations', airports, ctx);
    if ('ok' in r) return r;
    if (r.codes.length < 2) return fail('compare_operations', 'invalid_arguments', 'The references resolve to fewer than two distinct airports.');
    const out = await ctx.service.compareOperations(r.codes);
    return succeed(
      'compare_operations',
      {
        airports: out.airports.map((a) => ({
          code: a.metrics.code, name: a.metrics.name, state: a.metrics.state,
          operations: a.metrics.operations,
          airfield: { commercialRunways: a.metrics.runway?.commercialRunways, longestRunwayFt: a.metrics.runway?.longestFt, departuresPerCommercialRunwayPerDay: a.metrics.departuresPerRunwayDay },
          currentFaaStatus: a.liveStatus,
        })),
        comparisons: out.comparisons,
        units: { rates: 'fractions (0.24 = 24%)', delay: 'minutes', taxiOut: 'minutes' },
      },
      {
        periods: periodsOf(out.meta),
        sources: [...sourcesOf(out.meta).slice(1), 'FAA NAS Status (live) for current disruptions'],
        assumptions: [`Operational figures are marked unreliable when on-time data covers under ${MIN_ONTIME_COVERAGE * 100}% of scheduled passenger departures.`, `Runways shorter than ${MIN_COMMERCIAL_RUNWAY_FT} ft are not counted as commercial.`],
        limitations: [...OPS_LIMITS, 'Current FAA status is a live snapshot of now, not part of the June-August statistics.'],
        coverage: out.airports.map((a) => ({ airport: a.metrics.code, onTimeCoverage: a.metrics.operations.coverage, reliable: a.metrics.operations.reliable })),
      },
    );
  },
});

/* -------------------------------------------------------------------------- route tools */

const getRouteNetwork = spec({
  name: 'get_route_network',
  description:
    'Nonstop route network of one airport: destinations, international share, busiest routes (Jun-Aug 2026).',
  schema: z.object({ airport: airportRef.describe('The origin airport (code or name).'), service_classes: serviceClassArg, top_routes: z.number().int().min(1).max(25).default(10).describe('How many of the busiest routes to list (default 10).') }),
  run: async (args, ctx) => {
    const r = resolveAirports('get_route_network', [args.airport], ctx);
    if ('ok' in r) return r;
    const n = ctx.service.network(r.codes[0] as string, { ...(args.service_classes ? { classes: args.service_classes } : {}), top: args.top_routes });
    return succeed('get_route_network', n, {
      periods: { routes: n.months.join(', ') },
      sources: ['BTS T-100 Segment (All Carriers), committed monthly aggregate'],
      assumptions: [`Service classes: ${(args.service_classes ?? ['F']).map((c) => `${c} (${SERVICE_CLASS_LABELS[c]})`).join(', ')}.`, 'Counts performed departures of all carriers including foreign carriers.'],
      limitations: ['Covers three months, so seasonal routes outside June-August are not seen.', 'Distances are great-circle statute miles.'],
    });
  },
});

const searchRoutes = spec({
  name: 'search_routes',
  description:
    'Search nonstop routes by origin, destination, distance, service class and domestic/international; sort by departures, seats, passengers or distance. Paged.',
  schema: z.object({
    origins: z.array(airportRef).max(10).optional().describe('Origin airports (codes or names).'),
    destinations: z.array(airportRef).max(10).optional().describe('Destination airports (codes or names).'),
    min_miles: z.number().min(0).optional().describe('Minimum miles.'),
    max_miles: z.number().min(1).optional().describe('Maximum miles (exclusive).'),
    service_classes: serviceClassArg,
    destination_type: z.enum(['domestic', 'international', 'any']).optional().describe('Domestic = US or territories.'),
    basis: z.enum(['performed', 'scheduled']).optional().describe('performed (default) or scheduled departures.'),
    sort_by: z.enum(['departures', 'seats', 'passengers', 'distance']).optional().describe('Sort field (default departures).'),
    limit: intLimit(15, 50),
    offset: offsetArg,
  }),
  run: async (args, ctx) => {
    let origins: string[] | undefined;
    let dests: string[] | undefined;
    if (args.origins?.length) {
      const r = resolveAirports('search_routes', args.origins, ctx);
      if ('ok' in r) return r;
      origins = r.codes;
    }
    if (args.destinations?.length) {
      const r = resolveAirports('search_routes', args.destinations, ctx);
      if ('ok' in r) return r;
      dests = r.codes;
    }
    if (!origins && !dests && args.min_miles === undefined && args.max_miles === undefined) {
      return fail('search_routes', 'invalid_arguments', 'Give at least an origin, a destination or a distance bound; an unrestricted route search is too broad.');
    }
    const rows = ctx.service.routes({ ...(origins ? { origins } : {}), ...(dests ? { dests } : {}), ...(args.min_miles !== undefined ? { minMiles: args.min_miles } : {}), ...(args.max_miles !== undefined ? { maxMiles: args.max_miles } : {}), ...(args.service_classes ? { classes: args.service_classes } : {}), ...(args.destination_type ? { destinations: args.destination_type } : {}), ...(args.basis ? { basis: args.basis } : {}), ...(args.sort_by ? { sortBy: args.sort_by } : {}) });
    const { items, page } = paginate(rows, args.limit, args.offset);
    return succeed('search_routes', { routes: items, units: { distanceMiles: 'statute miles', departures: 'aircraft departures', seats: 'seats', passengers: 'passengers', loadFactor: 'fraction' } }, {
      page,
      periods: { routes: ctx.store.alignedMonths.join(', ') },
      sources: ['BTS T-100 Segment (All Carriers), committed monthly aggregate'],
      assumptions: [`Service classes: ${(args.service_classes ?? ['F']).join(', ')} (F = scheduled passenger/cargo).`, `Departures counted: ${args.basis ?? 'performed'}.`],
      limitations: ['Three months only.', 'Totals sum all carriers on the route.'],
    });
  },
});

const getLongHaulShare = spec({
  name: 'get_long_haul_share',
  description:
    `Share of an airport's departures on routes of at least a distance threshold (default 3,000 miles), measured from BTS T-100 Jun-Aug 2026, with sensitivity to the threshold and to the service-class definition (scheduled passenger/cargo vs all classes, each with its own total). "Long haul" has no standard definition: state the threshold and service class.`,
  schema: z.object({
    airport: airportRef.describe('The origin airport (code or name).'),
    threshold_miles: z.number().min(1).max(10000).optional().describe(`Miles at or above which a route is long haul (default ${DEFAULT_LONG_HAUL_MILES}).`),
    service_classes: serviceClassArg,
    basis: z.enum(['performed', 'scheduled']).optional().describe('performed (default) or scheduled departures.'),
  }),
  run: async (args, ctx) => {
    const r = resolveAirports('get_long_haul_share', [args.airport], ctx);
    if ('ok' in r) return r;
    const out = ctx.service.longHaul(r.codes[0] as string, { ...(args.threshold_miles ? { thresholdMiles: args.threshold_miles } : {}), ...(args.service_classes ? { classes: args.service_classes } : {}), ...(args.basis ? { basis: args.basis } : {}) });
    const { meta, notes, ...data } = out;
    return succeed('get_long_haul_share', data, {
      periods: { departures: out.months.join(', ') },
      sources: ['BTS T-100 Segment (All Carriers), committed monthly aggregate'],
      assumptions: [...notes],
      limitations: ['Three summer months only; seasonality outside June-August is not captured.', 'A measurement of departures, not passengers.'],
      ...(out.share === undefined ? { warnings: ['No departures of the selected kind, so no share can be computed (this is not 0%).'] } : {}),
    });
  },
});

/* -------------------------------------------------------------------------- infrastructure */

const getAirportInfrastructure = spec({
  name: 'get_airport_infrastructure',
  description:
    'FAA facts for 1-8 airports: coordinates, tower type, runways, commercial runway count, departures per runway per day. No terminal or gate data exists.',
  schema: z.object({ airports: z.array(airportRef).min(1).max(8).describe('One to eight airports (codes or names).') }),
  run: async ({ airports }, ctx) => {
    const r = resolveAirports('get_airport_infrastructure', airports, ctx);
    if ('ok' in r) return r;
    const out = await ctx.service.infrastructure(r.codes);
    return succeed(
      'get_airport_infrastructure',
      {
        airports: out.airports.map((a) => ({
          code: a.airport.code, name: a.airport.name, city: a.airport.city, state: a.airport.state,
          faaMatched: a.airport.faaMatched, faaId: a.airport.faaId, ...(a.airport.faaIssue ? { faaIssue: a.airport.faaIssue } : {}),
          latitude: a.airport.lat, longitude: a.airport.lon, elevationFt: a.airport.elevationFt, towerType: a.airport.towerType, scheduledAirCarrierService: a.airport.scheduledService,
          runways: a.airport.runways, commercialRunways: a.runwayInfo?.commercialRunways, longestRunwayFt: a.runwayInfo?.longestFt,
          departuresLatest12m: a.departuresLatest12m, departuresPerCommercialRunwayPerDay: a.departuresPerRunwayDay,
        })),
      },
      {
        periods: { faaData: out.faaEffectiveDate ?? 'unknown', departures: out.meta.asOf ? `12 months to ${out.meta.asOf}` : 'unknown' },
        sources: ['FAA Aviation Facilities and Runways (NTAD ArcGIS), committed snapshot', ...sourcesOf(out.meta).slice(0, 1)],
        assumptions: [`A runway counts as commercial if it is at least ${MIN_COMMERCIAL_RUNWAY_FT} ft long.`, 'Runway count includes every runway on the FAA record, whatever its status.'],
        limitations: ['Terminal size, gates and passenger-processing capacity are not available, so no terminal constraint can be shown.', 'Airports with no FAA match have no runway data (faaIssue explains why).'],
      },
    );
  },
});

/* -------------------------------------------------------------------------- demand pressure */

const analyzeDemandPressure = spec({
  name: 'analyze_demand_pressure',
  description:
    'Demand-pressure indicators for one airport against peers with 5M+ passengers: load factor, passenger vs seat growth, taxi-out, delays, monthly load factor. NOT unmet demand, which public data cannot measure.',
  schema: z.object({ airport: airportRef.describe('The airport (code or name).') }),
  run: async ({ airport }, ctx) => {
    const r = resolveAirports('analyze_demand_pressure', [airport], ctx);
    if ('ok' in r) return r;
    const out = await ctx.service.demandPressure(r.codes[0] as string);
    const { limitations, ...profile } = out.profile;
    return succeed(
      'analyze_demand_pressure',
      { ...profile, currentFaaStatus: out.liveStatus, units: { percentiles: '0-100 position among peers; 100 = highest' } },
      {
        periods: periodsOf(out.meta, { trafficIndicators: `12 months to ${out.profile.asOf}` }),
        sources: sourcesOf(out.meta),
        assumptions: ['Peer group: ' + out.profile.peerGroup.definition, 'An indicator "stands out" at or above the 75th peer percentile; that is a descriptive cut, not a threshold of unmet demand.'],
        limitations: [...limitations, ...OPS_LIMITS],
        warnings: ['measuredUnmetDemand is null: it cannot be measured with public data. Do not present these indicators as unmet demand.'],
      },
    );
  },
});

/* -------------------------------------------------------------------------- ranking */

const weightField = (what: string) => z.number().min(0).max(100).optional().describe(`Weight for ${what}; 0 disables.`);

const rankExpansionOpportunities = spec({
  name: 'rank_expansion_opportunities',
  description:
    'Rank US airports in a scope for expansion screening with a percentile score (scale, growth, load factor, passenger-vs-seat gap, runway use, taxi-out). Weights, thresholds, correlation and missing-data handling are configurable. Scores are relative to the candidates; not ROI or proof of a terminal constraint. No scope = all US airports.',
  schema: z.object({
    ...scopeShape,
    weights: z
      .object({
        scale: weightField('passenger scale (default 20)'),
        momentum: weightField('passenger growth, shrunk for small airports (default 25)'),
        load_factor: weightField('seat load factor (default 15)'),
        capacity_gap: weightField('passenger growth minus seat growth (default 15)'),
        runway_load: weightField('departures per commercial runway per day (default 15)'),
        taxi_out: weightField('median taxi-out minutes (default 10)'),
        departure_delay: weightField('share of departures delayed 15+ min (default 0; weather and airlines drive most delays)'),
      })
      .strict()
      .optional()
      .describe('Overrides; omitted metrics keep defaults.'),
    min_passengers: z.number().min(0).optional().describe('Candidate minimum passengers, latest 12 months (default 100,000).'),
    window_months: WINDOW,
    correlation_adjustment: z.boolean().optional().describe('Default true: overlapping metrics are down-weighted. false uses weights as given.'),
    missing_data_policy: z.enum(['neutral', 'redistribute']).optional().describe('neutral (default): a missing metric counts as the median; redistribute: its weight moves to the other metrics.'),
    top_n: z.number().int().min(1).max(50).default(10).describe('Airports to return (default 10).'),
  }),
  run: async (args, ctx) => {
    const s = buildScope('rank_expansion_opportunities', args, ctx);
    if ('ok' in s) return s;
    const w = args.weights;
    const weights: Partial<Record<MetricId, number>> | undefined = w
      ? {
          ...(w.scale !== undefined ? { scale: w.scale } : {}), ...(w.momentum !== undefined ? { momentum: w.momentum } : {}), ...(w.load_factor !== undefined ? { loadFactor: w.load_factor } : {}),
          ...(w.capacity_gap !== undefined ? { capacityGap: w.capacity_gap } : {}), ...(w.runway_load !== undefined ? { runwayLoad: w.runway_load } : {}), ...(w.taxi_out !== undefined ? { taxiOut: w.taxi_out } : {}),
          ...(w.departure_delay !== undefined ? { departureDelay: w.departure_delay } : {}),
        }
      : undefined;
    try {
      const out = await ctx.service.rankOpportunities({
        ...s.scope, ...(weights ? { weights } : {}), ...(args.min_passengers !== undefined ? { minPassengers: args.min_passengers } : {}),
        ...(args.window_months ? { windowMonths: args.window_months } : {}), ...(args.correlation_adjustment !== undefined ? { correlationAdjustment: args.correlation_adjustment } : {}),
        ...(args.missing_data_policy ? { missingDataPolicy: args.missing_data_policy } : {}), topN: args.top_n,
      });
      if (out.scopeIssues.some((i) => i.startsWith('unknown state'))) return fail('rank_expansion_opportunities', 'unsupported_scope', out.scopeIssues.join('; '));
      const rk = out.ranking;
      return succeed('rank_expansion_opportunities', { scope: out.scope, ranking: rk }, {
        periods: { passengerWindow: rk.periods.passengerWindow ? `${rk.periods.passengerWindow.from}..${rk.periods.passengerWindow.to}` : 'n/a', baselineWindow: rk.periods.baselineWindow ? `${rk.periods.baselineWindow.from}..${rk.periods.baselineWindow.to}` : 'n/a', operations: rk.periods.operationalMonths.join(', ') },
        sources: sourcesOf(out.meta),
        assumptions: [...rk.method, ...rk.periods.notes, `Missing-data policy: ${rk.missingDataPolicy}.`],
        limitations: [...READING_GUIDE, ...STANDARD_LIMITATIONS, ...OPS_LIMITS],
        coverage: rk.candidateSet,
        warnings: [...rk.warnings, ...out.scopeIssues],
      });
    } catch (e) {
      if (e instanceof RangeError) return fail('rank_expansion_opportunities', 'invalid_arguments', e.message);
      throw e;
    }
  },
  /**
   * The model needs the reasoning (per-metric contributions, evidence, coverage), not every label and note: those stay in the full
   * result that the UI renders. Lists are trimmed to counts plus a few examples.
   */
  slim: (o) => {
    if (!o.ok) return o;
    const d = o.data as { scope: string; ranking: OpportunityRanking };
    const rk = d.ranking;
    const compact = {
      scope: d.scope,
      ranking: {
        asOf: rk.asOf,
        missingDataPolicy: rk.missingDataPolicy,
        weights: rk.weights,
        periods: { passengerWindow: rk.periods.passengerWindow, baselineWindow: rk.periods.baselineWindow, operationalMonths: rk.periods.operationalMonths },
        candidateSet: rk.candidateSet,
        ranked: rk.ranked.map((a, i) => ({
          rank: a.rank, code: a.code, name: a.name, state: a.state, score: a.score, scoreBounds: a.scoreBounds, rankRange: a.rankRange,
          // Per-metric detail only for the leaders; the full table is in the artifact the user sees.
          ...(i < 5 ? { contributions: a.contributions.map((c) => ({ metric: c.metric, raw: c.raw, ...(c.imputed ? { imputed: true } : {}), percentile: c.percentile, points: c.points })) } : {}),
          evidence: a.evidence,
          coverage: { weightCoverage: a.coverage.weightCoverage, onTimeCoverage: a.coverage.onTimeCoverage, faaMatched: a.coverage.faaMatched, missing: a.coverage.missing },
          flags: a.flags,
        })),
        unscored: { count: rk.unscored.length, examples: rk.unscored.slice(0, 10) },
        excluded: { count: rk.excluded.length, examples: rk.excluded.slice(0, 5) },
        correlationAdjustments: rk.correlationAdjustments.map((c) => ({ metric: c.metric, factor: c.factor, explanation: c.explanation })),
        diagnostics: rk.diagnostics,
        warnings: rk.warnings,
        readingGuide: rk.readingGuide,
        note: 'Metric definitions, the full method and period notes are in the complete result shown to the user; call get_methodology to quote them.',
      },
    };
    return { ...o, data: compact, assumptions: o.assumptions.slice(-2) };
  },
});

/* -------------------------------------------------------------------------- live disruptions */

const getCurrentFaaDisruptions = spec({
  name: 'get_current_faa_disruptions',
  description:
    'Live FAA disruptions right now (ground delay programs, ground stops, delays, closures), optionally for given airports. Current only, no history; closure notices may only restrict general aviation.',
  schema: z.object({ airports: z.array(airportRef).max(10).optional().describe('Only these airports; omit for all events.'), limit: intLimit(25, 100), offset: offsetArg }),
  run: async (args, ctx) => {
    let codes: string[] | undefined;
    if (args.airports?.length) {
      const r = resolveAirports('get_current_faa_disruptions', args.airports, ctx);
      if ('ok' in r) return r;
      codes = r.codes;
    }
    try {
      const out = await ctx.service.currentDisruptions(codes);
      const { items, page } = paginate(out.events, args.limit, args.offset);
      return succeed(
        'get_current_faa_disruptions',
        { faaUpdateTime: out.snapshot.updatedAt, events: items, ...(codes ? { airportsRequested: codes, noEventsReportedFor: codes.filter((c) => !out.events.some((e) => e.airport === c)) } : {}) },
        {
          page, periods: { current: `retrieved ${out.retrievedAt}` }, sources: ['FAA NAS Status (live)'],
          assumptions: ['Reasons and durations are quoted from the FAA feed, not interpreted, except where `interpretation` is given.'],
          limitations: ['"No events reported" means the FAA lists none right now; it does not mean operations are normal or delay-free.', 'No history is available from this source.'],
        },
      );
    } catch (e) {
      if (e instanceof AnalyticsError) return fail('get_current_faa_disruptions', 'data_unavailable', e.message);
      throw e;
    }
  },
});

/* -------------------------------------------------------------------------- methodology */

const getMethodology = spec({
  name: 'get_methodology',
  description:
    'Data sources and periods, metric definitions, score method, limitations and supported region names.',
  schema: z.object({ topic: z.enum(['all', 'data_sources', 'opportunity_score', 'metrics', 'regions']).default('all').describe('Which part to describe (default all).') }),
  run: async ({ topic }, ctx) => {
    const m = ctx.store.manifest;
    const data: Record<string, unknown> = {};
    if (topic === 'all' || topic === 'data_sources') {
      data.dataSources = { datasets: m.datasets, alignedOperationalMonths: ctx.store.alignedMonths, builtAt: m.generatedAt, faaEffectiveDate: ctx.store.airportsFile.faaEffectiveDate, liveSources: ['BTS Socrata API (traffic, used first at runtime)', 'FAA NAS Status (current disruptions)', 'FAA ArcGIS (facility data, committed snapshot; client available)'] };
    }
    if (topic === 'all' || topic === 'metrics' || topic === 'opportunity_score') data.metrics = METRIC_DEFINITIONS;
    if (topic === 'all' || topic === 'opportunity_score') data.opportunityScore = { method: METHOD_NOTES, readingGuide: READING_GUIDE };
    if (topic === 'all' || topic === 'regions') data.supportedRegions = { names: REGION_NAMES, note: 'Other areas must be passed as explicit states.' };
    return succeed('get_methodology', data, {
      periods: { operations: ctx.store.alignedMonths.join(', ') },
      sources: Object.values(m.datasets).map((d) => d.source),
      assumptions: ['Weights are analyst judgement, not statistically estimated; they are configurable.'],
      limitations: ['Terminal capacity, gate counts, financials and true unmet demand are outside the available data.'],
    });
  },
});

export const TOOL_SPECS = [
  resolveAirport, findAirports, getTrafficMetrics, screenAirports, compareOperations, getRouteNetwork, searchRoutes,
  getLongHaulShare, getAirportInfrastructure, analyzeDemandPressure, rankExpansionOpportunities, getCurrentFaaDisruptions, getMethodology,
] as const;
