import type { Interpretation, Notice, ToolFailure, ToolOutput } from '../tools/index.js';

/** One tool call made while answering, with its complete structured result. The UI renders these, not the model's prose. */
export interface Artifact {
  readonly id: string;
  readonly tool: string;
  readonly args: unknown;
  readonly output: ToolOutput;
}

export interface GroundingReport {
  /**
   * verified: every checked figure appears in tool results; no_figures: nothing to check;
   * corrected: unsupported figures were found and the answer was rewritten; redacted: figures that could not be supported
   * were removed from the answer (they are never shown).
   */
  readonly status: 'verified' | 'no_figures' | 'corrected' | 'redacted';
  /** Figures checked in the final answer. */
  readonly checked: number;
  /** Figures that were unsupported in the first draft (empty when the draft was clean). */
  readonly draftUnsupportedFigures: readonly string[];
  /** Sentences or list items removed because they carried unsupported figures. */
  readonly removedStatements: number;
  /** True when the model first answered with figures but without calling any tool, and was sent back to use the tools. */
  readonly nudgedToUseTools: boolean;
  /** Strong comparative wording ("significantly") not supported by the comparison data: rewritten, or left with a note. */
  readonly overclaim: 'none' | 'rewritten' | 'noted';
}

/** What the agent is doing, streamed to the client while a turn runs. */
export type ProgressEvent =
  | { readonly type: 'thinking'; readonly attempt: number }
  | { readonly type: 'model_retry' }
  | { readonly type: 'tool_start'; readonly tool: string }
  | { readonly type: 'tool_done'; readonly tool: string }
  | { readonly type: 'checking' }
  | { readonly type: 'rewriting' };

export interface AmbiguityReport {
  readonly input: string;
  readonly options: ReadonlyArray<{ code: string; name?: string; city?: string; state?: string }>;
  readonly suggested?: string;
}

export interface UsageReport {
  readonly model: string;
  /** Model API attempts, including retries. */
  readonly modelAttempts: number;
  readonly modelRetries: number;
  /** True if the fallback model produced any response in this turn. */
  readonly usedFallback: boolean;
  readonly toolCalls: number;
  readonly duplicateToolCallsBlocked: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly durationMs: number;
  readonly limitReached?: 'model_calls' | 'tool_calls';
  readonly toolTimingsMs: Readonly<Record<string, number>>;
}

/** The chat response contract. */
export interface ChatResponse {
  readonly sessionId: string;
  readonly turn: number;
  /** The assistant's explanation. Numbers in it were checked against `artifacts`; see `grounding`. */
  readonly answer: string;
  /** Authoritative structured results of every tool call in this turn, in call order. */
  readonly artifacts: readonly Artifact[];
  /** Union over successful artifacts, de-duplicated. Per-artifact detail is inside `artifacts`. */
  readonly sources: readonly string[];
  readonly periods: ReadonlyArray<{ tool: string; periods: Readonly<Record<string, string>> }>;
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly warnings: readonly string[];
  /** Tool failures in this turn (also visible inside `artifacts`). */
  readonly errors: ReadonlyArray<{ tool: string; code: ToolFailure['error']['code']; message: string }>;
  /** Airport names that matched several airports. `needsClarification` is true when the answer asks the user to choose. */
  readonly ambiguities: readonly AmbiguityReport[];
  /** Airport names resolved on the user's behalf (with the alternatives), so the UI can offer a correction. */
  readonly interpretations: ReadonlyArray<Interpretation & { readonly tool: string }>;
  /** Arguments the argument policy ignored, carried forward or restored, and scopes the assistant chose (shown to the user). */
  readonly controls: readonly Notice[];
  readonly needsClarification: boolean;
  readonly grounding: GroundingReport;
  readonly usage: UsageReport;
  readonly history: { readonly turnsKept: number; readonly truncated: boolean };
}
