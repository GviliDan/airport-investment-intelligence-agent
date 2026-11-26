/**
 * Programmatic check that figures in the assistant's prose come from tool results.
 *
 * The model is told to quote tool numbers and not to calculate. This module verifies that: it extracts the figures from the
 * answer and looks for each among the numbers in the turn's tool results (and in the user's message and the tool arguments,
 * which the user supplied). A figure matches if rounding or truncating a tool number to the precision written reproduces it,
 * including percent conversions of fractions (0.241 -> 24.1%) and K/M/B abbreviations (20,984,982 -> 21.0 million).
 *
 * Known gaps (it is a safeguard, not a guarantee):
 *  - False negatives: a real number attached to the wrong airport or metric passes; whole numbers of 20 or less (ranks, counts) and
 *    numbers written as words are not checked; a coincidental match with some unrelated tool number passes.
 *  - False positives: a correct figure the model derived (a sum, a difference) is flagged because no tool produced it; unusual
 *    rounding or units ("a fifth") can be flagged; a figure from a tool result of an earlier turn is accepted only through the
 *    session's remembered numbers.
 * It catches invented or mis-calculated figures, which is the dominant failure mode, and nothing more.
 */

export interface NumberClaim {
  /** The text as written, for reporting. */
  readonly text: string;
  readonly value: number;
  readonly decimals: number;
  /** Multiplier implied by K / M / B / thousand / million / billion. */
  readonly scale: number;
}

export interface GroundingResult {
  /** Figures that were checked (small counts, years and list markers are not). */
  readonly checked: number;
  /** Figures that matched no tool number. */
  readonly ungrounded: readonly string[];
}

const UNIT = '%|percent\\b|percentage points?\\b|pp\\b|points?\\b|M\\b|million\\b|K\\b|thousand\\b|B\\b|billion\\b|miles?\\b|mi\\b|minutes?\\b|mins?\\b|passengers\\b|departures\\b|flights\\b|seats\\b|runways?\\b';
const NUMBER = new RegExp(`(?<![\\w.])[-+\\u2212\\u2013]?\\$?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?(\\s?(?:${UNIT}))?`, 'g');
/** Bare integers up to this size (counts like "3 airports", ranks, day numbers) are not checked. Years are checked. */
const SMALL_INT = 20;
/** Round reference numbers that are always fine to say. */
const ALWAYS_OK = new Set([50, 100]);

const scaleOf = (unit: string): number => {
  const u = unit.trim().toLowerCase();
  if (u === 'm' || u === 'million') return 1e6;
  if (u === 'k' || u === 'thousand') return 1e3;
  if (u === 'b' || u === 'billion') return 1e9;
  return 1;
};

