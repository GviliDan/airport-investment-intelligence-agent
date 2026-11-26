import { describe, expect, it } from 'vitest';
import type { MonthlyTraffic } from '../../data/btsSocrata.js';
import { ProviderError } from '../../data/errors.js';
import type { NasEvent } from '../../data/faaNasStatus.js';
import { CENSUS_DIVISIONS } from '../../data/geo.js';
import { loadDataStore } from '../../data/store.js';
import { TrafficProvider } from '../../data/trafficProvider.js';
import { AnalyticsError, AnalyticsService } from '../service.js';

// Integration tests over the committed BTS/FAA datasets: they exercise the real data paths of all four assignment questions.
const store = await loadDataStore();
const NOW = () => new Date('2026-11-25T12:00:00Z');
const failingLive = { monthlyTraffic: async () => { throw new ProviderError('bts-socrata', 'http', 'HTTP 503', 503); } };
const offline = () => new AnalyticsService({ store, traffic: new TrafficProvider({ live: failingLive, snapshot: store.traffic, useLive: false }), now: NOW });

describe('Q1: expansion candidates in a region (analytics layer)', () => {
  it('ranks New England airports from explicit states, with scored contributions and no hidden region', async () => {
    const states = CENSUS_DIVISIONS['New England'] as string[];
    const { scope, ranking, meta } = await offline().rankOpportunities({ states, topN: 10 });
    expect(scope).toBe('states CT, ME, MA, NH, RI, VT');
    expect(meta.asOf).toBe('2026-08');
    expect(meta.traffic.mode).toBe('snapshot');
    expect(ranking.ranked.length).toBeGreaterThanOrEqual(8);
    for (const a of ranking.ranked) {
      expect(states).toContain(a.state);
      expect(a.contributions.reduce((s, c) => s + c.points, 0)).toBeCloseTo(a.score, 6);
    }
    expect(ranking.ranked.map((a) => a.code)).toContain('BOS');
    const { considered, scored, unscored, excluded } = ranking.candidateSet;
    expect(considered).toBe(scored + unscored + excluded);
    expect(ranking.excluded.every((e) => e.reason.length > 0)).toBe(true);
    expect(ranking.method.join(' ')).toMatch(/relative to the candidate set/);
  });

  it('with no scope at all, ranks the whole country rather than defaulting to a region', async () => {
    const { scope, ranking } = await offline().rankOpportunities({ minPassengers: 2_000_000, topN: 200 });
    expect(scope).toBe('all US airports with traffic data');
    const states = new Set(ranking.ranked.map((a) => a.state));
    expect(states.size).toBeGreaterThan(20);
    expect(['NY', 'CA', 'TX', 'FL', 'IL', 'CO', 'WA', 'GA'].every((s) => states.has(s))).toBe(true);
  });

  it('works for other regions, and different regions give different answers', async () => {
    const svc = offline();
    const pacific = await svc.rankOpportunities({ states: [...(CENSUS_DIVISIONS.Pacific as string[])], topN: 5 });
    const mountain = await svc.rankOpportunities({ states: [...(CENSUS_DIVISIONS.Mountain as string[])], topN: 5 });
    expect(pacific.ranking.ranked.every((a) => ['AK', 'CA', 'HI', 'OR', 'WA'].includes(a.state ?? ''))).toBe(true);
    expect(mountain.ranking.ranked.every((a) => ['AZ', 'CO', 'ID', 'MT', 'NV', 'NM', 'UT', 'WY'].includes(a.state ?? ''))).toBe(true);
    expect(pacific.ranking.ranked[0]?.code).not.toBe(mountain.ranking.ranked[0]?.code);
  });

  it('supports radius scopes and combines them with state scopes', async () => {
    const svc = offline();
    const near = svc.selectAirports({ near: { lat: 42.36, lon: -71.0, radiusMiles: 60 } });
    expect(near.airports.map((a) => a.code)).toContain('BOS');
    expect(near.airports.map((a) => a.code)).not.toContain('LAX');
    expect(near.description).toMatch(/within 60 miles/);
    const both = svc.selectAirports({ states: ['NH'], near: { lat: 42.36, lon: -71.0, radiusMiles: 60 } });
    expect(both.airports.every((a) => a.state === 'NH')).toBe(true);
  });

  it('changes the ranking when weights change, and reports the weights used', async () => {
    const svc = offline();
    const states = ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'];
    const bySize = await svc.rankOpportunities({ states, weights: { scale: 1, momentum: 0, loadFactor: 0, capacityGap: 0, runwayLoad: 0, taxiOut: 0 } });
    const byGrowth = await svc.rankOpportunities({ states, weights: { scale: 0, momentum: 1, loadFactor: 0, capacityGap: 0, runwayLoad: 0, taxiOut: 0 } });
    expect(bySize.ranking.ranked[0]?.code).toBe('BOS');
    expect(byGrowth.ranking.ranked[0]?.code).not.toBe('BOS');
    expect(byGrowth.ranking.weights.momentum).toBe(1);
  });

  it('keeps airports without an FAA match in the candidate set and flags them', async () => {
    const { ranking } = await offline().rankOpportunities({ states: ['AK'], minPassengers: 100_000, topN: 200 });
    const unmatched = ranking.ranked.filter((a) => !a.coverage.faaMatched);
    for (const a of unmatched) expect(a.coverage.missing.some((m) => m.metric === 'runwayLoad')).toBe(true);
    expect(ranking.ranked.length + ranking.unscored.length).toBeGreaterThan(5);
  });

  it('reports unknown states and empty scopes clearly', async () => {
    const svc = offline();
    await expect(svc.rankOpportunities({ states: ['ZZ'] })).rejects.toThrow(AnalyticsError);
    await expect(svc.rankOpportunities({ states: ['ZZ'] })).rejects.toThrow(/unknown state "ZZ"/);
    expect(svc.selectAirports({ codes: ['NOPE'] }).issues[0]).toMatch(/NOPE is not a US airport/);
  });
});

