import { BaseChatModel, type BaseChatModelParams } from '@langchain/core/language_models/chat_models';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { AnalyticsService } from '../../analytics/service.js';
import { AirportAgent } from '../agent.js';
import { ConversationStore } from '../conversation.js';
import { parseConfig, type Config } from '../../config.js';
import { loadDataStore } from '../../data/store.js';
import { TrafficProvider } from '../../data/trafficProvider.js';
import { createTools } from '../../tools/index.js';

export type Step = AIMessage | Error | ((messages: BaseMessage[]) => AIMessage | Error | Promise<AIMessage | Error>);

/** A scripted stand-in for the language model: replays prepared replies in order and records what it was sent. */
export class ScriptedModel extends BaseChatModel {
  readonly calls: BaseMessage[][] = [];
  private i = 0;
  constructor(private readonly script: Step[], private readonly modelName = 'scripted-model', fields: BaseChatModelParams = {}) {
    super(fields);
  }
  _llmType(): string {
    return 'scripted';
  }
  override getLsParams(): { ls_provider: string; ls_model_name: string; ls_model_type: 'chat' } {
    return { ls_provider: 'scripted', ls_model_name: this.modelName, ls_model_type: 'chat' };
  }
  override bindTools(): never {
    return this as never;
  }
  async _generate(messages: BaseMessage[], options: { signal?: AbortSignal }): Promise<ChatResult> {
    this.calls.push(messages);
    const step = this.script[Math.min(this.i, this.script.length - 1)] as Step;
    this.i += 1;
    if (options.signal?.aborted) throw new Error('aborted');
    const out = typeof step === 'function' ? await step(messages) : step;
    if (out instanceof Error) throw out;
    return { generations: [{ text: typeof out.content === 'string' ? out.content : '', message: out }] };
  }
}

export const say = (text: string, usage = { input_tokens: 100, output_tokens: 20, total_tokens: 120 }): AIMessage => new AIMessage({ content: text, usage_metadata: usage });
export const callTool = (name: string, args: Record<string, unknown>, id = `call_${Math.random().toString(36).slice(2, 8)}`): AIMessage =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }], usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });

export const FAST: Record<string, string> = { MODEL_RETRY_INITIAL_MS: '0', MODEL_RETRY_MAX_MS: '0', GEMINI_API_KEY: 'test-key-not-real' };
export const cfg = (extra: Record<string, string> = {}): Config => parseConfig({ ...FAST, ...extra });

const store = await loadDataStore();
export { store };

export function buildAgent(model: ScriptedModel, opts: { config?: Config; fallback?: ScriptedModel; fallbacks?: ScriptedModel[]; logs?: unknown[]; traffic?: TrafficProvider } = {}) {
  const config = opts.config ?? cfg();
  const traffic = opts.traffic ?? new TrafficProvider({ live: { monthlyTraffic: async () => { throw new Error('not used'); } }, snapshot: store.traffic, useLive: false });
  const service = new AnalyticsService({ store, traffic, now: () => new Date('2026-11-25T12:00:00Z') });
  const conversations = new ConversationStore({ maxTurns: config.HISTORY_MAX_TURNS, maxChars: config.HISTORY_MAX_CHARS, ttlMs: config.SESSION_TTL_MS, maxSessions: config.MAX_SESSIONS });
  const logs = opts.logs ?? [];
  const agent = new AirportAgent({
    config, store, tools: createTools({ service, store }), model, ...(opts.fallbacks ? { fallbackModels: opts.fallbacks } : opts.fallback ? { fallbackModels: [opts.fallback] } : {}), conversations,
    logger: { info: (e, f) => logs.push({ e, ...f }), warn: (e, f) => logs.push({ e, ...f }) },
  });
  return { agent, conversations, logs };
}
