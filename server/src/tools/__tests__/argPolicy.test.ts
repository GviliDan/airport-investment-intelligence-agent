import { describe, expect, it } from 'vitest';
import { applyArgPolicy, numbersIn, placesIn, type PriorCall } from '../argPolicy.js';

const ctx = (userText: string, prior: PriorCall[] = []) => ({ userText, prior });
const call = (tool: string, args: Record<string, unknown>, explicit: string[] = []): PriorCall => ({ tool, args, explicit });

describe('numbersIn / placesIn', () => {
  it('reads the numbers people write', () => {
    const n = numbersIn('over 5 million passengers, 2,500 miles, 500k, six months, last year, 12.5%');
    for (const v of [5_000_000, 2500, 500_000, 6, 12, 12.5]) expect(n.has(v), String(v)).toBe(true);
  });
  it('does not read a unit out of the next word ("3000 miles" is not 3 billion, "2 more" is not 2 million)', () => {
    const miles = numbersIn('flights of 3000 miles');
    expect(miles.has(3000)).toBe(true);
    expect(miles.has(3_000_000_000)).toBe(false);
    const more = numbersIn('show 2 more airports');
    expect(more.has(2)).toBe(true);
    expect(more.has(2_000_000)).toBe(false);
    expect(numbersIn('over 2m, 3 mm, 4 million, 1.5bn').has(2_000_000)).toBe(true);
    expect(numbersIn('top 2nd 1000s').has(1000)).toBe(true);
  });
  it('finds named states and regions, case-sensitively for codes', () => {
    expect([...placesIn('airports in Texas and WA').states].sort()).toEqual(['TX', 'WA']);
    expect(placesIn('ma and pa airports').states.size).toBe(0);
    expect(placesIn('the Pacific region').regions.has('Pacific')).toBe(true);
    expect(placesIn('rank them').any).toBe(false);
  });
});

describe('unrequested narrowing parameters', () => {
  it('ignores a passenger floor the user never mentioned, and says so', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { states: ['MA'], min_passengers: 500_000 }, ctx('Which airports in MA are best for expansion?'));
    expect(r.args.min_passengers).toBeUndefined();
    expect(r.notices).toEqual([expect.objectContaining({ kind: 'ignored_parameter', param: 'min_passengers' })]);
  });
  it('keeps a value the user stated, in any common form', () => {
    for (const text of ['airports over 500,000 passengers', 'at least 500k passengers', 'at least 500000 passengers']) {
      expect(applyArgPolicy('screen_airports', { min_passengers: 500_000 }, ctx(text)).args.min_passengers, text).toBe(500_000);
    }
    expect(applyArgPolicy('screen_airports', { min_passengers: 5_000_000 }, ctx('more than 5 million passengers')).args.min_passengers).toBe(5_000_000);
  });
  it('never polices a tool default', () => {
    expect(applyArgPolicy('rank_expansion_opportunities', { min_passengers: 100_000, window_months: 12 }, ctx('rank Texas')).notices).toEqual([]);
  });
  it('ignores a threshold or window the user did not ask for', () => {
    expect(applyArgPolicy('get_long_haul_share', { airport: 'ANC', threshold_miles: 2500 }, ctx('long haul share at ANC')).args.threshold_miles).toBeUndefined();
    expect(applyArgPolicy('get_traffic_metrics', { airports: ['LAX'], window_months: 6 }, ctx('LAX growth')).args.window_months).toBeUndefined();
    expect(applyArgPolicy('get_long_haul_share', { airport: 'ANC', threshold_miles: 2300 }, ctx('what if long haul means 2,300 miles or more?')).args.threshold_miles).toBe(2300);
  });
  it('does not remove a legitimate implicit change: doubling a weight is backed by the earlier call', () => {
    const prior = [call('rank_expansion_opportunities', { states: ['TX'], weights: { momentum: 25, scale: 20 } }, ['states', 'weights'])];
    const r = applyArgPolicy('rank_expansion_opportunities', { states: ['TX'], weights: { momentum: 50, scale: 20 } }, ctx('double the weight on growth', prior));
    expect(r.args.weights).toEqual({ momentum: 50, scale: 20 });
    expect(r.notices.some((n) => n.kind === 'ignored_parameter')).toBe(false);
  });
  it('accepts weights when the user talks about weighting, rejects invented ones', () => {
    expect(applyArgPolicy('rank_expansion_opportunities', { weights: { momentum: 60 } }, ctx('weight passenger growth more heavily')).args.weights).toEqual({ momentum: 60 });
    expect(applyArgPolicy('rank_expansion_opportunities', { weights: { momentum: 60 } }, ctx('rank Texas')).args.weights).toBeUndefined();
  });
  it('ignores option switches the user did not mention', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { correlation_adjustment: false, missing_data_policy: 'redistribute' }, ctx('rank Texas'));
    expect(r.args.correlation_adjustment).toBeUndefined();
    expect(r.args.missing_data_policy).toBeUndefined();
    expect(applyArgPolicy('rank_expansion_opportunities', { correlation_adjustment: false }, ctx('turn off the correlation adjustment')).args.correlation_adjustment).toBe(false);
  });
  it('ignores cargo classes unless the user asks for cargo or charters', () => {
    expect(applyArgPolicy('get_long_haul_share', { airport: 'ANC', service_classes: ['F', 'G'] }, ctx('long haul at ANC')).args.service_classes).toBeUndefined();
    expect(applyArgPolicy('get_long_haul_share', { airport: 'ANC', service_classes: ['F', 'G'] }, ctx('include cargo flights')).args.service_classes).toEqual(['F', 'G']);
  });
  it('checks the numbers inside filters', () => {
    const f = [{ metric: 'loadFactorPct', min: 84 }];
    expect(applyArgPolicy('screen_airports', { filters: f }, ctx('airports with load factor above 84%')).args.filters).toEqual(f);
    expect(applyArgPolicy('screen_airports', { filters: f }, ctx('list the busiest airports')).args.filters).toBeUndefined();
  });
});