/** Removes text whose digits are not figures: ISO dates and ranges, list markers, rank markers. */
function strip(text: string): string {
  return text
    .replace(/\d{4}-\d{2}(?:-\d{2})?(?:\s*(?:\.\.|to|–|-)\s*\d{4}-\d{2})?/g, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/#\d+/g, ' ')
    .replace(/\*\*|`/g, '');
}

export function extractClaims(text: string): NumberClaim[] {
  const claims: NumberClaim[] = [];
  const s = strip(text);
  for (const m of s.matchAll(NUMBER)) {
    const [whole, intPart, frac, unit] = m as unknown as [string, string, string | undefined, string | undefined];
    const end = (m.index ?? 0) + whole.length;
    const after = s.slice(end, end + 2);
    if (!unit && /^(st|nd|rd|th)\b/i.test(after)) continue; // ordinals: 3rd, 50th percentile
    if (!unit && /^-?[A-Za-z]/.test(s.slice(end, end + 1)) && !/^\s/.test(s.slice(end, end + 1))) continue; // glued to letters (e.g. "15min" is handled by UNIT)
    const digits = intPart.replace(/,/g, '');
    const value = Number(frac ? `${digits}.${frac}` : digits);
    if (!Number.isFinite(value)) continue;
    const isBareInt = !frac && !unit && !intPart.includes(',');
    if (isBareInt && value <= SMALL_INT) continue;
    if (isBareInt && ALWAYS_OK.has(value)) continue;
    claims.push({ text: whole.trim(), value, decimals: frac?.length ?? 0, scale: unit ? scaleOf(unit) : 1 });
  }
  return claims;
}

/** Every number found in a value: numeric leaves of objects/arrays and numbers written inside strings. */
export function collectNumbers(source: unknown, into: Set<number> = new Set(), depth = 0): Set<number> {
  if (depth > 12 || source === null || source === undefined) return into;
  if (typeof source === 'number') {
    if (Number.isFinite(source)) into.add(Math.abs(source));
  } else if (typeof source === 'string') {
    // Dates and periods (2025-09, 2026-11-25T..) are stripped for number extraction; keep their year/month/day parts as known values.
    for (const d of source.matchAll(/(\d{4})-(\d{2})(?:-(\d{2}))?/g)) for (const part of [d[1], d[2], d[3]]) if (part) into.add(Number(part));
    for (const m of strip(source).matchAll(NUMBER)) {
      const digits = (m[1] as string).replace(/,/g, '');
      const n = Number(m[2] ? `${digits}.${m[2]}` : digits);
      if (Number.isFinite(n)) {
        into.add(n);
        const scale = m[3] ? scaleOf(m[3]) : 1; // "5 million" in the user's message is 5,000,000
        if (scale !== 1) into.add(n * scale);
      }
    }
  } else if (Array.isArray(source)) {
    for (const x of source) collectNumbers(x, into, depth + 1);
  } else if (typeof source === 'object') {
    for (const x of Object.values(source as Record<string, unknown>)) collectNumbers(x, into, depth + 1);
  }
  return into;
}

function matches(claim: NumberClaim, p: number): boolean {
  const unit = 10 ** -claim.decimals;
  const target = claim.value;
  for (const t of [p, p * 100]) {
    const q = t / claim.scale;
    if (Math.abs(q - target) <= 0.5 * unit + 1e-9 * Math.max(1, q)) return true; // rounded
    if (Math.abs(Math.floor(q / unit + 1e-9) * unit - target) < 1e-9 * Math.max(1, target)) return true; // truncated
  }
  return false;
}

export function checkGrounding(text: string, pool: ReadonlySet<number>): GroundingResult {
  const claims = extractClaims(text);
  const values = [...pool];
  const bad = new Set<string>();
  for (const c of claims) if (!values.some((p) => matches(c, p))) bad.add(c.text);
  return { checked: claims.length, ungrounded: [...bad] };
}

export interface Redaction {
  readonly text: string;
  /** Sentences or list items removed. */
  readonly removed: number;
}

/** A sentence ends at . ! ? followed by a capital, digit or opening mark; "vs.", "e.g.", "St." and similar do not end one. */
const SENTENCE_END = /(?<!\b(?:vs|e\.g|i\.e|St|Mt|Ft|Intl|Inc|No|U\.S|approx|etc)\.)(?<=[.!?])\s+(?=[A-Z0-9"“(*])/;

/**
 * Removes the sentences and list items that contain unsupported figures, so unverified numbers are never shown. A paragraph
 * keeps its other sentences; a list item or heading line is dropped whole.
 */
export function redactUngrounded(text: string, unsupported: readonly string[]): Redaction {
  if (unsupported.length === 0) return { text, removed: 0 };
  const bad = (s: string): boolean => unsupported.some((u) => s.includes(u));
  let removed = 0;
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (!bad(line)) {
      lines.push(line);
      continue;
    }
    const isListItem = /^\s*([-*\u2022]|\d+[.)])\s/.test(line);
    if (isListItem) {
      removed += 1;
      continue;
    }
    const sentences = line.split(SENTENCE_END);
    const kept = sentences.filter((x) => !bad(x));
    removed += sentences.length - kept.length;
    if (kept.length > 0) lines.push(kept.join(' '));
  }
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}
