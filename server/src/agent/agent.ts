import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgent, modelCallLimitMiddleware, modelFallbackMiddleware, modelRetryMiddleware, toolCallLimitMiddleware } from 'langchain';
import type { Config } from '../config.js';
import type { DataStore } from '../data/store.js';
import type { ToolFailure, ToolOutput, ToolRunState } from '../tools/index.js';
import { ConversationStore } from './conversation.js';
import { digestCall } from './digest.js';
import { AgentError } from './errors.js';
import { checkGrounding, collectNumbers, redactUngrounded } from './grounding.js';
import { collectFractions, formatProse } from './presentation.js';
import { buildSystemPrompt } from './prompt.js';
import { isQuotaExhausted, isTransient, withBackoff } from './retry.js';
import { OVERCLAIM_INSTRUCTION, OVERCLAIM_NOTE, overclaims } from './wording.js';
import { RunTracker } from './tracker.js';
import type { AmbiguityReport, Artifact, ChatResponse, GroundingReport, ProgressEvent } from './types.js';

export interface Logger {
  info(event: string, fields: Record<string, unknown>): void;
  warn(event: string, fields: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (event, fields) => console.log(JSON.stringify({ level: 'info', event, ...fields })),
  warn: (event, fields) => console.warn(JSON.stringify({ level: 'warn', event, ...fields })),
};

export interface AgentDeps {
  readonly config: Config;
  readonly store: DataStore;
  readonly tools: StructuredToolInterface[];
  readonly model: BaseChatModel;
  /** Tried in order when the primary model keeps failing (transient errors or an exhausted daily quota). */
  readonly fallbackModels?: readonly BaseChatModel[];
  readonly conversations: ConversationStore;
  readonly logger?: Logger;
  /** Test hook: replaces real sleeping between retries. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const LIMIT_TEXT = /(model call limits? exceeded|tool call limits? exceeded|recursion limit)/i;

/** Gemini returns either a string or a list of content parts; this gives the text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === 'string' ? p : (p as { type?: string; text?: string }).type === 'text' ? ((p as { text?: string }).text ?? '') : '')).join('');
  return '';
}

const dedupe = <T>(xs: readonly T[]): T[] => [...new Set(xs)];

export class AirportAgent {
  private readonly agent;
  private readonly systemPrompt: string;
  private readonly log: Logger;
  private active = 0;

  constructor(private readonly deps: AgentDeps) {
    const { config } = deps;
    this.log = deps.logger ?? consoleLogger;
    this.systemPrompt = buildSystemPrompt(deps.store);
    const middleware = [
      ...(deps.fallbackModels?.length ? [modelFallbackMiddleware(...(deps.fallbackModels as BaseChatModel[]))] : []),
      modelRetryMiddleware({ maxRetries: config.MODEL_MAX_RETRIES, retryOn: (e: Error) => isTransient(e), initialDelayMs: config.MODEL_RETRY_INITIAL_MS, maxDelayMs: config.MODEL_RETRY_MAX_MS, backoffFactor: 2, jitter: true, onFailure: 'error' }),
      modelCallLimitMiddleware({ runLimit: config.AGENT_MAX_STEPS, exitBehavior: 'end' }),
      toolCallLimitMiddleware({ runLimit: config.AGENT_MAX_TOOL_CALLS, exitBehavior: 'continue' }),
    ];
    this.agent = createAgent({ model: deps.model, tools: deps.tools, systemPrompt: this.systemPrompt, middleware });
  }

  reset(sessionId: string): boolean {
    return this.deps.conversations.reset(sessionId);
  }

  async chat(input: { sessionId?: string | undefined; message: string }, opts: { onProgress?: (e: ProgressEvent) => void; /** Aborted when the caller goes away (for example the browser closed), so no quota is spent on an answer nobody will read. */ signal?: AbortSignal } = {}): Promise<ChatResponse> {
    const { config } = this.deps;
    const message = input.message.trim();
    if (message.length === 0) throw new AgentError('invalid_request', 'message must not be empty.', 400);
    if (message.length > 2_000) throw new AgentError('invalid_request', 'message is too long (limit 2,000 characters).', 400);
    if (this.active >= config.MAX_CONCURRENT_TURNS) throw new AgentError('server_busy', 'The assistant is handling several requests; please retry in a moment.', 429);

    const session = this.deps.conversations.open(input.sessionId);
    if (session.busy) throw new AgentError('session_busy', 'This conversation is still answering the previous message.', 409);
    session.busy = true;
    this.active += 1;
    const started = Date.now();
    const timeout = AbortSignal.timeout(config.REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    const tracker = new RunTracker(opts.onProgress);
    const toolRun: ToolRunState = { seen: new Set(), duplicates: 0, calls: [], policy: { userText: message, prior: session.priorCalls() } };
    try {
      const history = session.toMessages();
      const prior = session.numbers();
      const poolOf = (artifacts: Artifact[]): Set<number> => {
        const pool = collectNumbers(message);
        for (const a of artifacts) {
          collectNumbers(a.output, pool);
        }
        for (const n of prior) pool.add(n);
        return pool;
      };
      const options = { signal, tracker, toolRun };

      let run = await this.runOnce([...history, new HumanMessage(message)], options);
      let pool = poolOf(run.artifacts);
      // The model answered with figures but never called a tool: those figures can only be from memory. Send it back once.
      let nudged = false;
      if (run.artifacts.length === 0 && run.draft !== '' && checkGrounding(run.draft, pool).ungrounded.length > 0 && !signal.aborted) {
        nudged = true;
        const reminder = `${message}\n\n[System instruction: do not answer from memory. Call the relevant tools first; every figure in your answer must come from their results.]`;
        run = await this.runOnce([...history, new HumanMessage(reminder)], options);
        pool = poolOf(run.artifacts);
      }
      const { artifacts, limitReached } = run;

      let answer = run.draft;
      const toolTexts = run.fresh.filter((m): m is ToolMessage => m instanceof ToolMessage).map((m) => contentToText(m.content));
      if (answer === '' && artifacts.length > 0) {
        // No final text (or a limit was hit). Ask once more for a summary; if that fails, say so rather than fail the turn: the artifacts are still valid.
        answer = await this.rewrite(message, toolTexts, undefined, [], signal, tracker).catch(() => 'I retrieved the results shown below but could not write a summary of them just now.');
      } else if (answer === '') {
        answer = 'I could not produce an answer for that. Please rephrase or try again.';
      }

      opts.onProgress?.({ type: 'checking' });
      let check = checkGrounding(answer, pool);
      const draftBad = [...check.ungrounded];
      let corrected = false;
      if (check.ungrounded.length > 0 && config.GROUNDING_CORRECTION && artifacts.length > 0 && !signal.aborted) {
        opts.onProgress?.({ type: 'rewriting' });
        const revised = await this.rewrite(message, toolTexts, answer, check.ungrounded, signal, tracker).catch(() => undefined);
        if (revised) {
          const again = checkGrounding(revised, pool);
          if (again.ungrounded.length < check.ungrounded.length) {
            answer = revised;
            check = again;
            corrected = true;
          }
        }
      }
      let removed = 0;
      if (check.ungrounded.length > 0) {
        // Unverified figures are never shown: drop the statements that carry them.
        const red = redactUngrounded(answer, check.ungrounded);
        removed = red.removed;
        answer = red.text.length >= 40 ? `${red.text}\n\nNote: ${removed} statement${removed === 1 ? ' was' : 's were'} removed because ${removed === 1 ? 'its figure' : 'their figures'} could not be verified against the data.` : artifacts.length === 0 ? 'I could not retrieve data to answer that reliably, so I have not given any figures. Please rephrase, or ask about a specific airport or region.' : 'I could not verify the figures in my draft answer against the data, so I have left them out. The retrieved results are shown below.';
        check = checkGrounding(answer, pool);
      }
      // Strong comparative wording must be backed by the comparison tool's own verdict.
      let overclaim: GroundingReport['overclaim'] = 'none';
      if (overclaims(answer, artifacts) && !signal.aborted) {
        overclaim = 'noted';
        const softened = await this.rewrite(message, toolTexts, answer, [], signal, tracker, OVERCLAIM_INSTRUCTION).catch(() => undefined);
        if (softened && !overclaims(softened, artifacts) && checkGrounding(softened, pool).ungrounded.length === 0) {
          answer = softened;
          overclaim = 'rewritten';
        } else answer += `\n\n${OVERCLAIM_NOTE}`;
      }
      answer = formatProse(answer, artifacts.flatMap((x) => collectFractions(x.output)));
      if (limitReached) answer += '\n\nNote: I stopped because I reached the limit on steps for one question, so this answer may be incomplete.';
      const status: GroundingReport['status'] = removed > 0 ? 'redacted' : corrected ? 'corrected' : check.checked === 0 ? 'no_figures' : 'verified';
      const grounding: GroundingReport = { status, checked: check.checked, draftUnsupportedFigures: draftBad, removedStatements: removed, nudgedToUseTools: nudged, overclaim };

      const response = this.assemble(session.id, session.turns.length + 1, answer, artifacts, grounding, tracker, toolRun, started, limitReached, session);
      session.add({ user: message, assistant: answer, digest: artifacts.map((a) => digestCall(a.tool, a.args, a.output)), numbers: [...collectNumbers(artifacts.map((a) => a.output), new Set())].slice(0, 4000), calls: toolRun.calls });
      this.log.info('chat_turn', { session: session.id.slice(0, 8), turn: response.turn, ms: response.usage.durationMs, modelAttempts: response.usage.modelAttempts, retries: response.usage.modelRetries, tools: artifacts.map((a) => a.tool), toolErrors: response.errors.map((e) => e.code), tokens: response.usage.totalTokens, grounding: grounding.status, limit: limitReached });
      return { ...response, history: { turnsKept: session.turns.length, truncated: session.truncated } };
    } finally {
      session.busy = false;
      this.active -= 1;
    }
  }

  /** One pass of the agent loop over the given messages. */
  private async runOnce(
    inputMessages: BaseMessage[],
    o: { signal: AbortSignal; tracker: RunTracker; toolRun: ToolRunState },
  ): Promise<{ fresh: BaseMessage[]; artifacts: Artifact[]; draft: string; limitReached: 'model_calls' | 'tool_calls' | undefined }> {
    let result: { messages: BaseMessage[] };
    try {
      result = (await this.agent.invoke({ messages: inputMessages }, { signal: o.signal, recursionLimit: this.deps.config.AGENT_MAX_STEPS * 8 + 20, callbacks: [o.tracker], configurable: { toolRun: o.toolRun } })) as { messages: BaseMessage[] };
    } catch (err) {
      result = this.recover(err, o.signal, o.tracker.failures);
    }
    const fresh = result.messages.slice(inputMessages.length);
    const { artifacts } = collectArtifacts(fresh);
    let limitReached: 'model_calls' | 'tool_calls' | undefined;
    const last = [...fresh].reverse().find((m) => m instanceof AIMessage) as AIMessage | undefined;
    let draft = last ? contentToText(last.content).trim() : '';
    if (!last || (last.tool_calls?.length ?? 0) > 0 || LIMIT_TEXT.test(draft)) {
      limitReached = 'model_calls';
      draft = '';
    }
    if (fresh.some((m) => m instanceof ToolMessage && LIMIT_TEXT.test(contentToText(m.content)))) limitReached ??= 'tool_calls';
    return { fresh, artifacts, draft, limitReached };
  }

  /** Converts a failed agent run into a typed error, or salvages nothing: failures are never papered over with invented text. */
  private recover(err: unknown, signal: AbortSignal, failures: readonly string[] = []): never {
    if (err instanceof AgentError) throw err;
    const name = err instanceof Error ? err.name : '';
    if (signal.aborted || name === 'AbortError' || name === 'TimeoutError') throw new AgentError('timeout', 'The request took too long and was stopped. Please try again, or ask a narrower question.', 504);
    this.log.warn('agent_error', { name, modelFailures: failures, message: sanitize(err instanceof Error ? err.message : String(err)) });
    if (isQuotaExhausted(err)) throw new AgentError('model_unavailable', 'The language model\'s usage quota is used up for now. Please try again later.', 503);
    if (isTransient(err)) throw new AgentError('model_unavailable', 'The language model is temporarily unavailable (rate limit or overload). Please try again shortly.', 503);
    throw new AgentError('internal_error', 'The assistant failed to process this request.', 500);
  }

  /** One extra model call, without tools, to write or correct an answer using only the tool results given in the prompt. */
  private async rewrite(question: string, toolTexts: string[], draft: string | undefined, unsupported: readonly string[], signal: AbortSignal, tracker: RunTracker, instruction?: string): Promise<string> {
    const { config } = this.deps;
    const body = [
      `User question: ${question}`,
      '',
      'Tool results (JSON; the ONLY permitted source of figures):',
      ...toolTexts.map((t, i) => `[${i + 1}] ${t.length > 14_000 ? `${t.slice(0, 14_000)}...` : t}`),
      '',
      draft !== undefined && instruction !== undefined
        ? `Your draft answer:\n${draft}\n\n${instruction}\nOutput only the revised answer.`
        : draft === undefined
        ? 'Write the answer to the user question now, following your rules: lead with the answer, use only figures that appear in the tool results, label indicators as indicators, state key assumptions and limitations, no arithmetic of your own.'
        : `Your draft answer:\n${draft}\n\nThese figures in your draft do not appear in the tool results: ${unsupported.join(', ')}.\nRewrite the answer: keep what is supported, remove or replace unsupported figures with figures from the tool results (or say the information is unavailable), do not calculate new values, keep the caveats. Output only the revised answer.`,
    ].join('\n');
    const messages = [new SystemMessage(this.systemPrompt), new HumanMessage(body)];
    const call = (model: BaseChatModel) => withBackoff(() => model.invoke(messages, { signal, callbacks: [tracker] }), { maxRetries: config.MODEL_MAX_RETRIES, initialMs: config.MODEL_RETRY_INITIAL_MS, maxMs: config.MODEL_RETRY_MAX_MS, signal, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}) });
    let response: AIMessage | undefined;
    let failure: unknown;
    for (const model of [this.deps.model, ...(this.deps.fallbackModels ?? [])]) {
      try {
        response = (await call(model)) as AIMessage;
        break;
      } catch (err) {
        failure = err;
        if (!(isTransient(err) || isQuotaExhausted(err))) throw err;
      }
    }
    if (!response) throw failure;
    tracker.addUsage((response as AIMessage & { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } }).usage_metadata);
    const text = contentToText(response.content).trim();
    if (text === '') throw new Error('empty rewrite');
    return text;
  }

  private assemble(sessionId: string, turn: number, answer: string, artifacts: Artifact[], grounding: GroundingReport, tracker: RunTracker, toolRun: ToolRunState, started: number, limitReached: 'model_calls' | 'tool_calls' | undefined, session: { truncated: boolean; turns: unknown[] }): ChatResponse {
    const ok = artifacts.filter((a): a is Artifact & { output: Extract<ToolOutput, { ok: true }> } => a.output.ok);
    const failures = artifacts.filter((a): a is Artifact & { output: ToolFailure } => !a.output.ok);
    const ambiguities: AmbiguityReport[] = [];
    for (const f of failures) for (const c of f.output.error.candidates ?? []) ambiguities.push({ input: c.input, options: c.options, ...(c.suggested ? { suggested: c.suggested } : {}) });
    for (const a of ok) {
      const d = a.output.data as { status?: string; candidates?: AmbiguityReport['options']; suggested?: string; reason?: string };
      if (a.tool === 'resolve_airport' && d.status === 'ambiguous' && d.candidates) ambiguities.push({ input: String((a.args as { query?: string }).query ?? ''), options: d.candidates, ...(d.suggested ? { suggested: d.suggested } : {}) });
    }
    const usedFallback = (this.deps.fallbackModels?.length ?? 0) > 0 && [...tracker.modelsSeen].some((m) => m !== this.deps.config.GEMINI_MODEL);
    return {
      sessionId, turn, answer, artifacts,
      sources: dedupe(ok.flatMap((a) => a.output.sources)),
      periods: ok.map((a) => ({ tool: a.tool, periods: a.output.periods })),
      assumptions: dedupe(ok.flatMap((a) => a.output.assumptions)),
      limitations: dedupe(ok.flatMap((a) => a.output.limitations)),
      warnings: dedupe(ok.flatMap((a) => a.output.warnings ?? [])),
      errors: failures.map((f) => ({ tool: f.tool, code: f.output.error.code, message: f.output.error.message })),
      ambiguities, needsClarification: ambiguities.length > 0 && answer.includes('?'),
      controls: ok.flatMap((a) => [...(a.output.controls ?? [])]),
      interpretations: ok.flatMap((a) => (a.output.interpretations ?? []).map((i) => ({ ...i, tool: a.tool }))),
      grounding,
      usage: {
        model: usedFallback ? ([...tracker.modelsSeen].at(-1) ?? this.deps.config.GEMINI_MODEL) : this.deps.config.GEMINI_MODEL,
        modelAttempts: tracker.modelAttempts, modelRetries: tracker.modelErrors, usedFallback,
        toolCalls: artifacts.length, duplicateToolCallsBlocked: toolRun.duplicates,
        ...(tracker.sawUsage ? { inputTokens: tracker.inputTokens, outputTokens: tracker.outputTokens, totalTokens: tracker.totalTokens } : {}),
        durationMs: Date.now() - started, ...(limitReached ? { limitReached } : {}), toolTimingsMs: tracker.toolMs,
      },
      history: { turnsKept: session.turns.length, truncated: session.truncated },
    };
  }
}

