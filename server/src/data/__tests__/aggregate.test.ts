import { describe, expect, it } from 'vitest';
import { OnTimeAggregator, SegmentAggregator, deriveOnTime, medianFromHistogram, sumOnTime, type Row } from '../aggregate.js';

const seg = (o: Partial<Row> = {}): Row => ({
  YEAR: '2026', MONTH: '8', ORIGIN: 'ANC', DEST: 'SEA', CLASS: 'F', DISTANCE: '1448', DEPARTURES_SCHEDULED: '10', DEPARTURES_PERFORMED: '10',
  SEATS: '1500', PASSENGERS: '1200', FREIGHT: '100', MAIL: '0', ORIGIN_CITY_NAME: 'Anchorage, AK', ORIGIN_STATE_ABR: 'AK', ORIGIN_COUNTRY: 'US',
  ORIGIN_AIRPORT_ID: '10299', DEST_CITY_NAME: 'Seattle, WA', DEST_STATE_ABR: 'WA', DEST_COUNTRY: 'US', DEST_AIRPORT_ID: '14747', ...o,
});

describe('SegmentAggregator', () => {
  it('sums carriers and aircraft types for the same route, class and month', () => {
    const a = new SegmentAggregator('2026-08');
    a.add(seg());
    a.add(seg({ DEPARTURES_PERFORMED: '5', DEPARTURES_SCHEDULED: '6', SEATS: '700', PASSENGERS: '500' }));
    a.add(seg({ CLASS: 'G', DEPARTURES_PERFORMED: '3', DEPARTURES_SCHEDULED: '3', SEATS: '0', PASSENGERS: '0', FREIGHT: '9000' }));
    expect(a.records()).toHaveLength(2);
    expect(a.records().find((r) => r.cls === 'F')).toMatchObject({ depsPerformed: 15, depsScheduled: 16, seats: 2200, passengers: 1700, distance: 1448 });
  });
  it('drops all-zero rows but still learns the airports, and counts what it dropped', () => {
    const a = new SegmentAggregator('2026-08');
    a.add(seg({ ORIGIN: 'VQS', DEPARTURES_SCHEDULED: '0', DEPARTURES_PERFORMED: '0', SEATS: '0', PASSENGERS: '0', FREIGHT: '0' }));
    expect(a.records()).toEqual([]);
    expect(a.stats.rowsInactive).toBe(1);
    expect(a.airports().map((x) => x.code)).toContain('VQS');
  });
  it('does not treat a missing numeric cell as zero: the row is rejected and counted', () => {
    const a = new SegmentAggregator('2026-08');
    a.add(seg({ SEATS: '' }));
    a.add(seg({ DISTANCE: 'n/a' }));
    expect(a.records()).toEqual([]);
    expect(a.stats.rowsInvalid).toBe(2);
  });
  it('ignores rows from another month and records ambiguous airport ids', () => {
    const a = new SegmentAggregator('2026-08');
    a.add(seg({ MONTH: '7' }));
    a.add(seg());
    a.add(seg({ ORIGIN_AIRPORT_ID: '99999' }));
    expect(a.stats.rowsOutsideMonth).toBe(1);
    expect(a.airports().find((x) => x.code === 'ANC')?.btsIds).toEqual(['10299', '99999']);
  });
  it('flags conflicting distances for the same route', () => {
    const a = new SegmentAggregator('2026-08');
    a.add(seg());
    a.add(seg({ DISTANCE: '1500' }));
    expect(a.stats.distanceConflicts).toBe(1);
  });
});

const flight = (o: Partial<Row> = {}): Row => ({
  YEAR: '2026', MONTH: '8', ORIGIN: 'LAX', DEST: 'SNA', OP_UNIQUE_CARRIER: 'AA', CANCELLED: '0.00', DIVERTED: '0.00', DEP_DEL15: '0.00', DEP_DELAY_NEW: '0.00',
  TAXI_OUT: '15', ARR_DEL15: '0.00', ARR_DELAY_NEW: '0.00', TAXI_IN: '5', CANCELLATION_CODE: '', CARRIER_DELAY: '', WEATHER_DELAY: '', NAS_DELAY: '', SECURITY_DELAY: '', LATE_AIRCRAFT_DELAY: '', ...o,
});