describe('Q2: compare congestion of two airports (operational comparison)', () => {
  it('returns measured operational figures, runway intensity and coverage for LAX and SNA, and no single congestion score', async () => {
    const r = await offline().compareOperations(['LAX', 'SNA']);
    const [lax, sna] = r.airports.map((a) => a.metrics);
    expect(lax?.operations.scheduledDepartures).toBe(50612);
    expect(sna?.operations.scheduledDepartures).toBe(11712);
    expect(lax?.operations.derived?.departureDelayRate15).toBeCloseTo(0.2415, 3);
    expect(sna?.operations.derived?.departureDelayRate15).toBeCloseTo(0.2542, 3);
    expect(lax?.operations.derived?.medianTaxiOutMin).toBe(16);
    expect(sna?.operations.derived?.medianTaxiOutMin).toBe(14);
    expect(lax?.operations.reliable && sna?.operations.reliable).toBe(true);
    expect(lax?.departuresPerRunwayDay).toBeGreaterThan(sna?.departuresPerRunwayDay ?? Infinity);
    const cmp = r.comparisons[0]!;
    expect(cmp.medianTaxiOutDifferenceMin).toBe(2);
    expect(cmp.departureDelayRate15?.verdict).toBe('indistinguishable'); // 1.3 points: inside the practical floor
    expect(JSON.stringify(r)).not.toMatch(/congestionScore|congestionIndex/);
    expect(cmp.notes.join(' ')).toMatch(/not a measure of terminal capacity/);
  });
  it('includes live FAA status events when available, and reports unavailability instead of failing', async () => {
    const events: NasEvent[] = [{ airport: 'SNA', kind: 'ground-delay-program', reason: 'wx', detail: {} }];
    const svc = new AnalyticsService({ store, traffic: new TrafficProvider({ live: failingLive, snapshot: store.traffic, useLive: false }), nas: { forAirport: async (c) => ({ data: events.filter((e) => e.airport === c), provenance: { source: 'faa-nas-status', dataset: 'x', retrievedAt: 't' } }) }, now: NOW });
    const ok = await svc.compareOperations(['LAX', 'SNA']);
    expect(ok.airports[1]?.liveStatus).toEqual({ events });
    expect(ok.airports[0]?.liveStatus).toEqual({ events: [] });
    const broken = new AnalyticsService({ store, traffic: new TrafficProvider({ live: failingLive, snapshot: store.traffic, useLive: false }), nas: { forAirport: async () => { throw new ProviderError('faa-nas-status', 'timeout', 'timed out'); } }, now: NOW });
    expect((await broken.compareOperations(['LAX', 'SNA'])).airports[0]?.liveStatus).toEqual({ unavailable: 'faa-nas-status: timed out' });
  });
  it('compares more than two airports pairwise and rejects fewer than two', async () => {
    const r = await offline().compareOperations(['LAX', 'SNA', 'SFO']);
    expect(r.comparisons).toHaveLength(3);
    await expect(offline().compareOperations(['LAX'])).rejects.toThrow(/at least two/);
    await expect(offline().compareOperations(['LAX', 'NOPE'])).rejects.toThrow(/unknown airport code "NOPE"/);
  });
});

