import { describe, expect, it } from 'vitest';
import { digestCall } from '../digest.js';
import { checkGrounding, collectNumbers, extractClaims, redactUngrounded } from '../grounding.js';
import { backoffDelay, isQuotaExhausted, isTransient, withBackoff } from '../retry.js';

const pool = (...sources: unknown[]) => sources.reduce<Set<number>>((s, x) => collectNumbers(x, s), new Set());
const claimsOf = (t: string) => extractClaims(t).map((c) => c.text);

describe('extractClaims', () => {
  it('finds figures with units, decimals and thousands separators', () => {
    expect(claimsOf('Share was 4.55% (628 of 13,794) over 3,000 miles with 24 minutes taxi.')).toEqual(['4.55%', '628', '13,794', '3,000 miles', '24 minutes']);
  });
  it('ignores ISO periods, list markers, ranks, small counts and 50/100', () => {
    expect(claimsOf('1. BOS ranks #2; the 2025-09..2026-08 window; 3 airports; 12 months; the 50th percentile; score out of 100')).toEqual([]);
  });
  it('checks years, so an invented period is caught', () => {
    expect(claimsOf('Data from September 2005 through 2026')).toEqual(['2005', '2026']);
  });
  it('ignores digits inside airport codes and identifiers', () => {
    expect(claimsOf('Airports A43 and 2NY, runway 10L/28R, DEP_DEL15')).toEqual([]);
  });
  it('reads K/M/B abbreviations as scale', () => {
    const [c] = extractClaims('about 21.0 million passengers');
    expect(c).toMatchObject({ value: 21, decimals: 1, scale: 1e6 });
  });
});

describe('checkGrounding', () => {
  const tool = { passengers: 20_984_982, rate: 0.241478, gap: -0.8, share: 0.045527, count: 13794, note: 'delayed 15 minutes or more; runways of 5,000 ft' };
  it('accepts exact, rounded and truncated renderings, percent conversions and abbreviations', () => {
    const text = 'There were 20,984,982 passengers (about 21.0 million, 21 million). Delays hit 24.1% (24%), the share was 4.55% and 4.5%, with 13,794 departures; the gap is -0.8 points.';
    expect(checkGrounding(text, pool(tool))).toMatchObject({ ungrounded: [] });
  });
  it('flags invented or mis-calculated figures', () => {
    const r = checkGrounding('Growth was 7.7% and passengers reached 25,000,000, with 13,794 departures.', pool(tool));
    expect(r.ungrounded).toEqual(['7.7%', '25,000,000']);
    expect(r.checked).toBe(3);
  });
  it('flags a nearby but wrong number: rounding must reproduce the claim', () => {
    expect(checkGrounding('Delays were 24.5%.', pool(tool)).ungrounded).toEqual(['24.5%']);
    expect(checkGrounding('Delays were 24.2%.', pool(tool)).ungrounded).toEqual(['24.2%']);
  });
  it('accepts figures that come from numbers written inside tool text, the user message or tool arguments', () => {
    expect(checkGrounding('The default threshold is 3,000 miles and runways of 5,000 ft count.', pool({ note: 'a threshold of 3,000 statute miles; runways of at least 5,000 ft' })).ungrounded).toEqual([]);
    expect(checkGrounding('For 2,500 miles the share is 12.5%.', pool('what about 2500 miles?', { share: 0.125 })).ungrounded).toEqual([]);
  });
  it('treats an answer with no checkable figures as having nothing to verify', () => {
    expect(checkGrounding('The data covers US airports only.', pool(tool))).toEqual({ checked: 0, ungrounded: [] });
  });
  it('compares absolute values so a stated drop matches a negative tool number', () => {
    expect(checkGrounding('Passenger growth fell 1.9%.', pool({ pct: -1.86 })).ungrounded).toEqual([]);
  });
});

describe('years and periods', () => {
  it('accepts years that appear in tool periods and dates, and flags others', () => {
    const p = pool({ periods: { current: '2025-09..2026-08' }, retrievedAt: '2026-11-25T12:00:00Z' });
    expect(checkGrounding('From September 2025 to August 2026 (retrieved November 25, 2026).', p).ungrounded).toEqual([]);
    expect(checkGrounding('Counted from September 2005.', p).ungrounded).toEqual(['2005']);
  });
});

describe('redactUngrounded', () => {
  it('drops list items and offending sentences but keeps the rest', () => {
    const r = redactUngrounded('Intro with 5,000 ft.\n- A: 61.2 departures.\n- B: 4.6%.\nGood sentence here. Bad one at 19.3 minutes. Another good one.', ['61.2', '19.3 minutes']);
    expect(r.text).toBe('Intro with 5,000 ft.\n- B: 4.6%.\nGood sentence here. Another good one.');
    expect(r.removed).toBe(2);
  });
  it('is a no-op without unsupported figures', () => {
    expect(redactUngrounded('same', [])).toEqual({ text: 'same', removed: 0 });
  });
});