describe('OnTimeAggregator', () => {
  it('counts departures at the origin and arrivals at the destination separately', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ DEP_DEL15: '1.00', DEP_DELAY_NEW: '30', ARR_DEL15: '1.00', ARR_DELAY_NEW: '25', CARRIER_DELAY: '10', WEATHER_DELAY: '0', NAS_DELAY: '15', SECURITY_DELAY: '0', LATE_AIRCRAFT_DELAY: '0' }));
    a.add(flight());
    const [lax, sna] = [a.records().find((r) => r.airport === 'LAX'), a.records().find((r) => r.airport === 'SNA')];
    expect(lax?.dep).toMatchObject({ scheduled: 2, delayMeasured: 2, delayed15: 1, delayMinutes: 30, taxiOutN: 2, taxiOutSum: 30 });
    expect(lax?.arr.scheduled).toBe(0);
    expect(sna?.arr).toMatchObject({ scheduled: 2, delayed15: 1, delayMinutes: 25, causeFlights: 1, causeMinutes: { carrier: 10, nas: 15 } });
  });
  it('keeps cancelled flights out of delay and taxi statistics and records the cancellation code', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ CANCELLED: '1.00', CANCELLATION_CODE: 'B', DEP_DEL15: '', TAXI_OUT: '', ARR_DEL15: '' }));
    const lax = a.records().find((r) => r.airport === 'LAX');
    expect(lax?.dep).toMatchObject({ scheduled: 1, cancelled: 1, cancelledByCode: { B: 1 }, delayMeasured: 0, taxiOutN: 0 });
  });
  it('does not count a blank delay as an on-time flight', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ DEP_DEL15: '', TAXI_OUT: '' }));
    expect(a.records().find((r) => r.airport === 'LAX')?.dep).toMatchObject({ scheduled: 1, delayMeasured: 0, delayed15: 0, taxiOutN: 0 });
  });
  it('records diverted arrivals separately from delayed ones, and ignores other months', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ DIVERTED: '1.00', ARR_DEL15: '' }));
    a.add(flight({ MONTH: '9' }));
    expect(a.records().find((r) => r.airport === 'SNA')?.arr).toMatchObject({ scheduled: 1, diverted: 1, delayMeasured: 0 });
    expect(a.stats.rowsOutsideMonth).toBe(1);
  });
  it('requires all five cause fields before attributing minutes', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ ARR_DEL15: '1.00', CARRIER_DELAY: '10' }));
    expect(a.records().find((r) => r.airport === 'SNA')?.arr.causeFlights).toBe(0);
  });
});

describe('combining months', () => {
  const month = (m: string, flights: Array<Partial<Row>>) => {
    const a = new OnTimeAggregator(m);
    for (const f of flights) a.add(flight({ MONTH: String(Number(m.slice(5))), ...f }));
    return a.records().find((r) => r.airport === 'LAX');
  };

  it('derives rates from summed counts, not from averaging monthly percentages', () => {
    // June: 1 of 1 flight late (100%). July: 1 of 9 late (11%). Averaging gives 55.6%; the true rate is 2/10.
    const june = month('2026-06', [{ DEP_DEL15: '1.00', DEP_DELAY_NEW: '40' }]);
    const july = month('2026-07', [{ DEP_DEL15: '1.00', DEP_DELAY_NEW: '20' }, ...Array.from({ length: 8 }, () => ({}))]);
    const d = deriveOnTime(sumOnTime([june!, july!]));
    expect(d.departureDelayRate15).toBeCloseTo(0.2, 10);
    expect(d.meanDepartureDelayMin).toBeCloseTo(6, 10);
    expect(d.scheduledDepartures).toBe(10);
  });
  it('computes the median taxi-out from merged histograms, not by averaging monthly medians', () => {
    const june = month('2026-06', [{ TAXI_OUT: '10' }, { TAXI_OUT: '10' }, { TAXI_OUT: '10' }]);
    const july = month('2026-07', [{ TAXI_OUT: '40' }, { TAXI_OUT: '50' }]);
    // monthly medians are 10 and 45 (mean 27.5); the true median of {10,10,10,40,50} is 10.
    expect(deriveOnTime(sumOnTime([june!, july!])).medianTaxiOutMin).toBe(10);
  });
  it('medianFromHistogram handles even counts and empty input', () => {
    expect(medianFromHistogram({ '10': 1, '20': 1 })).toBe(15);
    expect(medianFromHistogram({})).toBeUndefined();
  });
  it('reports undefined, not 0, when there is nothing to divide by', () => {
    const d = deriveOnTime(sumOnTime([]));
    expect(d.departureDelayRate15).toBeUndefined();
    expect(d.cancellationRate).toBeUndefined();
    expect(d.medianTaxiOutMin).toBeUndefined();
    expect(d.delayCauseShare).toBeUndefined();
  });
  it('shares delay-cause minutes that sum to 1', () => {
    const a = new OnTimeAggregator('2026-08');
    a.add(flight({ ARR_DEL15: '1.00', CARRIER_DELAY: '30', WEATHER_DELAY: '10', NAS_DELAY: '0', SECURITY_DELAY: '0', LATE_AIRCRAFT_DELAY: '60' }));
    const share = deriveOnTime(sumOnTime(a.records().filter((r) => r.airport === 'SNA'))).delayCauseShare!;
    expect(share.lateAircraft).toBeCloseTo(0.6);
    expect(Object.values(share).reduce((x, y) => x + y, 0)).toBeCloseTo(1);
  });
});
