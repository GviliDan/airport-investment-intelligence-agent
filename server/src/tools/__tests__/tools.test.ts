import { ToolMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AnalyticsService } from '../../analytics/service.js';
import { ProviderError } from '../../data/errors.js';
import type { NasEvent, NasSnapshot } from '../../data/faaNasStatus.js';
import { loadDataStore } from '../../data/store.js';
import { TrafficProvider } from '../../data/trafficProvider.js';
import { createTools, forModel, runTool, TOOL_SPECS, type ToolContext, type ToolFailure, type ToolOutput, type ToolSuccess } from '../index.js';

const store = await loadDataStore();
const NOW = () => new Date('2026-11-25T12:00:00Z');
const offlineProvider = new TrafficProvider({ live: { monthlyTraffic: async () => { throw new Error('not used'); } }, snapshot: store.traffic, useLive: false });
const EVENTS: NasEvent[] = [
  { airport: 'SFO', kind: 'ground-delay-program', reason: 'low ceilings', detail: { Avg: '54 minutes' } },
  { airport: 'LAX', kind: 'airport-closure', reason: '!LAX AD AP CLSD TO NON SKED TRANSIENT GA ACFT', detail: {}, interpretation: 'The notice text restricts general-aviation aircraft; it does not describe a closure to airline service.' },
];
const SNAPSHOT: NasSnapshot = { updatedAt: 'Wed Nov 25 15:01:06 2026 GMT', events: EVENTS };
const nas = {
  current: async () => ({ data: SNAPSHOT, provenance: { source: 'faa-nas-status', dataset: 'FAA NAS Status', retrievedAt: '2026-11-25T12:00:00.000Z' } }),
  forAirport: async (c: string) => ({ data: EVENTS.filter((e) => e.airport === c), provenance: { source: 'faa-nas-status', dataset: 'FAA NAS Status', retrievedAt: '2026-11-25T12:00:00.000Z' } }),
};
const service = new AnalyticsService({ store, traffic: offlineProvider, nas, now: NOW });
const ctx: ToolContext = { service, store };