describe('digestCall', () => {
  const success = (data: unknown, extra: object = {}) => ({ ok: true as const, tool: 't', data, periods: {}, sources: [], assumptions: [], limitations: [], ...extra });
  it('outlines a ranking with scope, weights and the top airports, not the full result', () => {
    const out = success({ scope: 'states TX', ranking: { candidateSet: { eligible: 16 }, weights: { scale: 20 }, missingDataPolicy: 'neutral', ranked: [{ rank: 1, code: 'AUS', score: 77.31 }, { rank: 2, code: 'IAH', score: 74.3 }] } });
    const d = digestCall('rank_expansion_opportunities', { states: ['TX'] }, out);
    expect(d).toContain('rank_expansion_opportunities({"states":["TX"]})');
    expect(d).toContain('1.AUS 77.31');
    expect(d.length).toBeLessThan(500);
  });
  it('records failures with their options so a follow-up can answer the clarification', () => {
    const d = digestCall('get_traffic_metrics', { airports: ['Portland'] }, { ok: false, tool: 'x', error: { code: 'ambiguous_airport', message: 'Ambiguous', candidates: [{ input: 'Portland', options: [{ code: 'PDX' }, { code: 'PWM' }] }] } });
    expect(d).toContain('ERROR ambiguous_airport');
    expect(d).toContain('Options: PDX, PWM');
  });
  it('truncates very long arguments', () => {
    expect(digestCall('find_airports', { states: Array.from({ length: 200 }, () => 'XX') }, success({ scope: 's', airports: [] })).length).toBeLessThan(700);
  });
});

describe('retry policy', () => {
  it('retries rate limits, overload and network failures but not permanent errors', () => {
    for (const m of ['[429 Too Many Requests] quota', '[503 Service Unavailable] This model is currently experiencing high demand', 'fetch failed', 'ETIMEDOUT', 'RESOURCE_EXHAUSTED']) expect(isTransient(new Error(m)), m).toBe(true);
    for (const m of ['[400 Bad Request] Invalid JSON payload', '[403 Forbidden] API key not valid', '[404 Not Found] model not found']) expect(isTransient(new Error(m)), m).toBe(false);
    expect(isTransient(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
  });
  it('does not retry a daily quota (hours to reset) but still treats a per-minute 429 as transient', () => {
    const daily = new Error('[429 Too Many Requests] You exceeded your current quota. Quota exceeded for metric generate_content_free_tier_requests, limit: 20 ... Generate content requests per day limit exceeded. Please retry in 15h36m43s.');
    expect(isQuotaExhausted(daily)).toBe(true);
    expect(isTransient(daily)).toBe(false);
    const perMinute = new Error('[429 Too Many Requests] rate limit exceeded, retry in 12s');
    expect(isQuotaExhausted(perMinute)).toBe(false);
    expect(isTransient(perMinute)).toBe(true);
  });
  it('detects a daily quota from the structured error details when the message does not say so (real Gemini shape)', () => {
    const violation = (quotaId: string) => [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: '500' }] }];
    const msg = '[429 Too Many Requests] You exceeded your current quota, please check your plan and billing details.';
    const daily = Object.assign(new Error(msg), { errorDetails: violation('GenerateRequestsPerDayPerProjectPerModel-FreeTier') });
    expect(isQuotaExhausted(daily)).toBe(true);
    expect(isTransient(daily)).toBe(false);
    const perMinute = Object.assign(new Error(msg), { errorDetails: violation('GenerateRequestsPerMinutePerProjectPerModel-FreeTier') });
    expect(isQuotaExhausted(perMinute)).toBe(false);
    expect(isTransient(perMinute)).toBe(true);
  });
  it('backs off exponentially with jitter inside 50-100% of the base, capped', () => {
    expect(backoffDelay(1, 1000, 20_000, () => 1)).toBe(1000);
    expect(backoffDelay(3, 1000, 20_000, () => 1)).toBe(4000);
    expect(backoffDelay(3, 1000, 20_000, () => 0)).toBe(2000);
    expect(backoffDelay(10, 1000, 20_000, () => 1)).toBe(20_000);
  });
  it('retries up to the limit and then throws the last error', async () => {
    let n = 0;
    const waits: number[] = [];
    await expect(withBackoff(async () => { n += 1; throw new Error('503 overloaded'); }, { maxRetries: 2, initialMs: 100, maxMs: 1000, sleep: async (ms) => { waits.push(ms); }, random: () => 1 })).rejects.toThrow('503');
    expect(n).toBe(3);
    expect(waits).toEqual([100, 200]);
  });
  it('does not retry permanent errors and returns early on success', async () => {
    let n = 0;
    await expect(withBackoff(async () => { n += 1; throw new Error('400 bad request'); }, { maxRetries: 3, initialMs: 0, maxMs: 0 })).rejects.toThrow('400');
    expect(n).toBe(1);
    let k = 0;
    await expect(withBackoff(async () => (++k < 2 ? Promise.reject(new Error('429 slow down')) : 'ok'), { maxRetries: 3, initialMs: 0, maxMs: 0, sleep: async () => undefined })).resolves.toBe('ok');
  });
});

describe('numbers the user wrote with a unit', () => {
  it('accepts "5 million" when the user asked for "5 million passengers"', () => {
    const p = pool('Among airports with more than 5 million passengers, which are international?');
    expect(checkGrounding('Among airports with more than 5 million passengers, JFK leads.', p).ungrounded).toEqual([]);
    expect(checkGrounding('Among airports with more than 7 million passengers, JFK leads.', p).ungrounded).toEqual(['7 million']);
  });
});

describe('redactUngrounded sentence splitting', () => {
  it('does not cut a sentence at "vs." or other abbreviations', () => {
    const text = 'Both airports show similar delay rates (24.2% at LAX vs. 25.4% at SNA) and similar cancellations. Median taxi-out is 16 minutes at LAX. Visit St. Louis soon.';
    const r = redactUngrounded(text, ['24.2%']);
    expect(r.removed).toBe(1);
    expect(r.text).toBe('Median taxi-out is 16 minutes at LAX. Visit St. Louis soon.');
  });
});
