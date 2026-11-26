import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import type { Serialized } from '@langchain/core/load/serializable';
import type { ProgressEvent } from './types.js';

/** Collects per-turn counters through LangChain callbacks: model attempts (retries included), errors, token usage, tool timings. */
export class RunTracker extends BaseCallbackHandler {
  name = 'run-tracker';
  constructor(private readonly emit?: (e: ProgressEvent) => void) {
    super();
  }
  modelAttempts = 0;
  modelErrors = 0;
  inputTokens = 0;
  outputTokens = 0;
  totalTokens = 0;
  sawUsage = false;
  readonly modelsSeen = new Set<string>();
  readonly toolMs: Record<string, number> = {};
  private readonly toolStart = new Map<string, { name: string; at: number }>();

  override handleChatModelStart(_llm: Serialized, _messages: unknown, _runId: string, _parent?: string, extra?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>): void {
    this.modelAttempts += 1;
    this.emit?.({ type: 'thinking', attempt: this.modelAttempts });
    const inv = (extra?.invocation_params ?? {}) as { model?: string };
    const model = (metadata?.ls_model_name as string | undefined) ?? inv.model;
    if (model) this.modelsSeen.add(model);
  }

  override handleLLMEnd(output: LLMResult): void {
    for (const gen of output.generations.flat()) {
      const u = (gen as { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } } }).message?.usage_metadata;
      if (!u) continue;
      this.sawUsage = true;
      this.inputTokens += u.input_tokens ?? 0;
      this.outputTokens += u.output_tokens ?? 0;
      this.totalTokens += u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
  }

  override handleLLMError(): void {
    this.modelErrors += 1;
    this.emit?.({ type: 'model_retry' });
  }

  override handleToolStart(tool: Serialized, _input: string, runId: string, _parent?: string, _tags?: string[], _meta?: Record<string, unknown>, name?: string): void {
    const n = name ?? (tool as { name?: string }).name ?? 'tool';
    this.toolStart.set(runId, { name: n, at: Date.now() });
    this.emit?.({ type: 'tool_start', tool: n });
  }

  override handleToolEnd(_output: unknown, runId: string): void {
    const s = this.toolStart.get(runId);
    if (!s) return;
    this.toolMs[s.name] = (this.toolMs[s.name] ?? 0) + (Date.now() - s.at);
    this.emit?.({ type: 'tool_done', tool: s.name });
    this.toolStart.delete(runId);
  }

  addUsage(u: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | undefined): void {
    if (!u) return;
    this.sawUsage = true;
    this.inputTokens += u.input_tokens ?? 0;
    this.outputTokens += u.output_tokens ?? 0;
    this.totalTokens += u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
  }
}
