/** The slice of the server's response contract that the UI uses. Artifact payloads are read defensively: any field may be absent. */

export interface Interpretation {
  input: string;
  tool: string;
  used: { code: string; name?: string };
  alternatives: Array<{ code: string; name?: string; city?: string; state?: string }>;
}

export interface ToolSuccess {
  ok: true;
  tool: string;
  data: any;
  periods: Record<string, string>;
  sources: string[];
  assumptions: string[];
  limitations: string[];
  coverage?: unknown;
  page?: { total: number; returned: number; offset: number; nextOffset?: number };
  warnings?: string[];
  interpretations?: Interpretation[];
}

export interface ToolFailure {
  ok: false;
  tool: string;
  error: { code: string; message: string; hint?: string; candidates?: Array<{ input: string; options: Array<{ code: string; name?: string; city?: string; state?: string }>; suggested?: string }> };
}

export type ToolOutput = ToolSuccess | ToolFailure;

export interface Artifact {
  id: string;
  tool: string;
  args: unknown;
  output: ToolOutput;
}

export interface Grounding {
  status: 'verified' | 'no_figures' | 'corrected' | 'redacted';
  checked: number;
  draftUnsupportedFigures: string[];
  removedStatements: number;
  nudgedToUseTools: boolean;
  overclaim?: 'none' | 'rewritten' | 'noted';
}

export interface Usage {
  model: string;
  modelAttempts: number;
  modelRetries: number;
  usedFallback: boolean;
  toolCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs: number;
  limitReached?: string;
}

export interface Ambiguity {
  input: string;
  options: Array<{ code: string; name?: string; city?: string; state?: string }>;
  suggested?: string;
}

export interface ChatResponse {
  sessionId: string;
  turn: number;
  answer: string;
  artifacts: Artifact[];
  sources: string[];
  periods: Array<{ tool: string; periods: Record<string, string> }>;
  assumptions: string[];
  controls: Array<{ kind: "ignored_parameter" | "inherited_parameter" | "scope_restored" | "scope_interpreted"; tool: string; param?: string; message: string }>;
  limitations: string[];
  warnings: string[];
  errors: Array<{ tool: string; code: string; message: string }>;
  ambiguities: Ambiguity[];
  interpretations: Interpretation[];
  needsClarification: boolean;
  grounding: Grounding;
  usage: Usage;
  history: { turnsKept: number; truncated: boolean };
}

export type ProgressEvent =
  | { type: 'thinking'; attempt: number }
  | { type: 'model_retry' }
  | { type: 'tool_start'; tool: string }
  | { type: 'tool_done'; tool: string }
  | { type: 'checking' }
  | { type: 'rewriting' };

export interface ApiError {
  code: string;
  message: string;
  status: number;
}

export interface Meta {
  config: { model: string; fallbackModel: string | null; chatConfigured: boolean; liveTraffic: boolean };
  tools: string[];
  data: { builtAt: string; alignedOperationalMonths: string[]; datasets: Record<string, { source: string; period?: { start: string; end: string }; note?: string; rows?: number; airports?: number }>; faaEffectiveDate?: string } | null;
  methodology?: { metrics: Array<{ id: string; label: string; formula: string; why: string; caveat: string; defaultWeight: number; source: string }>; method: string[]; readingGuide: string[] };
  knownLimitations?: string[];
}
