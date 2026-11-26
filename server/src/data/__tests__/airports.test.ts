import { describe, expect, it } from 'vitest';
import { AirportIndex } from '../airportIndex.js';
import { buildAirports, sameLocation, type AirportRecord } from '../airportBuild.js';
import type { FaaFacility, FaaRunway } from '../faaArcgis.js';
import { distanceMiles, normalizeState } from '../geo.js';

const a = (code: string, name: string, city: string, state: string, extra: Partial<AirportRecord> = {}): AirportRecord => ({
  code, name, city, state, country: 'US', runways: [], faaMatched: true, ambiguousCode: false, ...extra,
});
const LIST = [
  a('LAX', 'Los Angeles International', 'Los Angeles, CA', 'CA', { lat: 33.94, lon: -118.41, icao: 'KLAX' }),
  a('SNA', 'John Wayne Airport-Orange County', 'Santa Ana, CA', 'CA', { lat: 33.68, lon: -117.87 }),
  a('JFK', 'John F. Kennedy International', 'New York, NY', 'NY'),
  a('LGA', 'LaGuardia', 'New York, NY', 'NY'),
  a('PDX', 'Portland International', 'Portland, OR', 'OR'),
  a('PWM', 'Portland International Jetport', 'Portland, ME', 'ME'),
  a('BOS', 'Logan International', 'Boston, MA', 'MA', { lat: 42.36, lon: -71.0 }),
  a('LGU', 'Logan-Cache', 'Logan, UT', 'UT'),
  a('XYZ', 'Remote Strip', 'Nowhere, AK', 'AK', { faaMatched: false }),
];
const index = new AirportIndex(LIST, (c) => ({ PDX: 9, PWM: 2, JFK: 5, LGA: 4 })[c] ?? 0);

describe('AirportIndex.resolve', () => {
  it('resolves codes (any case) and ICAO identifiers', () => {
    expect(index.resolve('lax')).toMatchObject({ status: 'found', matchedBy: 'code', airport: { code: 'LAX' } });
    expect(index.resolve('KLAX')).toMatchObject({ status: 'found', matchedBy: 'icao' });
  });
  it('resolves a unique city', () => {
    expect(index.resolve('Santa Ana')).toMatchObject({ status: 'found', airport: { code: 'SNA' }, matchedBy: 'city' });
  });
  it('never picks one of several airports for the same city; candidates are ordered by traffic', () => {
    const r = index.resolve('New York');
    expect(r.status).toBe('ambiguous');
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.code)).toEqual(['JFK', 'LGA']);
  });
  it('suggests a dominant airport without resolving silently', () => {
    const idx = new AirportIndex([a('AAA', 'Big Intl', 'Metro, TX', 'TX'), a('BBB', 'Small Field', 'Metro, TX', 'TX')], (c) => (c === 'AAA' ? 95 : 5));
    expect(idx.resolve('Metro')).toMatchObject({ status: 'ambiguous', suggested: { code: 'AAA' } });
    expect(index.resolve('New York')).not.toHaveProperty('suggested');
  });
  it('treats "Logan" as ambiguous between a city and a famous airport name', () => {
    const r = index.resolve('logan');
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.code).sort()).toEqual(['BOS', 'LGU']);
  });
  it('uses a state to disambiguate and reports an unknown state', () => {
    expect(index.resolve('Portland')).toMatchObject({ status: 'ambiguous' });
    expect(index.resolve('Portland', { state: 'Maine' })).toMatchObject({ status: 'found', airport: { code: 'PWM' } });
    expect(index.resolve('Portland', { state: 'Narnia' })).toMatchObject({ status: 'not_found', reason: expect.stringContaining('unknown state') });
  });
  it('refuses very short or unknown text instead of guessing', () => {
    expect(index.resolve('LA')).toMatchObject({ status: 'not_found' });
    expect(index.resolve('')).toMatchObject({ status: 'not_found' });
    expect(index.resolve('Gotham')).toMatchObject({ status: 'not_found' });
  });
});

describe('AirportIndex geography', () => {
  it('filters by state codes or names and reports unknown ones', () => {
    const r = index.inStates(['CA', 'Oregon', 'Atlantis']);
    expect(r.airports.map((x) => x.code).sort()).toEqual(['LAX', 'PDX', 'SNA']);
    expect(r.unknown).toEqual(['Atlantis']);
  });
  it('finds airports near a point, nearest first, and counts those without coordinates', () => {
    const r = index.near({ lat: 33.9, lon: -118.0 }, 50);
    expect(r.airports.map((x) => x.airport.code)).toEqual(['SNA', 'LAX']);
    expect(r.withoutCoordinates).toBe(LIST.filter((x) => x.lat === undefined).length);
  });
});