describe('Q3: long-haul share (measurement from T-100 segments)', () => {
  it('measures the share of performed scheduled-passenger departures from ANC at 3,000+ miles', () => {
    const r = offline().longHaul('ANC');
    expect(r.totalDepartures).toBe(13794);
    expect(r.longHaulDepartures).toBe(628);
    expect(r.share).toBeCloseTo(628 / 13794, 10);
    expect(r.months).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(r.classes).toEqual(['F']);
    expect(r.sensitivity.find((s) => s.thresholdMiles === 1500)?.share).toBeGreaterThan(0.2);
    expect(r.notes.join(' ')).toMatch(/configurable assumption/);
  });
  it('the answer depends on the definition: threshold and service class change it', () => {
    const svc = offline();
    expect(svc.longHaul('ANC', { thresholdMiles: 2300 }).share).toBeGreaterThan(svc.longHaul('ANC').share ?? 1);
    expect(svc.longHaul('ANC', { classes: ['F', 'G', 'L', 'P'] }).share).toBeGreaterThan(0.2);
  });
  it('works for any airport and rejects unknown ones', () => {
    const svc = offline();
    expect(svc.longHaul('HNL').share).toBeGreaterThan(svc.longHaul('ANC').share ?? 1);
    expect(svc.longHaul('BOS').totalDepartures).toBeGreaterThan(30_000);
    expect(() => svc.longHaul('NOPE')).toThrow(AnalyticsError);
  });
});

describe('Q4: demand pressure at SFO (indicators, not unmet demand)', () => {
  it('returns peer-relative indicators with evidence and states that unmet demand is not measured', async () => {
    const { profile, meta } = await offline().demandPressure('SFO');
    expect(profile.measuredUnmetDemand).toBeNull();
    expect(profile.peerGroup.size).toBeGreaterThan(30);
    const lf = profile.indicators.find((i) => i.id === 'loadFactor12m');
    expect(lf?.value).toBeCloseTo(81.7, 1);
    expect(lf?.peerPercentile).toBeGreaterThan(50);
    expect(profile.monthlyLoadFactor).toHaveLength(12);
    expect(profile.peakLoadFactorMonth?.loadFactor).toBeGreaterThan(0.8);
    expect(profile.limitations.join(' ')).toMatch(/Unmet demand cannot be measured/);
    expect(meta.operationalMonths).toEqual(['2026-06', '2026-07', '2026-08']);
    for (const i of profile.indicators) expect(i.doesNotShow).not.toBe('');
  });
});

describe('additional analytical queries', () => {
  it('computes configurable-window growth that matches an independent calculation', async () => {
    const svc = offline();
    const rows = store.trafficByAirport.get('LAX')!;
    const sum = (from: string, to: string) => rows.filter((r) => r.month >= from && r.month <= to).reduce((s, r) => s + (r.passengers ?? 0), 0);
    const { analysis } = await svc.trafficGrowth('LAX');
    expect(analysis.current.passengers).toBe(sum('2025-09', '2026-08'));
    expect(analysis.baseline.passengers).toBe(sum('2024-09', '2025-08'));
    const q = await svc.trafficGrowth('LAX', { windowMonths: 3 });
    expect(q.analysis.current.passengers).toBe(sum('2026-06', '2026-08'));
    expect(q.analysis.baseline.passengers).toBe(sum('2025-06', '2025-08'));
    const prev = await svc.trafficGrowth('LAX', { windowMonths: 3, baseline: 'previous-period' });
    expect(prev.analysis.baseline.passengers).toBe(sum('2026-03', '2026-05'));
  });

  it('screens airports with filters and sorting across the country', async () => {
    const { result } = await offline().screen({ minPassengers: 1_000_000, filters: [{ metric: 'loadFactorPct', min: 84 }], sortBy: 'passengerGrowthPct', limit: 10 });
    expect(result.rows.length).toBeGreaterThan(0);
    for (const r of result.rows) {
      expect(r.loadFactorPct).toBeGreaterThanOrEqual(84);
      expect(r.passengers12m).toBeGreaterThanOrEqual(1_000_000);
    }
    const growth = result.rows.map((r) => r.passengerGrowthPct as number);
    expect([...growth].sort((a, b) => b - a)).toEqual(growth);
  });

  it('finds long routes from an airport and international exposure', () => {
    const svc = offline();
    const long = svc.routes({ origins: ['DEN'], minMiles: 3000, limit: 5 });
    expect(long.length).toBeGreaterThan(0);
    expect(long.every((r) => r.distanceMiles >= 3000 && r.origin === 'DEN')).toBe(true);
    const net = svc.network('MIA');
    expect(net.internationalDestinations).toBeGreaterThan(20);
    expect(net.destinations).toBeGreaterThan(net.internationalDestinations);
  });

  it('flags weak on-time coverage rather than hiding it, and warns that the comparison is not conclusive', async () => {
    const r = await offline().compareOperations(['GUM', 'STT']);
    for (const a of r.airports) {
      expect(a.metrics.operations.coverage.ratio).toBeLessThan(0.5);
      expect(a.metrics.operations.reliable).toBe(false);
      expect(a.metrics.operations.notes.join(' ')).toMatch(/covers only/);
    }
    expect(r.comparisons[0]?.notes.join(' ')).toMatch(/do not treat differences as conclusive/);
    // Airports with weak coverage are kept out of the screening table's operational columns.
    const { result } = await offline().screen({ codes: ['GUM'] });
    expect(result.rows[0]?.medianTaxiOutMin).toBeUndefined();
    expect(result.rows[0]?.onTimeCoveragePct).toBeLessThan(50);
  });
  it('still reports a moderate-coverage airport as usable, with its coverage ratio', async () => {
    const r = await offline().compareOperations(['IAD', 'DCA']);
    expect(r.airports[0]?.metrics.operations.coverage.ratio).toBeGreaterThan(0.5);
    expect(r.airports[0]?.metrics.operations.notes.join(' ')).toMatch(/covers about/);
  });
});

