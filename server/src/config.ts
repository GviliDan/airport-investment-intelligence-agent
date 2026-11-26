import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  GEMINI_API_KEY: z.string().optional(),
  /** Model name is configuration only; it must support tool calling. */
  GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash-lite'),
  /** One model name, or several separated by commas, tried in order when the primary keeps failing. */
  GEMINI_FALLBACK_MODEL: z.string().optional(),
  /** Whole-turn deadline: all model calls, retries and tool calls for one user message. */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(90_000),
  /** Maximum model calls (reasoning steps) per user message. */
  AGENT_MAX_STEPS: z.coerce.number().int().min(1).max(20).default(8),
  /** Maximum tool calls per user message. */
  AGENT_MAX_TOOL_CALLS: z.coerce.number().int().min(1).max(40).default(12),
  /** Requests per minute allowed per model, counting retries (free-tier keys have typically allowed about 15, but quotas vary by account and model; 12 leaves headroom). */
  MODEL_RPM: z.coerce.number().int().min(1).max(600).default(12),
  /** Retries per model call for 429/5xx/network errors, with exponential backoff. */
  MODEL_MAX_RETRIES: z.coerce.number().int().min(0).max(6).default(2),
  MODEL_RETRY_INITIAL_MS: z.coerce.number().int().min(0).default(1_000),
  MODEL_RETRY_MAX_MS: z.coerce.number().int().min(0).default(8_000),
  /** Conversation memory bounds. */
  HISTORY_MAX_TURNS: z.coerce.number().int().min(1).max(30).default(8),
  HISTORY_MAX_CHARS: z.coerce.number().int().min(2_000).default(24_000),
  SESSION_TTL_MS: z.coerce.number().int().min(10_000).default(3_600_000),
  MAX_SESSIONS: z.coerce.number().int().min(1).default(200),
  /** Concurrent chat turns the server will run; extra requests get HTTP 429. */
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).default(4),
  /** Ask the model to correct figures that do not appear in tool results (one extra call at most). */
  GROUNDING_CORRECTION: bool.default(true),
  /** Query the live BTS API for traffic (default). Set false for fully offline runs; the committed snapshot is used. */
  USE_LIVE_TRAFFIC: bool.default(true),
});

export type Config = Readonly<z.infer<typeof EnvSchema>>;

/** Parses configuration from an env map. Blank values count as unset so `.env.example` copies work. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  return EnvSchema.parse(cleaned);
}

/** Loads `.env` from the project root (one level above `server/`) and then reads process.env. */
export function loadConfig(): Config {
  loadEnv({ path: resolve(process.cwd(), '../.env'), quiet: true });
  loadEnv({ quiet: true });
  return parseConfig(process.env);
}

/** Configuration that is safe to show to clients or logs: never includes the API key. */
export function publicConfig(c: Config): Record<string, unknown> {
  return { model: c.GEMINI_MODEL, fallbackModel: c.GEMINI_FALLBACK_MODEL ?? null, maxSteps: c.AGENT_MAX_STEPS, maxToolCalls: c.AGENT_MAX_TOOL_CALLS, liveTraffic: c.USE_LIVE_TRAFFIC, chatConfigured: Boolean(c.GEMINI_API_KEY) };
}
