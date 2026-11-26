/** Where a number came from. Attached to every dataset so answers can cite sources, periods and freshness. */
export interface Provenance {
  readonly source: string;
  readonly dataset: string;
  readonly retrievedAt: string;
  /** Inclusive YYYY-MM range the data covers, when it has one. */
  readonly period?: { readonly start: string; readonly end: string };
  readonly note?: string;
}

export interface Sourced<T> {
  readonly data: T;
  readonly provenance: Provenance;
}

/** Month as YYYY-MM. */
export type Month = string;

export const isMonth = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
export const isAirportCode = (s: string): boolean => /^[A-Z0-9]{3}$/.test(s);

/** Months from `start` to `end` inclusive. */
export function monthRange(start: Month, end: Month): Month[] {
  const out: Month[] = [];
  let [y, m] = start.split('-').map(Number) as [number, number];
  const [ey, em] = end.split('-').map(Number) as [number, number];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** The month `n` months before `month` (n may be negative). */
export function shiftMonth(month: Month, n: number): Month {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) - n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
