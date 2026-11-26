import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { AnalyticsError } from '../analytics/service.js';
import { DataStoreError } from '../data/store.js';
import { ProviderError } from '../data/errors.js';
import { applyArgPolicy, type Args, type Notice, type PolicyContext, type PriorCall } from './argPolicy.js';
import type { ToolContext } from './common.js';
import { fail, type Interpretation, type ToolOutput } from './envelope.js';
import { TOOL_SPECS, type ToolSpec } from './specs.js';

export type { ToolContext } from './common.js';
export type { ToolOutput, ToolSuccess, ToolFailure, Interpretation } from './envelope.js';
export type { Notice, PriorCall } from './argPolicy.js';
export { TOOL_SPECS } from './specs.js';

/**
 * Runs a tool against raw arguments. Arguments are validated here too, so the structured error shape is the same whether the
 * model or a test calls it. Expected failures become `ok: false` results; unexpected ones (bugs) still throw.
 */
export async function runTool(spec: ToolSpec, rawArgs: unknown, ctx: ToolContext): Promise<ToolOutput> {
  const parsed = spec.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(arguments)'}: ${i.message}`).join('; ');
    return fail(spec.name, 'invalid_arguments', `Invalid arguments: ${issues}`);
  }
  try {
    const notes: string[] = [];
    const interpretations: Interpretation[] = [];
    const out = await spec.run(parsed.data, { ...ctx, notes, interpretations });
    // Interpretations made on the user's behalf (such as choosing the dominant airport for a name) travel with the result.
    return out.ok && notes.length > 0 ? { ...out, warnings: [...notes, ...(out.warnings ?? [])], interpretations } : out;
  } catch (e) {
    if (e instanceof AnalyticsError) return fail(spec.name, /unknown airport/.test(e.message) ? 'unknown_airport' : 'unsupported_request', e.message);
    if (e instanceof DataStoreError) return fail(spec.name, 'data_unavailable', e.message);
    if (e instanceof ProviderError) return fail(spec.name, 'provider_error', e.message, { hint: 'A public data source failed. Say so and offer to retry; do not substitute other numbers.' });
    if (e instanceof RangeError) return fail(spec.name, 'invalid_arguments', e.message);
    throw e;
  }
}

/**
 * The text the model sees: compact JSON of the (possibly slimmed) result, with decimals trimmed to 4 places to save tokens.
 * The UI receives the unrounded artifact, so displayed numbers never depend on this trimmed copy.
 */
export const forModel = (spec: ToolSpec, output: ToolOutput): string => {
  const slimmed = spec.slim ? spec.slim(output) : output;
  // Sources, assumptions and limitations are long and are shown to the user from the full artifact; the model keeps the
  // data, periods, coverage and warnings. General caveats live in the system prompt.
  const view = slimmed.ok ? (({ sources: _s, assumptions: _a, limitations: _l, ...rest }) => rest)(slimmed) : slimmed;
  return JSON.stringify(view, (k, v: unknown) => {
    if (VERBOSE_KEYS.has(k)) return undefined;
    return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 1e4) / 1e4 : v;
  });
};

/** Long explanatory text inside results; the user sees it in the artifact, and the system prompt states the general rules. */
const VERBOSE_KEYS = new Set(['notes', 'suggests', 'doesNotShow', 'readingGuide', 'appliedArgs', 'controls']);

/** Per-turn state the agent passes through the run config so tools can refuse identical repeat calls. */
export interface ToolRunState {
  readonly seen: Set<string>;
  duplicates: number;
  /** When set, tool arguments are checked against the conversation before running (see argPolicy.ts). */
  readonly policy?: { readonly userText: string; readonly prior: readonly PriorCall[] };
  /** Calls made so far in this turn, after the policy ran; later calls in the turn can inherit from them. */
  readonly calls: PriorCall[];
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : x));

/**
 * LangChain tools. The model receives compact JSON; the complete structured result travels as the message artifact so the UI
 * can render authoritative numbers without depending on the model repeating them. When the run config carries a
 * `toolRun` state, an identical repeat call within the same turn is refused with a short note instead of being recomputed.
 */
export function createTools(ctx: ToolContext): StructuredToolInterface[] {
  return TOOL_SPECS.map((spec) =>
    tool(
      async (args: unknown, config?: { configurable?: Record<string, unknown> }) => {
        const run = config?.configurable?.toolRun as ToolRunState | undefined;
        let effective: unknown = args;
        let controls: readonly Notice[] = [];
        if (run?.policy && args && typeof args === 'object') {
          const ctx: PolicyContext = { userText: run.policy.userText, prior: [...run.policy.prior, ...run.calls] };
          const checked = applyArgPolicy(spec.name, args as Args, ctx);
          effective = checked.args;
          controls = checked.notices;
          run.calls.push({ tool: spec.name, args: checked.args, explicit: checked.explicit });
        }
        if (run) {
          const key = `${spec.name}:${stable(effective)}`;
          if (run.seen.has(key)) {
            run.duplicates += 1;
            const note = { ok: true, tool: spec.name, duplicate: true, note: 'This exact call was already made in this turn; its result is above. Use it instead of calling again.' };
            return [JSON.stringify(note), null] as [string, null];
          }
          run.seen.add(key);
        }
        const raw = await runTool(spec as unknown as ToolSpec, effective, ctx);
        // What the policy did travels with the result: to the model as warnings, to the UI as structured controls.
        const withControls: ToolOutput = raw.ok && controls.length > 0 ? { ...raw, controls, warnings: [...controls.map((c) => c.message), ...(raw.warnings ?? [])] } : raw;
        const output: ToolOutput = { ...withControls, appliedArgs: effective };
        return [forModel(spec as unknown as ToolSpec, output), output] as [string, ToolOutput];
      },
      { name: spec.name, description: spec.description, schema: spec.schema, responseFormat: 'content_and_artifact' },
    ),
  ) as unknown as StructuredToolInterface[];
}