describe('live API integration and fallback', () => {
  const rowsOf = (extra: MonthlyTraffic[] = []): MonthlyTraffic[] => [...store.traffic, ...extra];

  it('uses the live API first and reports that the data is live', async () => {
    const calls: unknown[] = [];
    const live = { monthlyTraffic: async (q: unknown) => { calls.push(q); return { data: rowsOf(), provenance: { source: 'bts-socrata', dataset: 'live', retrievedAt: '2026-11-25T12:00:00.000Z' } }; } };
    const svc = new AnalyticsService({ store, traffic: new TrafficProvider({ live, snapshot: [] }), now: NOW });
    const { meta } = await svc.trafficGrowth('LAX');
    expect(meta.traffic.mode).toBe('live');
    expect(meta.traffic.provenance.dataset).toBe('live');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ airports: ['LAX'], from: '2023-12', to: '2026-11' });
  });

  it('falls back to the committed snapshot when the API fails, and says so', async () => {
    const svc = new AnalyticsService({ store, traffic: new TrafficProvider({ live: failingLive, snapshot: store.traffic, snapshotGeneratedAt: store.manifest.generatedAt }), now: NOW });
    const { meta, analysis } = await svc.trafficGrowth('LAX');
    expect(meta.traffic.mode).toBe('snapshot-fallback');
    expect(meta.traffic.liveError).toMatch(/HTTP 503/);
    expect(meta.traffic.provenance.note).toMatch(/Live BTS API unavailable/);
    expect(analysis.current.passengers).toBeGreaterThan(30_000_000);
  });

  it('does not mask programming errors as API failures', async () => {
    const live = { monthlyTraffic: async () => { throw new TypeError('bug'); } };
    const svc = new AnalyticsService({ store, traffic: new TrafficProvider({ live, snapshot: store.traffic }), now: NOW });
    await expect(svc.trafficGrowth('LAX')).rejects.toThrow('bug');
  });

  it('uses newer months from the live API when most airports have them, but ignores a month only one airport reports', async () => {
    const bos = store.trafficByAirport.get('BOS')!.at(-1)!;
    const lone: MonthlyTraffic = { ...bos, month: '2026-09' };
    const make = (extra: MonthlyTraffic[]) => new AnalyticsService({ store, traffic: new TrafficProvider({ live: { monthlyTraffic: async () => ({ data: rowsOf(extra), provenance: { source: 'bts-socrata', dataset: 'live', retrievedAt: 't' } }) }, snapshot: [] }), now: NOW });
    expect((await make([lone]).rankOpportunities({ states: ['MA', 'CT', 'RI'] })).meta.asOf).toBe('2026-08');
    const all = store.traffic.filter((r) => r.month === '2026-08').map((r) => ({ ...r, month: '2026-09' }));
    expect((await make(all).rankOpportunities({ states: ['MA', 'CT', 'RI'] })).meta.asOf).toBe('2026-09');
  });

  it('batches nationwide requests into one call instead of an oversized URL', async () => {
    const calls: Array<{ airports?: readonly string[] }> = [];
    const live = { monthlyTraffic: async (q: { airports?: readonly string[] }) => { calls.push(q); return { data: [...store.traffic], provenance: { source: 'bts-socrata', dataset: 'live', retrievedAt: 't' } }; } };
    await new AnalyticsService({ store, traffic: new TrafficProvider({ live, snapshot: [] }), now: NOW }).rankOpportunities({ minPassengers: 5_000_000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.airports).toBeUndefined();
  });
});
