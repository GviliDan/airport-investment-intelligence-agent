import { describe, expect, it } from 'vitest';
import { BtsSocrataClient, mapRows } from '../btsSocrata.js';
import { json, scriptedFetch } from './support.js';

const row = (code: string, month: string) => ({
  origin_airport_code: code,
  origin_airport_name: `${code} Intl (${code})`,
  reporting_month: `${month}-01T00:00:00.000`,
  total_departures: '100',
  total_passengers: '9000',
  total_seats: '12000',
  total_load_factor: '75.0',
});
const client = (responses: Parameters<typeof scriptedFetch>[0], o = {}) => {
  const s = scriptedFetch(responses);
  return { ...s, bts: new BtsSocrataClient({ fetch: s.fetch, backoffMs: 0, retries: 0, now: () => new Date('2026-11-25T00:00:00Z'), ...o }) };
};

describe('mapRows', () => {
  it('converts numeric strings and leaves omitted fields undefined (not 0)', () => {
    const [r] = mapRows([{ origin_airport_code: 'ABC', reporting_month: '2026-08-01T00:00:00.000', total_passengers: '0' }]);
    expect(r).toEqual({ airport: 'ABC', month: '2026-08', passengers: 0 });
    expect(r).not.toHaveProperty('seats');
  });
  it('rejects malformed rows with a ProviderError', () => {
    expect(() => mapRows([{ origin_airport_code: 'TOOLONG', reporting_month: '2026-08-01T00:00:00.000' }])).toThrow(/bts-socrata: unexpected traffic rows/);
    expect(() => mapRows({ not: 'an array' })).toThrow(/bts-socrata/);
  });
});

describe('BtsSocrataClient', () => {
  it('returns rows with provenance for the requested period', async () => {
    const { bts, calls } = client([json([row('PDX', '2026-07'), row('PDX', '2026-08')])]);
    const out = await bts.monthlyTraffic({ airports: ['PDX'], from: '2026-07', to: '2026-08' });
    expect(out.data.map((r) => r.month)).toEqual(['2026-07', '2026-08']);
    expect(out.provenance).toMatchObject({ source: 'bts-socrata', period: { start: '2026-07', end: '2026-08' }, retrievedAt: '2026-11-25T00:00:00.000Z' });
    expect(decodeURIComponent((calls[0]?.url ?? '').replace(/\+/g, ' '))).toContain("origin_airport_code in('PDX')");
  });
  it('follows pagination until a short page', async () => {
    const { bts, calls } = client([json([row('AAA', '2026-06'), row('AAA', '2026-07')]), json([row('AAA', '2026-08')])], { pageSize: 2 });
    const out = await bts.monthlyTraffic({ airports: ['AAA'], from: '2026-06', to: '2026-08' });
    expect(out.data).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('%24offset=2');
  });
  it('rejects duplicate airport-months instead of double counting', async () => {
    const { bts } = client([json([row('PDX', '2026-07'), row('PDX', '2026-07')])]);
    await expect(bts.monthlyTraffic({ airports: ['PDX'], from: '2026-07', to: '2026-07' })).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('validates input before any request is made', () => {
    const { bts, calls } = client([json([])]);
    expect(() => bts.monthlyTraffic({ airports: ["X'Y"], from: '2026-07', to: '2026-08' })).toThrow(/airport codes/);
    expect(() => bts.monthlyTraffic({ from: '2026-08', to: '2026-07' })).toThrow(/invalid period/);
    expect(calls).toHaveLength(0);
  });
  it('answers an empty airport list without a request', async () => {
    const { bts, calls } = client([json([])]);
    expect((await bts.monthlyTraffic({ airports: [], from: '2026-07', to: '2026-08' })).data).toEqual([]);
    expect(calls).toHaveLength(0);
  });
  it('caches identical queries and does not cache failures', async () => {
    const q = { airports: ['PDX'], from: '2026-07', to: '2026-07' } as const;
    const ok = client([json([row('PDX', '2026-07')])]);
    await ok.bts.monthlyTraffic(q);
    await ok.bts.monthlyTraffic(q);
    expect(ok.calls).toHaveLength(1);
    const failing = client([new Error('boom'), json([row('PDX', '2026-07')])]);
    await expect(failing.bts.monthlyTraffic(q)).rejects.toThrow();
    await expect(failing.bts.monthlyTraffic(q)).resolves.toBeDefined();
  });
  it('reads the published period', async () => {
    const { bts } = client([json([{ mn: '2014-01-01T00:00:00.000', mx: '2026-08-01T00:00:00.000' }])]);
    expect((await bts.availablePeriod()).data).toEqual({ start: '2014-01', end: '2026-08' });
  });
});
