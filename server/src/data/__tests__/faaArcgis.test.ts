import { describe, expect, it } from 'vitest';
import { FaaArcgisClient } from '../faaArcgis.js';
import { json, scriptedFetch } from './support.js';

const feat = (id: string, extra: Record<string, unknown> = {}) => ({
  attributes: { ARPT_ID: id, ARPT_NAME: `${id} INTL`, CITY: 'X', STATE_CODE: 'OR', FAR_139_CARRIER_SER_CODE: 'S', LAT_DECIMAL: 45.5, LONG_DECIMAL: -122.6, EFF_DATE: '2026/10/29', ...extra },
});
const client = (responses: Parameters<typeof scriptedFetch>[0]) => {
  const s = scriptedFetch(responses);
  return { ...s, faa: new FaaArcgisClient({ fetch: s.fetch, backoffMs: 0, retries: 0, now: () => new Date('2026-11-25T00:00:00Z') }) };
};

describe('FaaArcgisClient', () => {
  it('maps facilities, treating null fields as missing and Part 139 code S as scheduled service', async () => {
    const { faa } = client([json({ features: [feat('PDX'), feat('XYZ', { FAR_139_CARRIER_SER_CODE: null, LAT_DECIMAL: null })] })]);
    const { data, provenance } = await faa.airportsByCode(['PDX', 'XYZ']);
    expect(data[0]).toMatchObject({ faaId: 'PDX', scheduledService: true, lat: 45.5 });
    expect(data[1]).toMatchObject({ faaId: 'XYZ', scheduledService: false });
    expect(data[1]).not.toHaveProperty('lat');
    expect(provenance.note).toContain('2026/10/29');
  });
  it('paginates while the server reports exceededTransferLimit', async () => {
    const { faa, calls } = client([json({ features: [feat('AAA')], exceededTransferLimit: true }), json({ features: [feat('BBB')] })]);
    expect((await faa.airportsInStates(['OR'])).data.map((a) => a.faaId)).toEqual(['AAA', 'BBB']);
    expect(calls).toHaveLength(2);
  });
  it('surfaces an ArcGIS error returned with HTTP 200', async () => {
    const { faa } = client([json({ features: [], error: { message: 'Invalid query' } })]);
    await expect(faa.airportsByCode(['PDX'])).rejects.toMatchObject({ kind: 'invalid-request' });
  });
  it('keeps the first of duplicated identifiers', async () => {
    const { faa } = client([json({ features: [feat('PDX', { ARPT_NAME: 'FIRST' }), feat('PDX', { ARPT_NAME: 'SECOND' })] })]);
    const { data } = await faa.airportsByCode(['PDX']);
    expect(data).toHaveLength(1);
    expect(data[0]?.name).toBe('FIRST');
  });
  it('rejects unsafe input before any request, and malformed payloads after', async () => {
    const { faa, calls } = client([json({ features: 'nope' })]);
    await expect(faa.airportsByCode(["A'B"])).rejects.toMatchObject({ kind: 'invalid-request' });
    await expect(faa.airportsInStates(['Oregon'])).rejects.toMatchObject({ kind: 'invalid-request' });
    expect(calls).toHaveLength(0);
    await expect(faa.airportsByCode(['PDX'])).rejects.toMatchObject({ kind: 'invalid-response' });
  });
  it('splits long code lists across requests to keep query strings short', async () => {
    const codes = Array.from({ length: 130 }, (_, i) => `X${i.toString(36).toUpperCase().padStart(2, '0')}`);
    const { faa, calls } = client([json({ features: [] })]);
    await faa.airportsByCode(codes);
    expect(calls).toHaveLength(3);
  });
  it('returns runways', async () => {
    const { faa } = client([json({ features: [{ attributes: { ARPT_ID: 'PDX', RWY_ID: '10L/28R', RWY_LEN: 9825, RWY_WIDTH: 150, SURFACE_TYPE_CODE: null } }] })]);
    expect((await faa.runways(['PDX'])).data).toEqual([{ airport: 'PDX', id: '10L/28R', lengthFt: 9825, widthFt: 150 }]);
  });
});