const spec = (name: string) => {
  const s = TOOL_SPECS.find((t) => t.name === name);
  if (!s) throw new Error(`no tool ${name}`);
  return s as never;
};
const call = (name: string, args: unknown, c: ToolContext = ctx): Promise<ToolOutput> => runTool(spec(name), args, c);
async function ok<T = any>(name: string, args: unknown, c: ToolContext = ctx): Promise<ToolSuccess<T>> {
  const r = await call(name, args, c);
  if (!r.ok) throw new Error(`${name} failed: ${r.error.code} ${r.error.message}`);
  return r as ToolSuccess<T>;
}
async function failure(name: string, args: unknown, c: ToolContext = ctx): Promise<ToolFailure> {
  const r = await call(name, args, c);
  if (r.ok) throw new Error(`${name} unexpectedly succeeded`);
  return r;
}
/** What the UI receives after JSON transport. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('tool registry and schemas', () => {
  it('exposes the thirteen general-purpose tools with unique snake_case names and real descriptions', () => {
    const names = TOOL_SPECS.map((t) => t.name);
    expect(names).toHaveLength(13);
    expect(new Set(names).size).toBe(13);
    for (const t of TOOL_SPECS) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(t.description.length).toBeGreaterThan(80);
      expect(t.description.length).toBeLessThan(1000);
    }
    for (const n of ['resolve_airport', 'find_airports', 'get_traffic_metrics', 'screen_airports', 'compare_operations', 'get_route_network', 'search_routes', 'get_long_haul_share', 'get_airport_infrastructure', 'analyze_demand_pressure', 'rank_expansion_opportunities', 'get_current_faa_disruptions', 'get_methodology']) {
      expect(names).toContain(n);
    }
  });
  it('is not tied to the assignment examples: no tool name or enumerated value names a specific airport or region', () => {
    const airportCodes = /\b(SFO|LAX|SNA|ANC|BOS)\b/;
    for (const t of TOOL_SPECS) {
      const enums = JSON.stringify(z.toJSONSchema(t.schema), (k, v) => (k === 'description' ? undefined : v));
      expect(`${t.name} ${enums}`).not.toMatch(airportCodes);
      expect(t.name).not.toMatch(/new_england|anchorage|expansion_new|santa_ana/);
    }
  });
  it('rejects unknown arguments instead of silently ignoring them (a mistyped scope must not widen the query)', async () => {
    const f = await failure('rank_expansion_opportunities', { state: 'MA' });
    expect(f.error.code).toBe('invalid_arguments');
    expect(f.error.message).toMatch(/state|Unrecognized/i);
    expect((await failure('find_airports', { airport_code: 'BOS' })).error.code).toBe('invalid_arguments');
  });
  it('produces JSON schemas free of keywords the Gemini API rejects', () => {
    const forbidden = ['exclusiveMinimum', 'exclusiveMaximum', '$ref', 'additionalProperties":{', 'propertyNames', 'patternProperties'];
    for (const t of TOOL_SPECS) {
      const text = JSON.stringify(z.toJSONSchema(t.schema));
      for (const k of forbidden) expect(text, `${t.name} uses ${k}`).not.toContain(k);
    }
  });
  it('every parameter has a description the model can read', () => {
    for (const t of TOOL_SPECS) {
      const schema = z.toJSONSchema(t.schema) as { properties?: Record<string, { description?: string; type?: string; properties?: Record<string, { description?: string }> }> };
      for (const [k, v] of Object.entries(schema.properties ?? {})) {
        const described = v.description !== undefined || (v.properties && Object.values(v.properties).every((p) => p.description));
        expect(described, `${t.name}.${k}`).toBeTruthy();
      }
    }
  });
  it('wraps each spec as a LangChain tool', () => {
    const tools = createTools(ctx);
    expect(tools.map((t) => t.name)).toEqual(TOOL_SPECS.map((t) => t.name));
  });
});

describe('every successful result carries sources, periods, assumptions and limitations', () => {
  const CASES: Array<[string, unknown]> = [
    ['resolve_airport', { query: 'SNA' }],
    ['find_airports', { states: ['VT'] }],
    ['get_traffic_metrics', { airports: ['LAX'] }],
    ['screen_airports', { states: ['OR'], limit: 3 }],
    ['compare_operations', { airports: ['LAX', 'SNA'] }],
    ['get_route_network', { airport: 'ANC' }],
    ['search_routes', { origins: ['DEN'], min_miles: 3000, limit: 3 }],
    ['get_long_haul_share', { airport: 'ANC' }],
    ['get_airport_infrastructure', { airports: ['SFO'] }],
    ['analyze_demand_pressure', { airport: 'SFO' }],
    ['rank_expansion_opportunities', { states: ['VT', 'NH'], top_n: 3 }],
    ['get_current_faa_disruptions', {}],
    ['get_methodology', {}],
  ];
  for (const [name, args] of CASES) {
    it(name, async () => {
      const r = await ok(name, args);
      expect(r.tool).toBe(name);
      expect(Array.isArray(r.sources)).toBe(true);
      expect(r.sources.length).toBeGreaterThan(0);
      expect(Object.keys(r.periods).length).toBeGreaterThan(0);
      expect(Array.isArray(r.assumptions)).toBe(true);
      expect(r.limitations.length).toBeGreaterThan(0);
      expect(() => JSON.stringify(r)).not.toThrow();
    });
  }
});

describe('resolve_airport', () => {
  it('resolves a code and a unique city', async () => {
    expect((await ok('resolve_airport', { query: 'lax' })).data).toMatchObject({ status: 'found', matchedBy: 'code', airport: { code: 'LAX' } });
    expect((await ok('resolve_airport', { query: 'Santa Ana' })).data).toMatchObject({ status: 'found', airport: { code: 'SNA' } });
  });
  it('preserves ambiguity and never picks for the user', async () => {
    const r = await ok('resolve_airport', { query: 'New York' });
    expect(r.data).toMatchObject({ status: 'ambiguous' });
    expect(r.data.candidates.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['JFK', 'LGA']));
    expect(r.data.airport).toBeUndefined();
    expect(r.warnings?.join(' ')).toMatch(/Do not choose/);
    const anc = await ok('resolve_airport', { query: 'Anchorage' });
    expect(anc.data).toMatchObject({ status: 'ambiguous', suggested: 'ANC' });
  });
  it('narrows with a state and reports not-found and too-short queries', async () => {
    expect((await ok('resolve_airport', { query: 'Portland', state: 'ME' })).data).toMatchObject({ status: 'found', airport: { code: 'PWM' } });
    expect((await ok('resolve_airport', { query: 'LA' })).data).toMatchObject({ status: 'not_found' });
    expect((await ok('resolve_airport', { query: 'Gotham' })).data).toMatchObject({ status: 'not_found' });
    expect((await ok('resolve_airport', { query: 'Portland', state: 'Narnia' })).data).toMatchObject({ status: 'not_found', reason: expect.stringContaining('unknown state') });
  });
  it('rejects invalid arguments', async () => {
    expect((await failure('resolve_airport', { query: '' })).error.code).toBe('invalid_arguments');
    expect((await failure('resolve_airport', {})).error.code).toBe('invalid_arguments');
    expect((await failure('resolve_airport', { query: 5 })).error.code).toBe('invalid_arguments');
  });
});

describe('find_airports and geographic scopes', () => {
  it('lists airports by state, Census region, radius and explicit list', async () => {
    const vt = await ok('find_airports', { states: ['VT'] });
    expect(vt.data.airports.map((a: { code: string }) => a.code)).toContain('BTV');
    expect(vt.data.airports.every((a: { state: string }) => a.state === 'VT')).toBe(true);
    const ne = await ok('find_airports', { region: 'New England', limit: 100 });
    expect(ne.data.scope).toBe('states CT, ME, MA, NH, RI, VT');
    expect(ne.data.airports.map((a: { code: string }) => a.code)).toContain('BOS');
    const near = await ok('find_airports', { near_airport: 'BOS', radius_miles: 60, limit: 100 });
    const codes = near.data.airports.map((a: { code: string }) => a.code);
    expect(codes).toContain('BOS');
    expect(codes).not.toContain('LAX');
    expect(near.data.scope).toMatch(/within 60 miles/);
    const pt = await ok('find_airports', { latitude: 45.59, longitude: -122.6, radius_miles: 30 });
    expect(pt.data.airports.map((a: { code: string }) => a.code)).toContain('PDX');
  });
  it('merges region and states, and combines scopes as an intersection', async () => {
    const merged = await ok('find_airports', { region: 'New England', states: ['NY'], limit: 100 });
    expect(merged.data.scope).toBe('states NY, CT, ME, MA, NH, RI, VT');
    const both = await ok('find_airports', { states: ['NH'], near_airport: 'BOS', radius_miles: 60, limit: 100 });
    expect(both.data.airports.every((a: { state: string }) => a.state === 'NH')).toBe(true);
  });
  it('pages deterministically', async () => {
    const p1 = await ok('find_airports', { states: ['CA'], limit: 5 });
    expect(p1.page).toMatchObject({ returned: 5, offset: 0, nextOffset: 5 });
    const p2 = await ok('find_airports', { states: ['CA'], limit: 5, offset: 5 });
    const codes1 = p1.data.airports.map((a: { code: string }) => a.code);
    const codes2 = p2.data.airports.map((a: { code: string }) => a.code);
    expect(codes1.filter((c: string) => codes2.includes(c))).toEqual([]);
    expect([...codes1, ...codes2]).toEqual([...codes1, ...codes2].slice().sort());
    const last = await ok('find_airports', { states: ['VT'], limit: 100 });
    expect(last.page?.nextOffset).toBeUndefined();
  });
  it('rejects unsupported and incomplete scopes explicitly', async () => {
    expect((await failure('find_airports', { states: ['Ontario'] })).error).toMatchObject({ code: 'unsupported_scope', message: expect.stringContaining('US airports only') });
    expect((await failure('find_airports', { states: ['Europe'] })).error.code).toBe('unsupported_scope');
    expect((await failure('find_airports', { region: 'Pacific Northwest' })).error.code).toBe('invalid_arguments');
    expect((await failure('find_airports', { near_airport: 'BOS' })).error.message).toMatch(/needs radius_miles/);
    expect((await failure('find_airports', { radius_miles: 50 })).error.message).toMatch(/needs a center/);
    expect((await failure('find_airports', { latitude: 42 })).error.message).toMatch(/together/);
    expect((await failure('find_airports', { near_airport: 'BOS', latitude: 1, longitude: 2, radius_miles: 5 })).error.message).toMatch(/not both/);
    expect((await failure('find_airports', { radius_miles: 99999, latitude: 1, longitude: 2 })).error.code).toBe('invalid_arguments');
  });
  it('refuses a radius center that has no coordinates', async () => {
    const f = await failure('find_airports', { near_airport: 'KLW', radius_miles: 50 });
    expect(f.error.code).toBe('data_unavailable');
  });
  it('never defaults to a region: with no scope it covers many states', async () => {
    const r = await ok('find_airports', { limit: 100 });
    expect(r.data.scope).toBe('all US airports with traffic data');
    expect(r.page?.total).toBeGreaterThan(1000);
  });
});

describe('get_traffic_metrics', () => {
  it('returns exactly what the analytics service computes', async () => {
    const r = await ok('get_traffic_metrics', { airports: ['LAX', 'SFO'] });
    const [lax, sfo] = await Promise.all([service.trafficGrowth('LAX'), service.trafficGrowth('SFO')]);
    expect(r.data.airports).toEqual(wire([lax.analysis, sfo.analysis]));
    expect(r.periods.current).toBe('2025-09..2026-08');
  });
  it('honours the window, comparison and end month', async () => {
    const r = await ok('get_traffic_metrics', { airports: ['LAX'], window_months: 3, comparison: 'previous_period' });
    const direct = await service.trafficGrowth('LAX', { windowMonths: 3, baseline: 'previous-period' });
    expect(r.data.airports[0]).toEqual(wire(direct.analysis));
    expect(r.periods).toMatchObject({ current: '2026-06..2026-08', baseline: '2026-03..2026-05' });
    const earlier = await ok('get_traffic_metrics', { airports: ['LAX'], window_months: 6, end_month: '2026-03' });
    expect(earlier.periods.current).toBe('2025-10..2026-03');
  });
  it('rejects ambiguous names without computing anything, and lists the candidates', async () => {
    const f = await failure('get_traffic_metrics', { airports: ['LAX', 'New York'] });
    expect(f.error.code).toBe('ambiguous_airport');
    expect(f.error.candidates?.[0]).toMatchObject({ input: 'New York' });
    expect(f.error.candidates?.[0]?.options.map((o) => o.code)).toEqual(expect.arrayContaining(['JFK', 'LGA']));
  });
  it('reports unknown airports and invalid arguments', async () => {
    expect((await failure('get_traffic_metrics', { airports: ['Gotham City Airport'] })).error.code).toBe('unknown_airport');
    expect((await failure('get_traffic_metrics', { airports: ['LAX'], end_month: '2026-13' })).error.code).toBe('invalid_arguments');
    expect((await failure('get_traffic_metrics', { airports: ['LAX'], window_months: 0 })).error.code).toBe('invalid_arguments');
    expect((await failure('get_traffic_metrics', { airports: [] })).error.code).toBe('invalid_arguments');
    expect((await failure('get_traffic_metrics', { airports: Array.from({ length: 9 }, () => 'LAX') })).error.code).toBe('invalid_arguments');
  });
  it('flags data that is not live', async () => {
    const r = await ok('get_traffic_metrics', { airports: ['LAX'] });
    expect(r.warnings?.join(' ')).toMatch(/committed snapshot/);
  });
});

describe('screen_airports', () => {
  it('returns the same rows as the analytics screen, paged', async () => {
    const q = { states: ['CA', 'OR', 'WA'], min_passengers: 1_000_000, filters: [{ metric: 'loadFactorPct', min: 80 }], sort_by: 'passengerGrowthPct', limit: 5 };
    const r = await ok('screen_airports', q);
    const direct = await service.screen({ states: ['CA', 'OR', 'WA'], minPassengers: 1_000_000, filters: [{ metric: 'loadFactorPct', min: 80 }], sortBy: 'passengerGrowthPct' });
    expect(r.data.rows).toEqual(wire(direct.result.rows.slice(0, 5)));
    expect(r.page?.total).toBe(direct.result.rows.length);
  });
  it('supports dynamic filters across the whole country and ascending sorts', async () => {
    const r = await ok('screen_airports', { min_passengers: 5_000_000, filters: [{ metric: 'medianTaxiOutMin', min: 20 }], sort_by: 'medianTaxiOutMin', descending: false, limit: 50 });
    const taxi = r.data.rows.map((x: { medianTaxiOutMin: number }) => x.medianTaxiOutMin);
    expect(taxi.length).toBeGreaterThan(0);
    expect([...taxi].sort((a: number, b: number) => a - b)).toEqual(taxi);
    expect(taxi.every((t: number) => t >= 20)).toBe(true);
  });
  it('reports airports lacking a filtered metric instead of treating them as zero', async () => {
    const r = await ok('screen_airports', { airport_codes: ['GUM', 'LAX'], filters: [{ metric: 'medianTaxiOutMin', max: 100 }] });
    expect(r.data.rows.map((x: { code: string }) => x.code)).toEqual(['LAX']);
    expect(r.data.airportsMissingAFilteredOrSortedMetric.examples).toEqual([{ code: 'GUM', metric: 'medianTaxiOutMin' }]);
  });
  it('pages without overlap', async () => {
    const a = await ok('screen_airports', { states: ['TX'], min_passengers: 100_000, sort_by: 'passengers12m', limit: 5 });
    const b = await ok('screen_airports', { states: ['TX'], min_passengers: 100_000, sort_by: 'passengers12m', limit: 5, offset: a.page?.nextOffset });
    const ca = a.data.rows.map((x: { code: string }) => x.code);
    expect(b.data.rows.map((x: { code: string }) => x.code).some((c: string) => ca.includes(c))).toBe(false);
    expect(ca[0]).toBe('DFW');
  });
  it('rejects unknown metrics, unsupported scopes and bad limits', async () => {
    expect((await failure('screen_airports', { sort_by: 'profit' })).error.code).toBe('invalid_arguments');
    expect((await failure('screen_airports', { filters: [{ metric: 'happiness', min: 1 }] })).error.code).toBe('invalid_arguments');
    expect((await failure('screen_airports', { states: ['Quebec'] })).error.code).toBe('unsupported_scope');
    expect((await failure('screen_airports', { limit: 500 })).error.code).toBe('invalid_arguments');
  });
});

describe('compare_operations', () => {
  it('matches the analytics comparison exactly and adds no composite congestion score', async () => {
    const r = await ok('compare_operations', { airports: ['LAX', 'SNA'] });
    const direct = await service.compareOperations(['LAX', 'SNA']);
    expect(r.data.comparisons).toEqual(wire(direct.comparisons));
    expect(r.data.airports.map((a: { operations: unknown }) => a.operations)).toEqual(wire(direct.airports.map((a) => a.metrics.operations)));
    expect(r.data.airports[0].airfield).toMatchObject({ commercialRunways: 4, departuresPerCommercialRunwayPerDay: direct.airports[0]?.metrics.departuresPerRunwayDay });
    expect(JSON.stringify(r)).not.toMatch(/congestionScore|congestionIndex/);
    expect(r.limitations.join(' ')).toMatch(/not evidence of terminal capacity/);
    expect(r.data.airports[0].currentFaaStatus).toEqual({ events: [wire(EVENTS[1])] });
  });
  it('handles more than two airports and different regions', async () => {
    const r = await ok('compare_operations', { airports: ['BOS', 'DEN', 'SEA', 'MIA'] });
    expect(r.data.comparisons).toHaveLength(6);
  });
  it('preserves ambiguity and rejects bad input', async () => {
    expect((await failure('compare_operations', { airports: ['Portland', 'SNA'] })).error.code).toBe('ambiguous_airport');
    expect((await failure('compare_operations', { airports: ['LAX'] })).error.code).toBe('invalid_arguments');
    expect((await failure('compare_operations', { airports: ['LAX', 'lax'] })).error.message).toMatch(/fewer than two/);
    expect((await failure('compare_operations', { airports: ['LAX', 'Nowhere Intl'] })).error.code).toBe('unknown_airport');
  });
  it('shows weak on-time coverage as unreliable', async () => {
    const r = await ok('compare_operations', { airports: ['GUM', 'STT'] });
    expect(r.data.airports.every((a: { operations: { reliable: boolean } }) => !a.operations.reliable)).toBe(true);
    expect(r.coverage).toBeDefined();
  });
});

describe('route tools', () => {
  it('get_route_network matches the service', async () => {
    const r = await ok('get_route_network', { airport: 'MIA', top_routes: 5 });
    expect(r.data).toEqual(wire(service.network('MIA', { top: 5 })));
    expect(r.data.topRoutes).toHaveLength(5);
  });
  it('search_routes filters by distance, class and destination type, and pages', async () => {
    const r = await ok('search_routes', { origins: ['BOS'], destination_type: 'international', min_miles: 3000, sort_by: 'distance', limit: 4 });
    expect(r.data.routes.length).toBeGreaterThan(0);
    expect(r.data.routes.every((x: { distanceMiles: number; origin: string }) => x.distanceMiles >= 3000 && x.origin === 'BOS')).toBe(true);
    const direct = service.routes({ origins: ['BOS'], destinations: 'international', minMiles: 3000, sortBy: 'distance' });
    expect(r.data.routes).toEqual(wire(direct.slice(0, 4)));
    const dest = await ok('search_routes', { destinations: ['HNL'], origins: ['LAX', 'SFO'], limit: 5 });
    expect(dest.data.routes.every((x: { dest: string }) => x.dest === 'HNL')).toBe(true);
  });
  it('requires some restriction and resolves names safely', async () => {
    expect((await failure('search_routes', {})).error.message).toMatch(/too broad/);
    expect((await failure('search_routes', { origins: ['Portland'] })).error.code).toBe('ambiguous_airport');
    expect((await failure('search_routes', { origins: ['BOS'], sort_by: 'vibes' })).error.code).toBe('invalid_arguments');
  });
  it('get_long_haul_share matches the service and honours thresholds and classes', async () => {
    const r = await ok('get_long_haul_share', { airport: 'Anchorage'.length ? 'ANC' : '' });
    const direct = service.longHaul('ANC');
    const { meta: _m, notes: _n, ...rest } = direct;
    expect(r.data).toEqual(wire(rest));
    expect(r.data.longHaulDepartures).toBe(628);
    const lower = await ok('get_long_haul_share', { airport: 'ANC', threshold_miles: 2300, service_classes: ['F', 'G'] });
    expect(lower.data.thresholdMiles).toBe(2300);
    expect(lower.data.classes).toEqual(['F', 'G']);
    expect(lower.data.share).toBeGreaterThan(r.data.share);
  });
  it('get_long_haul_share warns instead of reporting 0% when there is no service', async () => {
    const none = store.airports.airports.find((a) => a.country === 'US' && store.trafficByAirport.has(a.code) && !(store.segmentsByOrigin.get(a.code) ?? []).some((r) => r.cls === 'F' && r.depsPerformed > 0));
    expect(none).toBeDefined();
    const r = await ok('get_long_haul_share', { airport: none!.code });
    expect(r.data.share).toBeUndefined();
    expect(r.data.totalDepartures).toBe(0);
    expect(r.warnings?.join(' ')).toMatch(/not 0%/);
  });
  it('get_long_haul_share rejects bad thresholds and ambiguous names', async () => {
    expect((await failure('get_long_haul_share', { airport: 'ANC', threshold_miles: -5 })).error.code).toBe('invalid_arguments');
    expect((await failure('get_long_haul_share', { airport: 'Anchorage' }, { ...ctx, autoResolveDominant: false })).error).toMatchObject({ code: 'ambiguous_airport', candidates: [{ suggested: 'ANC' }] });
    expect((await failure('get_long_haul_share', { airport: 'Washington' })).error.code).toBe('ambiguous_airport');
  });
});

describe('dominant-airport interpretation is disclosed, and limited to one place', () => {
  it('uses the dominant airport for a single-city name and says so in the result', async () => {
    const r = await ok('get_long_haul_share', { airport: 'Anchorage' });
    expect(r.data.origin).toBe('ANC');
    expect(r.warnings?.[0]).toMatch(/Airport name interpretation: "Anchorage" matched \d+ airports; ANC .* at least 80% of their passengers\. Others: /);
    const den = await ok('get_traffic_metrics', { airports: ['Denver'] });
    expect(den.data.airports[0].airport).toBe('DEN');
    expect(den.warnings?.join(' ')).toMatch(/Denver/);
  });
  it('never guesses between same-named places in different states, or when nothing dominates', async () => {
    for (const name of ['Portland', 'Washington', 'New York']) {
      const f = await failure('get_traffic_metrics', { airports: [name] });
      expect(f.error.code, name).toBe('ambiguous_airport');
    }
  });
  it('is not blocked by airports that merely contain the word in their name, or by tiny same-named fields', async () => {
    // Manchester-Boston Regional (NH) has "Boston" in its name but is not in a city called Boston; Honolulu has a joint-use military field.
    expect((await ok('get_long_haul_share', { airport: 'Boston' })).data.origin).toBe('BOS');
    expect((await ok('get_long_haul_share', { airport: 'Honolulu' })).data.origin).toBe('HNL');
    expect((await ok('get_long_haul_share', { airport: 'Miami' })).data.origin).toBe('MIA');
  });
  it('the explicit resolve tool always reports ambiguity instead of choosing', async () => {
    expect((await ok('resolve_airport', { query: 'Anchorage' })).data.status).toBe('ambiguous');
  });
  it('an exact code never produces an interpretation note', async () => {
    expect((await ok('get_long_haul_share', { airport: 'ANC' })).warnings).toBeUndefined();
  });
});

describe('get_airport_infrastructure', () => {
  it('returns FAA runways, usage and the limits of the data', async () => {
    const r = await ok('get_airport_infrastructure', { airports: ['SFO', 'KLW'] });
    const [sfo, klw] = r.data.airports;
    expect(sfo).toMatchObject({ code: 'SFO', faaMatched: true, commercialRunways: 4 });
    expect(sfo.runways).toHaveLength(4);
    expect(sfo.departuresPerCommercialRunwayPerDay).toBeGreaterThan(50);
    expect(klw).toMatchObject({ code: 'KLW', faaMatched: false, faaIssue: 'not-found' });
    expect(klw.runways).toEqual([]);
    expect(r.limitations.join(' ')).toMatch(/Terminal size, gates/);
  });
  it('rejects ambiguity and invalid arguments', async () => {
    expect((await failure('get_airport_infrastructure', { airports: ['Washington'] })).error.code).toBe('ambiguous_airport');
    expect((await failure('get_airport_infrastructure', { airports: [] })).error.code).toBe('invalid_arguments');
  });
});

describe('analyze_demand_pressure', () => {
  it('matches the analytics profile and never presents the result as unmet demand', async () => {
    const r = await ok('analyze_demand_pressure', { airport: 'SFO' });
    const direct = await service.demandPressure('SFO');
    expect(r.data.indicators).toEqual(wire(direct.profile.indicators));
    expect(r.data.measuredUnmetDemand).toBeNull();
    expect(r.warnings?.join(' ')).toMatch(/cannot be measured/);
    expect(r.limitations.join(' ')).toMatch(/Unmet demand cannot be measured/);
    expect(r.data.currentFaaStatus).toEqual({ events: [wire(EVENTS[0])] });
  });
  it('works for other airports and rejects ambiguity', async () => {
    expect((await ok('analyze_demand_pressure', { airport: 'DEN' })).data.airport).toBe('DEN');
    expect((await failure('analyze_demand_pressure', { airport: 'New York' })).error.code).toBe('ambiguous_airport');
  });
});

describe('rank_expansion_opportunities', () => {
  const NE = ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'];
  it('returns exactly the deterministic ranking', async () => {
    const r = await ok('rank_expansion_opportunities', { states: NE, top_n: 6 });
    const direct = await service.rankOpportunities({ states: NE, topN: 6 });
    expect(r.data.ranking).toEqual(wire(direct.ranking));
    expect(r.data.scope).toBe(direct.scope);
    for (const a of r.data.ranking.ranked) expect(a.contributions.reduce((s: number, c: { points: number }) => s + c.points, 0)).toBeCloseTo(a.score, 8);
  });
  it('maps configurable weights and changes the answer', async () => {
    const growth = await ok('rank_expansion_opportunities', { states: NE, weights: { scale: 0, momentum: 100, load_factor: 0, capacity_gap: 0, runway_load: 0, taxi_out: 0 }, top_n: 3 });
    const size = await ok('rank_expansion_opportunities', { states: NE, weights: { scale: 100, momentum: 0, load_factor: 0, capacity_gap: 0, runway_load: 0, taxi_out: 0 }, top_n: 3 });
    expect(size.data.ranking.ranked[0].code).toBe('BOS');
    expect(growth.data.ranking.ranked[0].code).not.toBe('BOS');
    expect(growth.data.ranking.weights).toMatchObject({ momentum: 100, scale: 0, loadFactor: 0 });
    const delay = await ok('rank_expansion_opportunities', { states: NE, weights: { departure_delay: 30 }, top_n: 3 });
    expect(delay.data.ranking.weights.departureDelay).toBe(30);
  });
  it('supports region, radius and airport-list scopes beyond New England', async () => {
    const mountain = await ok('rank_expansion_opportunities', { region: 'Mountain', top_n: 5 });
    expect(mountain.data.ranking.ranked.every((a: { state: string }) => ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'].includes(a.state))).toBe(true);
    const near = await ok('rank_expansion_opportunities', { near_airport: 'ORD', radius_miles: 200, min_passengers: 500_000, top_n: 5 });
    expect(near.data.scope).toMatch(/within 200 miles/);
    expect(near.data.ranking.ranked.map((a: { code: string }) => a.code)).toContain('ORD');
    const list = await ok('rank_expansion_opportunities', { airport_codes: ['AUS', 'DAL', 'HOU', 'SAT', 'SEA'], top_n: 5 });
    expect(list.data.ranking.ranked.map((a: { code: string }) => a.code).sort()).toEqual(['AUS', 'DAL', 'HOU', 'SAT', 'SEA']);
  });
  it('with no scope ranks the whole country and says so', async () => {
    const r = await ok('rank_expansion_opportunities', { min_passengers: 3_000_000, top_n: 20 });
    expect(r.data.scope).toBe('all US airports with traffic data');
    expect(new Set(r.data.ranking.ranked.map((a: { state: string }) => a.state)).size).toBeGreaterThan(8);
  });
  it('makes correlation adjustment optional and explains it', async () => {
    const on = await ok('rank_expansion_opportunities', { states: NE, top_n: 3 });
    const off = await ok('rank_expansion_opportunities', { states: NE, top_n: 3, correlation_adjustment: false });
    expect(on.data.ranking.correlationAdjustments.length).toBeGreaterThan(0);
    expect(on.data.ranking.correlationAdjustments[0].explanation).toMatch(/of its configured weight because/);
    expect(off.data.ranking.correlationAdjustments).toEqual([]);
    expect(off.data.ranking.ranked[0].contributions.every((c: { correlationFactor: number }) => c.correlationFactor === 1)).toBe(true);
  });
  it('makes the missing-data policy explicit, shows imputed values and score bounds', async () => {
    const neutral = await ok('rank_expansion_opportunities', { states: NE, top_n: 20 });
    const redistribute = await ok('rank_expansion_opportunities', { states: NE, top_n: 20, missing_data_policy: 'redistribute' });
    expect(neutral.data.ranking.missingDataPolicy).toBe('neutral');
    const hvn = neutral.data.ranking.ranked.find((a: { code: string }) => a.code === 'HVN');
    expect(hvn.contributions.find((c: { metric: string }) => c.metric === 'taxiOut')).toMatchObject({ imputed: true, percentile: 50 });
    expect(hvn.scoreBounds.low).toBeLessThan(hvn.score);
    expect(hvn.scoreBounds.high).toBeGreaterThan(hvn.score);
    expect(hvn.coverage.missing[0].reason).toMatch(/no on-time data/);
    const hvn2 = redistribute.data.ranking.ranked.find((a: { code: string }) => a.code === 'HVN');
    expect(hvn2.contributions.some((c: { metric: string }) => c.metric === 'taxiOut')).toBe(false);
    expect(redistribute.assumptions.join(' ')).toMatch(/Missing-data policy: redistribute/);
  });
  it('states the periods and never presents the score as profit or proof of a terminal constraint', async () => {
    const r = await ok('rank_expansion_opportunities', { states: NE, top_n: 3 });
    expect(r.periods).toMatchObject({ passengerWindow: '2025-09..2026-08', baselineWindow: '2024-09..2025-08', operations: '2026-06, 2026-07, 2026-08' });
    const text = [...r.limitations, ...r.assumptions, ...r.data.ranking.readingGuide].join(' ');
    expect(text).toMatch(/not evidence that a terminal is capacity-constrained/);
    expect(text).toMatch(/not a forecast, and not a profitability or return estimate/);
    expect(text).toMatch(/relative to the candidate set/);
    expect(r.data.ranking.periods.notes.join(' ')).toMatch(/not comparable/);
  });
  it('rejects unsupported scopes and invalid weights', async () => {
    expect((await failure('rank_expansion_opportunities', { states: ['Bavaria'] })).error.code).toBe('unsupported_scope');
    expect((await failure('rank_expansion_opportunities', { weights: { scale: -1 } })).error.code).toBe('invalid_arguments');
    expect((await failure('rank_expansion_opportunities', { weights: { scale: 0, momentum: 0, load_factor: 0, capacity_gap: 0, runway_load: 0, taxi_out: 0, departure_delay: 0 } })).error.message).toMatch(/at least one metric/);
    expect((await failure('rank_expansion_opportunities', { weights: { vibes: 5 } as never })).error.code).toBe('invalid_arguments');
    expect((await failure('rank_expansion_opportunities', { top_n: 0 })).error.code).toBe('invalid_arguments');
    expect((await failure('rank_expansion_opportunities', { airport_codes: ['Portland'] })).error.code).toBe('ambiguous_airport');
  });
  it('reports a scope with no airports as an error rather than an empty ranking', async () => {
    const f = await failure('rank_expansion_opportunities', { states: ['DC'], near_airport: 'LAX', radius_miles: 10 });
    expect(f.error.code).toBe('unsupported_request');
    expect(f.error.message).toMatch(/no airports match the scope/);
  });
  it('shows the model a slimmed result while the full result keeps the method and definitions', async () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'rank_expansion_opportunities') as never as { slim: (o: ToolOutput) => ToolOutput };
    const full = await ok('rank_expansion_opportunities', { states: NE, top_n: 5 });
    const forLlm = forModel(TOOL_SPECS.find((t) => t.name === 'rank_expansion_opportunities') as never, full);
    expect(full.data.ranking.definitions).toBeDefined();
    expect(forLlm).not.toContain('"definitions"');
    expect(forLlm.length).toBeLessThan(JSON.stringify(full).length);
    expect(forLlm).toContain('"contributions"');
    expect(typeof spec.slim).toBe('function');
  });
});

describe('get_current_faa_disruptions', () => {
  it('lists live events, filters by airport, and says when none are reported', async () => {
    const all = await ok('get_current_faa_disruptions', {});
    expect(all.data.events).toHaveLength(2);
    expect(all.data.faaUpdateTime).toBe('Wed Nov 25 15:01:06 2026 GMT');
    const sfo = await ok('get_current_faa_disruptions', { airports: ['SFO', 'BOS'] });
    expect(sfo.data.events.map((e: { airport: string }) => e.airport)).toEqual(['SFO']);
    expect(sfo.data.noEventsReportedFor).toEqual(['BOS']);
    expect(sfo.limitations.join(' ')).toMatch(/does not mean operations are normal/);
    expect(all.data.events[1].interpretation).toMatch(/general-aviation/);
  });
  it('reports an unconfigured or failing live source explicitly', async () => {
    const noNas = new AnalyticsService({ store, traffic: offlineProvider, now: NOW });
    expect((await failure('get_current_faa_disruptions', {}, { service: noNas, store })).error.code).toBe('data_unavailable');
    const broken = new AnalyticsService({ store, traffic: offlineProvider, now: NOW, nas: { forAirport: nas.forAirport, current: async () => { throw new ProviderError('faa-nas-status', 'timeout', 'timed out'); } } });
    const f = await failure('get_current_faa_disruptions', {}, { service: broken, store });
    expect(f.error).toMatchObject({ code: 'provider_error', message: 'faa-nas-status: timed out' });
    expect(f.error.hint).toMatch(/do not substitute/);
  });
});

describe('provider failures surface as structured errors', () => {
  it('turns a data-source failure into provider_error instead of an exception or invented data', async () => {
    const failingTraffic = { monthly: async () => { throw new ProviderError('bts-socrata', 'timeout', 'timed out after 20000 ms'); } } as unknown as TrafficProvider;
    const svc = new AnalyticsService({ store, traffic: failingTraffic, now: NOW });
    const f = await failure('get_traffic_metrics', { airports: ['LAX'] }, { service: svc, store });
    expect(f.error.code).toBe('provider_error');
    expect(f.error.message).toContain('timed out');
  });
});

describe('get_methodology', () => {
  it('describes sources, periods, metrics, the score and supported regions', async () => {
    const all = await ok('get_methodology', {});
    expect(Object.keys(all.data)).toEqual(expect.arrayContaining(['dataSources', 'metrics', 'opportunityScore', 'supportedRegions']));
    expect(all.data.supportedRegions.names).toEqual(expect.arrayContaining(['New England', 'Pacific', 'West']));
    expect(all.data.dataSources.alignedOperationalMonths).toEqual(['2026-06', '2026-07', '2026-08']);
    const metricsOnly = await ok('get_methodology', { topic: 'regions' });
    expect(Object.keys(metricsOnly.data)).toEqual(['supportedRegions']);
    expect((await failure('get_methodology', { topic: 'astrology' })).error.code).toBe('invalid_arguments');
  });
});

describe('LangChain wrapper', () => {
  it('gives the model compact JSON and the UI the full structured result as the artifact', async () => {
    const tools = createTools(ctx);
    const t = tools.find((x) => x.name === 'rank_expansion_opportunities')!;
    const msg = (await t.invoke({ type: 'tool_call', id: 'call_1', name: 'rank_expansion_opportunities', args: { states: ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'], top_n: 4 } })) as ToolMessage;
    expect(msg).toBeInstanceOf(ToolMessage);
    expect(msg.tool_call_id).toBe('call_1');
    const artifact = msg.artifact as ToolSuccess<{ ranking: { ranked: unknown[]; definitions: unknown } }>;
    expect(artifact.ok).toBe(true);
    expect(artifact.data.ranking.definitions).toBeDefined();
    const content = JSON.parse(msg.content as string) as ToolSuccess<{ ranking: { ranked: unknown[]; definitions?: unknown } }>;
    expect(content.data.ranking.definitions).toBeUndefined();
    expect(content.data.ranking.ranked).toHaveLength(4);
    expect((msg.content as string).length).toBeLessThan(JSON.stringify(artifact).length);
  });
  it('trims decimals only in the model copy; the artifact keeps full precision', async () => {
    const t = createTools(ctx).find((x) => x.name === 'get_traffic_metrics')!;
    const msg = (await t.invoke({ type: 'tool_call', id: 'c3', name: 'get_traffic_metrics', args: { airports: ['LAX'] } })) as ToolMessage;
    const full = (msg.artifact as ToolSuccess<{ airports: Array<{ loadFactor: { current: number } }> }>).data.airports[0]!.loadFactor.current;
    const seen = (JSON.parse(msg.content as string) as ToolSuccess<{ airports: Array<{ loadFactor: { current: number } }> }>).data.airports[0]!.loadFactor.current;
    expect(String(full).length).toBeGreaterThan(String(seen).length);
    expect(seen).toBeCloseTo(full, 4);
  });
  it('returns validation problems as a structured error result, not an exception', async () => {
    const t = createTools(ctx).find((x) => x.name === 'find_airports')!;
    await expect(t.invoke({ type: 'tool_call', id: 'c2', name: 'find_airports', args: { region: 'Atlantis' } })).rejects.toThrow();
    const direct = await failure('find_airports', { region: 'Atlantis' });
    expect(direct.error.code).toBe('invalid_arguments');
  });
});
