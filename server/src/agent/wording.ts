import type { Artifact } from './types.js';

/** Words that claim a difference is real and large. */
export const STRONG_WORDS = /\b(significantly|substantially|markedly|dramatically|clearly (?:higher|lower|worse|better)|much (?:higher|lower|worse|better))\b/i;

interface Comparison {
  departureDelayRate15?: { verdict?: string };
  cancellationRate?: { verdict?: string };
}

/**
 * True when the answer uses strong comparative wording but no comparison in this turn supports it: either an airport's
 * on-time data coverage is weak, or every verdict from the comparison tool was "indistinguishable".
 */
export function overclaims(answer: string, artifacts: readonly Artifact[]): boolean {
  if (!STRONG_WORDS.test(answer)) return false;
  return artifacts.some((a) => {
    if (a.tool !== 'compare_operations' || !a.output.ok) return false;
    const data = a.output.data as { airports?: Array<{ operations?: { reliable?: boolean } }>; comparisons?: Comparison[] };
    const allReliable = (data.airports ?? []).every((x) => x.operations?.reliable !== false);
    const someClearDifference = (data.comparisons ?? []).some((c) => (c.departureDelayRate15?.verdict ?? 'indistinguishable') !== 'indistinguishable' || (c.cancellationRate?.verdict ?? 'indistinguishable') !== 'indistinguishable');
    return !(allReliable && someClearDifference);
  });
}

export const OVERCLAIM_NOTE = 'Note: the comparison tool found weak data or no clear difference, so strong wording such as "significantly" is not supported; treat the gaps as indicative.';
export const OVERCLAIM_INSTRUCTION = 'The comparison data are weak (low on-time coverage) or show no clear difference. Rewrite without strong wording such as "significantly", "substantially" or "clearly higher": describe the gap neutrally and say the figures are indicative. Keep the same figures.';
