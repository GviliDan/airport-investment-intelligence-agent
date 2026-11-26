import { AirportAgent, type Logger } from './agent/agent.js';
import { ConversationStore } from './agent/conversation.js';
import { createChatModel } from './agent/llm.js';
import { AnalyticsService } from './analytics/service.js';
import type { Config } from './config.js';
import { BtsSocrataClient } from './data/btsSocrata.js';
import { FaaNasStatusClient } from './data/faaNasStatus.js';
import { loadDataStore, type DataStore } from './data/store.js';
import { TrafficProvider } from './data/trafficProvider.js';
import { createTools } from './tools/index.js';

export interface Composition {
  readonly store: DataStore;
  readonly service: AnalyticsService;
  /** Undefined when GEMINI_API_KEY is not set. */
  readonly agent?: AirportAgent;
}

/** Wires data, analytics, tools and (when a key is present) the agent. The one place where concrete dependencies meet. */
export async function compose(config: Config, opts: { logger?: Logger } = {}): Promise<Composition> {
  const store = await loadDataStore();
  const traffic = new TrafficProvider({
    live: new BtsSocrataClient({ timeoutMs: 30_000 }),
    snapshot: store.traffic,
    useLive: config.USE_LIVE_TRAFFIC,
    snapshotGeneratedAt: store.manifest.generatedAt,
  });
  const service = new AnalyticsService({ store, traffic, nas: new FaaNasStatusClient({ timeoutMs: 15_000 }) });
  if (!config.GEMINI_API_KEY) return { store, service };
  const agent = new AirportAgent({
    config, store,
    tools: createTools({ service, store }),
    model: createChatModel(config),
    fallbackModels: (config.GEMINI_FALLBACK_MODEL ?? '').split(',').map((m) => m.trim()).filter(Boolean).map((m) => createChatModel(config, m)),
    conversations: new ConversationStore({ maxTurns: config.HISTORY_MAX_TURNS, maxChars: config.HISTORY_MAX_CHARS, ttlMs: config.SESSION_TTL_MS, maxSessions: config.MAX_SESSIONS }),
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
  return { store, service, agent };
}
