import { describe, expect, it } from 'vitest';
import { collectFractions, formatProse } from '../presentation.js';

const tool = { airports: [{ operations: { derived: { departureDelayRate15: 0.2415, cancellationRate: 0.0088, medianTaxiOutMin: 16 } } }, { operations: { derived: { cancellationRate: 0.01 } } }], score: 0.5 };

describe('formatProse', () => {
  const fr = collectFractions(tool);
  it('collects only rate-like fractions', () => expect(fr.sort()).toEqual([0.0088, 0.01, 0.2415]));
  it('turns raw fractions from tool results into percentages, including short ones', () => {
    expect(formatProse('Delays affect 0.2415 of departures; cancellations are 0.0088 at LAX and 0.01 at SNA.', fr)).toBe('Delays affect 24.1% of departures; cancellations are 0.9% at LAX and 1.0% at SNA.');
  });
  it('rounds long decimals that are not rates and leaves ordinary figures alone', () => {
    expect(formatProse('182.7534 departures per runway, 14.2 minutes, 65.1 points, 24.1%, 1,204.31 seats, 2026-08.', fr)).toBe('183 departures per runway, 14.2 minutes, 65.1 points, 24.1%, 1,204.31 seats, 2026-08.');
    expect(formatProse('about 1204.3125 flights, 12.3456 minutes', fr)).toBe('about 1204 flights, 12.3 minutes');
  });
  it('does not turn an unrelated 0.5 into a percentage', () => expect(formatProse('a score of 0.5', fr)).toBe('a score of 0.5'));
});
