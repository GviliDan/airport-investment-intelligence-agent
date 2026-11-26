import { describe, expect, it } from 'vitest';
import type { SegmentRecord } from '../../data/aggregate.js';
import { filterSegments, longHaulShare, queryRoutes, routeNetwork } from '../routes.js';

const seg = (o: Partial<SegmentRecord>): SegmentRecord => ({
  month: '2026-08', origin: 'ANC', dest: 'SEA', cls: 'F', distance: 1448, depsScheduled: 10, depsPerformed: 10, seats: 1500, passengers: 1200, freightLbs: 0, mailLbs: 0, originCountry: 'US', destCountry: 'US', ...o,
});
const DATA: SegmentRecord[] = [
  seg({ dest: 'SEA', distance: 1448, depsPerformed: 60, depsScheduled: 62 }),
  seg({ dest: 'DEN', distance: 2405, depsPerformed: 20, depsScheduled: 20 }),
  seg({ dest: 'DFW', distance: 3043, depsPerformed: 10, depsScheduled: 12 }),
  seg({ dest: 'MIA', distance: 3500, depsPerformed: 5, depsScheduled: 5 }),
  seg({ dest: 'NRT', distance: 3400, depsPerformed: 5, depsScheduled: 5, destCountry: 'JP' }),
  seg({ dest: 'FAI', cls: 'G', distance: 261, depsPerformed: 100, depsScheduled: 100, passengers: 0, seats: 0 }),
  seg({ month: '2026-07', dest: 'SEA', depsPerformed: 40 }),
  seg({ origin: 'SEA', dest: 'ANC', depsPerformed: 999 }),
];

describe('longHaulShare', () => {
  it('computes the share of performed departures at or above the threshold (scheduled passenger class by default)', () => {
    const r = longHaulShare(DATA, 'ANC', { months: ['2026-08'] });
    // class F in 2026-08: 60 + 20 + 10 + 5 + 5 = 100; >= 3000 mi: DFW 10 + MIA 5 + NRT 5 = 20
    expect(r.totalDepartures).toBe(100);
    expect(r.longHaulDepartures).toBe(20);
    expect(r.share).toBeCloseTo(0.2, 10);
  });
  it('the threshold is configurable and inclusive', () => {
    expect(longHaulShare(DATA, 'ANC', { months: ['2026-08'], thresholdMiles: 3043 }).longHaulDepartures).toBe(20);
    expect(longHaulShare(DATA, 'ANC', { months: ['2026-08'], thresholdMiles: 3044 }).longHaulDepartures).toBe(10);
    expect(longHaulShare(DATA, 'ANC', { months: ['2026-08'], thresholdMiles: 2000 }).share).toBeCloseTo(0.4, 10);
  });
  it('aggregates multiple months and can switch to all service classes or scheduled departures', () => {
    expect(longHaulShare(DATA, 'ANC').totalDepartures).toBe(140);
    expect(longHaulShare(DATA, 'ANC', { months: ['2026-08'], classes: ['F', 'G'] }).totalDepartures).toBe(200);
    const sched = longHaulShare(DATA, 'ANC', { months: ['2026-08'], basis: 'scheduled' });
    expect(sched.totalDepartures).toBe(104);
    expect(sched.longHaulDepartures).toBe(22);
  });
  it('reports the share under both service-class definitions, each with its own denominator', () => {
    const r = longHaulShare(DATA, 'ANC', { months: ['2026-08'] });
    const [passenger, all] = r.classSensitivity;
    // class F: 20 of 100. All classes adds 100 all-cargo departures (261 miles), so 20 of 200.
    expect(passenger).toMatchObject({ classes: ['F'], totalDepartures: 100, longHaulDepartures: 20 });
    expect(passenger?.share).toBeCloseTo(0.2, 10);
    expect(all).toMatchObject({ totalDepartures: 200, longHaulDepartures: 20 });
    expect(all?.share).toBeCloseTo(0.1, 10);
  });
  it('class sensitivity follows the requested threshold and basis, and is undefined for no departures', () => {
    const sched = longHaulShare(DATA, 'ANC', { months: ['2026-08'], basis: 'scheduled', thresholdMiles: 3400 });
    expect(sched.classSensitivity[0]).toMatchObject({ totalDepartures: 104, longHaulDepartures: 10 }); // MIA 5 + NRT 5
    expect(longHaulShare(DATA, 'XYZ').classSensitivity.every((c) => c.share === undefined && c.totalDepartures === 0)).toBe(true);
  });
  it('returns an undefined share, not 0%, when there are no departures to measure', () => {
    const r = longHaulShare(DATA, 'XYZ');
    expect(r.share).toBeUndefined();
    expect(r.totalDepartures).toBe(0);
    expect(r.notes.join(' ')).toMatch(/No performed departures/);
  });
  it('reports a threshold sensitivity table, distance bands and the busiest long-haul routes', () => {
    const r = longHaulShare(DATA, 'ANC', { months: ['2026-08'] });
    expect(r.sensitivity.find((s) => s.thresholdMiles === 1500)?.share).toBeCloseTo(0.4, 10);
    expect(r.distanceBands.find((b) => b.label === '3000-5000 mi')?.departures).toBe(20);
    expect(r.distanceBands.reduce((s, b) => s + b.departures, 0)).toBe(100);
    expect(r.topLongHaulRoutes.map((t) => t.dest)).toEqual(['DFW', 'MIA', 'NRT']);
  });
  it('rejects a non-positive threshold', () => {
    expect(() => longHaulShare(DATA, 'ANC', { thresholdMiles: 0 })).toThrow(RangeError);
  });
});

