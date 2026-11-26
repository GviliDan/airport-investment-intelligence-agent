import { describe, expect, it } from 'vitest';
import { FaaNasStatusClient, parseNasStatus } from '../faaNasStatus.js';
import { scriptedFetch, text } from './support.js';

const XML = `<AIRPORT_STATUS_INFORMATION><Update_Time>Wed Nov 25 15:01:06 2026 GMT</Update_Time>
<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SAN</ARPT><Reason>airport volume</Reason><Avg>27 minutes</Avg><Max>1 hour and 10 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>
<Delay_type><Name>General Arrival/Departure Delay Info</Name><Arrival_Departure_Delay_List>
<Delay><ARPT>MCO</ARPT><Reason>TM Initiatives:MIT:VOL</Reason><Arrival_Departure Type="Departure"><Min>16 minutes</Min><Max>30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay>
<Delay><ARPT>PHL</ARPT><Reason>TM Initiatives:SWAP:WX</Reason><Arrival_Departure Type="Departure"><Min>31 minutes</Min><Max>45 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay>
</Arrival_Departure_Delay_List></Delay_type>
<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>LAX</ARPT><Reason>!LAX AD AP CLSD TO NON SKED TRANSIENT GA</Reason><Start>May 27 at 18:26 UTC.</Start></Airport></Airport_Closure_List></Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

describe('parseNasStatus', () => {
  it('parses each kind of event with the FAA wording intact', () => {
    const s = parseNasStatus(XML);
    expect(s.updatedAt).toBe('Wed Nov 25 15:01:06 2026 GMT');
    expect(s.events.map((e) => [e.airport, e.kind])).toEqual([
      ['SAN', 'ground-delay-program'],
      ['MCO', 'arrival-departure-delay'],
      ['PHL', 'arrival-departure-delay'],
      ['LAX', 'airport-closure'],
    ]);
    expect(s.events[0]).toMatchObject({ reason: 'airport volume', detail: { Avg: '27 minutes', Max: '1 hour and 10 minutes' } });
    expect(s.events[1]?.detail).toMatchObject({ type: 'Departure', min: '16 minutes', trend: 'Increasing' });
  });
  it('handles a feed with no events', () => {
    expect(parseNasStatus('<AIRPORT_STATUS_INFORMATION><Update_Time>t</Update_Time></AIRPORT_STATUS_INFORMATION>').events).toEqual([]);
  });
  it('handles a single event (XML parsers return an object, not an array)', () => {
    const one = '<AIRPORT_STATUS_INFORMATION><Delay_type><Name>Ground Stops</Name><Ground_Stop_List><Program><ARPT>EWR</ARPT><Reason>wx</Reason></Program></Ground_Stop_List></Delay_type></AIRPORT_STATUS_INFORMATION>';
    expect(parseNasStatus(one).events).toMatchObject([{ airport: 'EWR', kind: 'ground-stop' }]);
  });
  it('rejects a response that is not the expected document', () => {
    expect(() => parseNasStatus('<html>maintenance</html>')).toThrow(/missing|invalid/i);
  });
});

describe('FaaNasStatusClient', () => {
  it('filters by airport, caches, and labels the data as current only', async () => {
    const { fetch, calls } = scriptedFetch([text(XML)]);
    const c = new FaaNasStatusClient({ fetch, backoffMs: 0, now: () => new Date('2026-11-25T15:02:00Z') });
    const mco = await c.forAirport('MCO');
    expect(mco.data).toHaveLength(1);
    expect((await c.forAirport('SFO')).data).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(mco.provenance.note).toMatch(/Current operational status only/);
  });
  it('propagates provider failures', async () => {
    const { fetch } = scriptedFetch([text('down', 503)]);
    await expect(new FaaNasStatusClient({ fetch, backoffMs: 0, retries: 0 }).current()).rejects.toMatchObject({ kind: 'http', status: 503 });
  });
});
