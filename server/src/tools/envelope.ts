import type { AnalysisMeta } from '../analytics/service.js';
import type { Notice } from './argPolicy.js';

export type ToolErrorCode =
  | 'ambiguous_airport'
  | 'unknown_airport'
  | 'unsupported_scope'
  | 'invalid_arguments'
  | 'unsupported_request'
  | 'data_unavailable'
  | 'provider_error';

export interface Page {
  readonly total: number;
  readonly returned: number;
  readonly offset: number;
  /** Offset to pass for the next page; absent on the last page. */
  readonly nextOffset?: number;
}

/**
 * What every tool returns. `data` holds the numbers (with units in field names or `units`), everything else tells the
 * reader where they came from and what they do and do not mean. The UI renders `data` directly; the model only explains it.
 */
export interface ToolSuccess<T = unknown> {
  readonly ok: true;
  readonly tool: string;
  readonly data: T;
  /** Named periods behind the numbers, e.g. { passengers: "2025-09..2026-08" }. */
  readonly periods: Readonly<Record<string, string>>;
  readonly sources: readonly string[];
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  /** Data-coverage information, kept apart from the analytical result. */
  readonly coverage?: unknown;
  readonly page?: Page;
  readonly warnings?: readonly string[];
  /** Airport names the tool resolved on the user's behalf, so a client can offer the alternatives. */
  readonly interpretations?: readonly Interpretation[];
  /** Arguments the argument policy ignored, carried forward or restored, and scopes the assistant chose. */
  readonly controls?: readonly Notice[];
  /** The arguments actually used, after the argument policy; what a client should show as "what was run". */
  readonly appliedArgs?: unknown;
}

/** A name the tool interpreted: what the user wrote, the airport used, and the other airports that matched. */
export interface Interpretation {
  readonly input: string;
  readonly used: { readonly code: string; readonly name?: string };
  readonly alternatives: ReadonlyArray<{ readonly code: string; readonly name?: string; readonly city?: string; readonly state?: string }>;
}

export interface ToolFailure {
  readonly ok: false;
  readonly tool: string;
  readonly appliedArgs?: unknown;
  readonly error: {
    readonly code: ToolErrorCode;
    readonly message: string;
    readonly hint?: string;
    /** For ambiguous names: the options, so the caller can ask the user or retry with a code. */
    readonly candidates?: ReadonlyArray<{ readonly input: string; readonly options: ReadonlyArray<{ code: string; name?: string; city?: string; state?: string }>; readonly suggested?: string }>;
  };
}

export type ToolOutput<T = unknown> = ToolSuccess<T> | ToolFailure;

export const fail = (tool: string, code: ToolErrorCode, message: string, extra: { hint?: string; candidates?: ToolFailure['error']['candidates'] } = {}): ToolFailure => ({
  ok: false,
  tool,
  error: { code, message, ...(extra.hint ? { hint: extra.hint } : {}), ...(extra.candidates ? { candidates: extra.candidates } : {}) },
});

export function succeed<T>(tool: string, data: T, rest: Omit<ToolSuccess<T>, 'ok' | 'tool' | 'data'>): ToolSuccess<T> {
  return { ok: true, tool, data, ...rest };
}

/** Slices a list into a page and describes it. */
export function paginate<T>(items: readonly T[], limit: number, offset: number): { items: T[]; page: Page } {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, page: { total: items.length, returned: slice.length, offset, ...(next < items.length ? { nextOffset: next } : {}) } };
}

/** Human-readable source lines for an analysis, saying plainly whether the traffic data was live or a fallback. */
export function sourcesOf(meta: Pick<AnalysisMeta, 'traffic' | 'operationalMonths' | 'datasetNotes'> | undefined): string[] {
  if (!meta) return [];
  const t = meta.traffic;
  const origin =
    t.mode === 'live' ? `live BTS Socrata API, retrieved ${t.provenance.retrievedAt}` : t.mode === 'snapshot' ? 'committed BTS snapshot (live API not used)' : `committed BTS snapshot because the live API failed (${t.liveError ?? 'unknown error'})`;
  return [`Passengers, seats, departures: BTS T-100 summary, ${origin}`, ...meta.datasetNotes.slice(1)];
}

export const STANDARD_LIMITATIONS: readonly string[] = [
  'Passenger counts come from BTS T-100 (all carriers); delays, cancellations and taxi times come from BTS On-Time Performance (reporting carriers only).',
  'Nothing here measures terminal or gate capacity, and no financial data is used.',
];
