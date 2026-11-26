/**
 * Display formatting for the assistant's prose, applied after the answer has been checked.
 *
 * Tool results store rates as fractions (0.2415) and some measures with many decimals (182.7534). Models sometimes copy those
 * raw. This turns a bare decimal in the prose into what a reader expects, only when it can be tied to a tool value:
 *  - it equals a rate-like tool field (a fraction in 0..1 under a key such as rate, share, ratio, factor, coverage) at the
 *    precision written  ->  percent with one decimal (0.2415 -> 24.2%);
 *  - it has three or more decimals and is not such a rate  ->  rounded (182.7534 -> 182.8; 1,204.31 stays).
 * Numbers with a unit or percent sign, and the tool results themselves, are never touched.
 */

const RATE_KEY = /(rate|share|ratio|factor|coverage|fraction)/i;

/** Fractions (0..1) found under rate-like keys anywhere in a tool result. */
export function collectFractions(source: unknown, into: number[] = [], key = '', depth = 0): number[] {
  if (depth > 12 || source === null || source === undefined) return into;
  if (typeof source === 'number') {
    if (source >= 0 && source <= 1 && RATE_KEY.test(key)) into.push(source);
  } else if (Array.isArray(source)) {
    for (const x of source) collectFractions(x, into, key, depth + 1);
  } else if (typeof source === 'object') {
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) collectFractions(v, into, k, depth + 1);
  }
  return into;
}

const BARE_DECIMAL = /(?<![\w.,/-])(\d+)\.(\d+)(?![\d%]|\s?(?:%|percent|pp|points?|M\b|K\b|B\b|million|billion|thousand))/g;

export function formatProse(text: string, fractions: readonly number[]): string {
  return text.replace(BARE_DECIMAL, (token, intPart: string, frac: string) => {
    const decimals = frac.length;
    const value = Number(token);
    if (value <= 1) {
      const near = fractions.filter((x) => Math.abs(Number(x.toFixed(decimals)) - value) < 1e-9).sort((x, y) => Math.abs(x - value) - Math.abs(y - value))[0];
      if (near !== undefined) return `${(near * 100).toFixed(1)}%`;
    }
    if (decimals >= 3 && intPart.length > 0) return value.toFixed(value >= 100 ? 0 : 1);
    return token;
  });
}