/** Pairs each tool message artifact with the arguments of the call that produced it. */
export function collectArtifacts(messages: readonly BaseMessage[]): { artifacts: Artifact[] } {
  const calls = new Map<string, { name: string; args: unknown }>();
  const artifacts: Artifact[] = [];
  for (const m of messages) {
    if (m instanceof AIMessage) for (const c of m.tool_calls ?? []) calls.set(c.id ?? '', { name: c.name, args: c.args });
    else if (m instanceof ToolMessage) {
      const art = (m as ToolMessage).artifact as ToolOutput | null | undefined;
      const call = calls.get(m.tool_call_id);
      if (art && typeof art === 'object' && 'ok' in art) artifacts.push({ id: m.tool_call_id, tool: call?.name ?? art.tool, args: art.appliedArgs ?? call?.args ?? {}, output: art });
      else if (m.status === 'error') {
        // The framework itself rejected the call (for example invalid arguments): surface it as a structured failure.
        artifacts.push({ id: m.tool_call_id, tool: call?.name ?? m.name ?? 'unknown', args: call?.args ?? {}, output: { ok: false, tool: call?.name ?? m.name ?? 'unknown', error: { code: 'invalid_arguments', message: contentToText(m.content).slice(0, 400) } } });
      }
    }
  }
  return { artifacts };
}

/** Removes anything key-like from an error message before it is logged. */
export function sanitize(text: string): string {
  return text.replace(/AIza[0-9A-Za-z_-]{20,}|AQ\.[0-9A-Za-z_-]{20,}|key=[^&\s]+/g, '[redacted]').slice(0, 300);
}