describe('geo helpers', () => {
  it('normalizes states', () => {
    expect(normalizeState('ca')).toBe('CA');
    expect(normalizeState('New Hampshire')).toBe('NH');
    expect(normalizeState('Gotham')).toBeUndefined();
  });
  it('computes great-circle miles (LAX to SNA is about 35)', () => {
    const miles = distanceMiles({ lat: 33.94, lon: -118.41 }, { lat: 33.68, lon: -117.87 });
    expect(miles).toBeGreaterThan(30);
    expect(miles).toBeLessThan(40);
  });
});

describe('sameLocation', () => {
  it('accepts the same state, the same city, or a TT territory; rejects unrelated places', () => {
    expect(sameLocation({ state: 'AZ' }, { state: 'AZ' })).toBe(true);
    expect(sameLocation({ city: 'Washington, DC', state: 'VA' }, { city: 'WASHINGTON', state: 'DC' })).toBe(true);
    expect(sameLocation({ city: 'Guam, TT', state: 'TT' }, { city: 'TAMUNING', state: 'GU' })).toBe(true);
    expect(sameLocation({ city: 'Springfield, MO', state: 'MO' }, { city: 'SPRINGFIELD', state: 'IL' })).toBe(true); // same city name: accepted, flagged only by state
    expect(sameLocation({ city: 'Boise, ID', state: 'ID' }, { city: 'DALLAS', state: 'TX' })).toBe(false);
  });
});

describe('buildAirports', () => {
  const fac = (faaId: string, state: string, city: string, extra: Partial<FaaFacility> = {}): FaaFacility => ({ faaId, state, city, country: 'US', lat: 1, lon: 2, name: `${faaId} FIELD`, scheduledService: true, ...extra });
  const runway = (airport: string): FaaRunway => ({ airport, id: '10/28', lengthFt: 9000 });
  const build = (facilities: FaaFacility[], identities: Array<{ code: string; city?: string; state?: string; country?: string; btsIds?: string[] }>) =>
    buildAirports({
      identities: identities.map((i) => ({ btsIds: ['1'], ...i })),
      traffic: [],
      faa: {
        airportsByCode: async (codes) => ({ data: facilities.filter((f) => codes.includes(f.faaId)), provenance: { source: 's', dataset: 'd', retrievedAt: 't' } }),
        runways: async (codes) => ({ data: codes.map(runway), provenance: { source: 's', dataset: 'd', retrievedAt: 't' } }),
      },
      now: () => new Date('2026-11-25T00:00:00Z'),
    });

  it('attaches FAA data on an identifier match and carries runways', async () => {
    const out = await build([fac('PDX', 'OR', 'PORTLAND')], [{ code: 'PDX', city: 'Portland, OR', state: 'OR', country: 'US' }]);
    expect(out.airports[0]).toMatchObject({ code: 'PDX', faaMatched: true, lat: 1, runways: [{ id: '10/28', lengthFt: 9000 }], faaMatchMethod: 'identifier' });
  });
  it('maps IATA codes that differ from the FAA identifier (AZA is IWA)', async () => {
    const out = await build([fac('IWA', 'AZ', 'PHOENIX')], [{ code: 'AZA', city: 'Phoenix, AZ', state: 'AZ', country: 'US' }]);
    expect(out.airports[0]).toMatchObject({ code: 'AZA', faaId: 'IWA', faaMatchMethod: 'override', faaMatched: true });
  });
  it('does not attach an FAA record from a different place that shares the identifier', async () => {
    const out = await build([fac('ABC', 'TX', 'DALLAS')], [{ code: 'ABC', city: 'Boise, ID', state: 'ID', country: 'US' }]);
    expect(out.airports[0]).toMatchObject({ faaMatched: false, faaIssue: 'state-mismatch', runways: [] });
    expect(out.airports[0]).not.toHaveProperty('lat');
    expect(out.summary.stateMismatches).toBe(1);
  });
  it('keeps unmatched US airports (no coordinates) and foreign airports without querying FAA for them', async () => {
    const out = await build([], [{ code: 'KLW', city: 'Klawock, AK', state: 'AK', country: 'US' }, { code: 'LHR', city: 'London, United Kingdom', country: 'GB' }]);
    expect(out.airports.find((x) => x.code === 'KLW')).toMatchObject({ faaMatched: false, faaIssue: 'not-found' });
    expect(out.airports.find((x) => x.code === 'LHR')).not.toHaveProperty('faaIssue');
    expect(out.summary).toMatchObject({ total: 2, unmatched: 1 });
  });
  it('flags a code that BTS lists under several airport ids', async () => {
    const out = await build([], [{ code: 'ZZZ', country: 'US', btsIds: ['1', '2'] }]);
    expect(out.airports[0]?.ambiguousCode).toBe(true);
  });
});