describe('carrying explicit parameters through follow-ups', () => {
  const prior = [call('rank_expansion_opportunities', { states: ['TX'], weights: { momentum: 60 }, min_passengers: 500_000 }, ['states', 'weights', 'min_passengers'])];
  it('restores weights and a floor the user set earlier when the model leaves them out', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { states: ['FL'] }, ctx('Do the same for Florida', prior));
    expect(r.args.weights).toEqual({ momentum: 60 });
    expect(r.args.min_passengers).toBe(500_000);
    expect(r.notices.filter((n) => n.kind === 'inherited_parameter').map((n) => n.param).sort()).toEqual(['min_passengers', 'weights']);
  });
  it('does not carry anything over when the user says to reset', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { states: ['FL'] }, ctx('Florida again, but reset to the defaults', prior));
    expect(r.args.weights).toBeUndefined();
  });
  it('only carries what was explicit: an ignored assumption is not remembered', () => {
    const p = [call('rank_expansion_opportunities', { states: ['TX'], min_passengers: 500_000 }, ['states'])];
    expect(applyArgPolicy('rank_expansion_opportunities', { states: ['FL'] }, ctx('Florida', p)).args.min_passengers).toBeUndefined();
  });
});

describe('geographic scope', () => {
  const prior = [call('rank_expansion_opportunities', { states: ['TX'] }, ['states'])];
  it('keeps the earlier scope when the model drops it and the user named no place', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { weights: { momentum: 60 } }, ctx('Now weight growth more heavily', prior));
    expect(r.args.states).toEqual(['TX']);
    expect(r.notices.find((n) => n.kind === 'scope_restored')?.message).toMatch(/states TX/);
  });
  it('lets the user widen the scope explicitly', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', {}, ctx('Now all US airports', prior));
    expect(r.args.states).toBeUndefined();
    expect(r.notices.some((n) => n.kind === 'scope_restored')).toBe(false);
  });
  it('accepts a new scope the user named, by name or code', () => {
    expect(applyArgPolicy('rank_expansion_opportunities', { states: ['Florida'] }, ctx('Do the same for Florida', prior)).notices.some((n) => n.kind.startsWith('scope'))).toBe(false);
    expect(applyArgPolicy('screen_airports', { states: ['FL'] }, ctx('screen FL', prior)).notices).toEqual([]);
    expect(applyArgPolicy('screen_airports', { region: 'Pacific' }, ctx('airports in the Pacific region')).notices).toEqual([]);
  });
  it('undoes an unrequested scope change when there is an earlier scope', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { states: ['CA'] }, ctx('Now weight growth more', prior));
    expect(r.args.states).toEqual(['TX']);
    expect(r.notices[0]).toMatchObject({ kind: 'scope_restored' });
  });
  it('keeps but reports an interpretation of an informal place when there is no earlier scope', () => {
    const r = applyArgPolicy('screen_airports', { states: ['FL', 'GA', 'AL'] }, ctx('highest load factor in the Southeast'));
    expect(r.args.states).toEqual(['FL', 'GA', 'AL']);
    expect(r.notices[0]).toMatchObject({ kind: 'scope_interpreted' });
    expect(r.notices[0]?.message).toMatch(/states FL, GA, AL/);
  });
  it('treats airports named in the text or earlier calls as grounded', () => {
    expect(applyArgPolicy('screen_airports', { airport_codes: ['AUS', 'IAH'] }, ctx('compare AUS and IAH')).notices).toEqual([]);
    const p = [call('rank_expansion_opportunities', { states: ['TX'] }, ['states']), call('compare_operations', { airports: ['AUS'] })];
    expect(applyArgPolicy('screen_airports', { airport_codes: ['AUS'] }, ctx('screen those', p)).notices).toEqual([]);
  });
  it('does nothing for tools without a scope', () => {
    expect(applyArgPolicy('get_long_haul_share', { airport: 'ANC' }, ctx('ANC long haul', prior)).notices).toEqual([]);
  });
});

describe('review fixes', () => {
  it('does not treat a metric word alone as a request to change weights', () => {
    const r = applyArgPolicy('rank_expansion_opportunities', { weights: { momentum: 60 } }, ctx('Which Texas airports have the best growth?'));
    expect(r.args.weights).toBeUndefined();
  });
  it('accepts a percentage the user wrote when the filter uses a fraction', () => {
    const f = [{ metric: 'internationalDepartureShare', min: 0.25 }];
    expect(applyArgPolicy('screen_airports', { filters: f }, ctx('airports with at least 25% international departures')).args.filters).toEqual(f);
  });
});