describe('filterSegments / queryRoutes', () => {
  it('filters by origin, destination, distance, class, month and domestic/international', () => {
    expect(filterSegments(DATA, { origins: ['SEA'] })).toHaveLength(1);
    expect(filterSegments(DATA, { origins: ['ANC'], dests: ['DEN'] })).toHaveLength(1);
    expect(filterSegments(DATA, { origins: ['ANC'], minMiles: 3000, maxMiles: 3450 }).map((r) => r.dest).sort()).toEqual(['DFW', 'NRT']);
    expect(filterSegments(DATA, { origins: ['ANC'], classes: ['G'] })).toHaveLength(1);
    expect(filterSegments(DATA, { origins: ['ANC'], destinations: 'international' }).map((r) => r.dest)).toEqual(['NRT']);
    expect(filterSegments(DATA, { origins: ['ANC'], months: ['2026-07'] })).toHaveLength(1);
  });
  it('sums months per route and sorts deterministically', () => {
    const rows = queryRoutes(DATA, { origins: ['ANC'] });
    expect(rows[0]).toMatchObject({ dest: 'SEA', departures: 100, seats: 3000, passengers: 2400 });
    expect(rows[0]?.loadFactor).toBeCloseTo(0.8, 10);
    expect(queryRoutes(DATA, { origins: ['ANC'], sortBy: 'distance', limit: 2 }).map((r) => r.dest)).toEqual(['MIA', 'NRT']);
  });
  it('gives a load factor of undefined when a route has no seats', () => {
    const rows = queryRoutes([seg({ seats: 0, passengers: 0, depsPerformed: 3 })], { origins: ['ANC'] });
    expect(rows[0]?.loadFactor).toBeUndefined();
  });
});

describe('routeNetwork', () => {
  it('counts destinations, international exposure and top routes', () => {
    const n = routeNetwork(DATA, 'ANC', { months: ['2026-08'], top: 2 });
    expect(n.destinations).toBe(5);
    expect(n.internationalDestinations).toBe(1);
    expect(n.departures).toBe(100);
    expect(n.internationalDepartureShare).toBeCloseTo(0.05, 10);
    expect(n.topRoutes.map((r) => r.dest)).toEqual(['SEA', 'DEN']);
  });
  it('has an undefined international share for an airport with no departures', () => {
    expect(routeNetwork(DATA, 'XYZ').internationalDepartureShare).toBeUndefined();
  });
});
