import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveOnTime, sumOnTime } from '../aggregate.js';
import { PROCESSED_DIR } from '../files.js';
import { DataStoreError, loadDataStore } from '../store.js';

// These tests run against the committed processed datasets, so they also guard the shipped data.
describe('committed processed datasets', async () => {
  const store = await loadDataStore();

  it('aligns route and on-time data on three complete months', () => {
    expect(store.alignedMonths).toEqual(['2026-06', '2026-07', '2026-08']);
    expect(store.manifest.alignedMonths).toEqual(store.alignedMonths);
  });

  it('covers airports across the country, not one region', () => {
    const states = new Set(store.airports.airports.filter((a) => a.faaMatched).map((a) => a.state));
    for (const s of ['MA', 'CA', 'AK', 'HI', 'TX', 'FL', 'OR', 'NM', 'PR']) expect(states.has(s)).toBe(true);
    expect(store.onTimeByAirport.size).toBeGreaterThan(300);
  });

  it('segment totals agree with the independently published T-100 summary', () => {
    const byAirport = new Map<string, number>();
    for (const s of store.segments) if (s.month === '2026-08') byAirport.set(s.origin, (byAirport.get(s.origin) ?? 0) + s.depsPerformed);
    for (const code of ['LAX', 'SFO', 'ANC', 'BOS']) {
      const summary = store.trafficByAirport.get(code)?.find((r) => r.month === '2026-08')?.departures;
      expect(byAirport.get(code)).toBe(summary);
    }
  });

  it('reproduces the figures verified by hand from the raw BTS files (Aug 2026)', () => {
    const aug = (code: string) => deriveOnTime(sumOnTime((store.onTimeByAirport.get(code) ?? []).filter((r) => r.month === '2026-08')));
    expect(aug('LAX')).toMatchObject({ scheduledDepartures: 16494, medianTaxiOutMin: 17 });
    expect(aug('SNA')).toMatchObject({ scheduledDepartures: 3898, medianTaxiOutMin: 14 });
    expect(aug('SFO').medianTaxiOutMin).toBe(25);
    expect(aug('SFO').departureDelayRate15).toBeCloseTo(0.319, 2);
    const anc = store.segments.filter((s) => s.origin === 'ANC' && s.cls === 'F' && s.month === '2026-08');
    const total = anc.reduce((s, r) => s + r.depsPerformed, 0);
    expect(total).toBe(4572);
    expect(anc.filter((r) => r.distance >= 3000).reduce((s, r) => s + r.depsPerformed, 0)).toBe(206);
  });

  it('keeps data gaps visible: unmatched airports have no coordinates, and on-time coverage is partial', () => {
    expect(store.airports.get('KLW')?.lat).toBeUndefined();
    const jfk = store.onTimeCoverage('JFK');
    expect(jfk.ratio).toBeGreaterThan(0.3);
    expect(jfk.ratio).toBeLessThan(0.8);
    expect(store.onTimeCoverage('NOPE').ratio).toBeUndefined();
  });

  it('resolves the assignment airports and real regional names', () => {
    expect(store.airports.resolve('Santa Ana')).toMatchObject({ status: 'found', airport: { code: 'SNA' } });
    // Anchorage has several airports; ANC carries nearly all traffic, so it is suggested but still reported as ambiguous.
    expect(store.airports.resolve('Anchorage')).toMatchObject({ status: 'ambiguous', suggested: { code: 'ANC' } });
    expect(store.airports.resolve('New York').status).toBe('ambiguous');
    expect(store.airports.resolve('Portland').status).toBe('ambiguous');
  });

  it('documents sources, periods and generation time in the manifest', () => {
    for (const d of ['traffic-monthly', 'route-segments', 'ontime-airport-month']) {
      expect(store.manifest.datasets[d]?.source).toMatch(/BTS/);
    }
    expect(Number.isNaN(Date.parse(store.manifest.generatedAt))).toBe(false);
  });
});

describe('loadDataStore failures', () => {
  it('reports a missing file by name instead of running on partial data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'store-'));
    try {
      await cp(PROCESSED_DIR, dir, { recursive: true });
      await rm(join(dir, 'route-segments.csv.gz'));
      await expect(loadDataStore(dir)).rejects.toThrow(DataStoreError);
      await expect(loadDataStore(dir)).rejects.toThrow(/route-segments\.csv\.gz is missing/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
