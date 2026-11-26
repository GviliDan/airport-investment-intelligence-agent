import express, { type ErrorRequestHandler, type Express } from 'express';
import { z } from 'zod';
import { AgentError } from './agent/errors.js';
import type { AirportAgent } from './agent/agent.js';
import { publicConfig, type Config } from './config.js';
import type { DataStore } from './data/store.js';
import { METHOD_NOTES, METRIC_DEFINITIONS, READING_GUIDE } from './analytics/scoring.js';
import { TOOL_SPECS } from './tools/index.js';

/** Shown in the UI so users see the limits of the model and of the answer checks, not just the data. */
export const KNOWN_LIMITATIONS: readonly string[] = [
  'The AI model (Gemini, free tier) can be slow, rate-limited, overloaded or out of daily quota. When that happens the assistant retries, may switch to a fallback model, and otherwise tells you it could not answer; it never fills the gap with made-up figures.',
  'The assistant checks tool arguments against the conversation: filters, windows or thresholds you did not ask for are ignored, settings you gave earlier are kept in follow-ups, and a scope you did not name is reported. These are wording-based heuristics and can be wrong; the notices in the answer say what was done.',
  'The model can misread a question. Informal places ("the Southeast") and abbreviations ("LA") are interpreted by the model; it should say how it interpreted them, but check the scope shown in the tables.',
  'Figures in the written explanation are checked against the data results. The check only confirms that each number or year appears somewhere in the tool results: it cannot tell whether a number is attached to the right airport, and it cannot verify wording, causes or conclusions. It ignores whole numbers of 20 or less, so small counts and ranks are unchecked. Statements whose figures match nothing are removed. It is a safeguard against invented numbers, not a guarantee of correctness; rely on the tables for exact values.',
  'A wording check looks for a short list of strong comparative phrases (such as "significantly") next to weak or inconclusive comparisons. It misses other phrasings and can flag harmless uses, so wording can still overstate what the data shows. The tables and caveats are the authoritative version.',
  'Delay, cancellation and taxi-out figures cover June to August 2026 and only airlines that report to BTS; coverage is shown for each airport and weak coverage is flagged.',
  'Opportunity scores are relative screening indicators built from judgemental weights. They are not forecasts, profitability or return estimates, and they are not evidence that a terminal is capacity-constrained: no terminal or gate data is used.',
  'Unmet demand cannot be measured with public data. The demand-pressure indicators show how tight capacity looks compared with peers, not why.',
];

export interface AppDeps {
  /** Undefined when no model key is configured: the API still starts and chat answers 503. */
  readonly agent?: AirportAgent;
  readonly store?: DataStore;
}

const ChatBody = z.object({ sessionId: z.string().optional(), message: z.string() }).strict();
const ResetBody = z.object({ sessionId: z.string() }).strict();

export function createApp(config: Config, deps: AppDeps = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '20kb' }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', chat: Boolean(deps.agent), model: config.GEMINI_MODEL });
  });

  /** Data periods, sources and the tool list, for the UI's "about this data" panel. Contains no secrets. */
  app.get('/api/meta', (_req, res) => {
    const store = deps.store;
    res.json({
      config: publicConfig(config),
      tools: TOOL_SPECS.map((t) => t.name),
      methodology: { metrics: METRIC_DEFINITIONS, method: METHOD_NOTES, readingGuide: READING_GUIDE },
      knownLimitations: KNOWN_LIMITATIONS,
      data: store ? { builtAt: store.manifest.generatedAt, alignedOperationalMonths: store.alignedMonths, datasets: store.manifest.datasets, faaEffectiveDate: store.airportsFile.faaEffectiveDate } : null,
    });
  });

  app.post('/api/chat', async (req, res, next) => {
    try {
      if (!deps.agent) throw new AgentError('chat_not_configured', 'Chat is not configured: set GEMINI_API_KEY on the server.', 503);
      const body = ChatBody.safeParse(req.body);
      if (!body.success) throw new AgentError('invalid_request', 'Body must be JSON: { "message": string, "sessionId"?: string }.', 400);
      res.json(await deps.agent.chat({ sessionId: body.data.sessionId, message: body.data.message }));
    } catch (e) {
      next(e);
    }
  });

  /**
   * Same as /api/chat, but streams progress as server-sent events while the agent works:
   *   event: progress  data: {"type":"tool_start","tool":"rank_expansion_opportunities"}
   *   event: result    data: <ChatResponse>            (once, at the end)
   *   event: error     data: {"error":{code,message}}  (instead of result)
   * Request validation errors are ordinary JSON 4xx responses sent before the stream starts.
   */
  app.post('/api/chat/stream', async (req, res, next) => {
    try {
      if (!deps.agent) throw new AgentError('chat_not_configured', 'Chat is not configured: set GEMINI_API_KEY on the server.', 503);
      const body = ChatBody.safeParse(req.body);
      if (!body.success) throw new AgentError('invalid_request', 'Body must be JSON: { "message": string, "sessionId"?: string }.', 400);
      res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      const send = (event: string, data: unknown): void => {
        if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      // Comment lines keep proxies from closing an idle connection during a long model call.
      // If the browser goes away mid-answer, stop the agent: otherwise it keeps spending model quota for nobody.
      const gone = new AbortController();
      res.on('close', () => { if (!res.writableFinished) gone.abort(); });
      const beat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15_000);
      try {
        const result = await deps.agent.chat({ sessionId: body.data.sessionId, message: body.data.message }, { onProgress: (e) => send('progress', e), signal: gone.signal });
        send('result', result);
      } catch (e) {
        const known = e instanceof AgentError;
        if (!known) console.error(JSON.stringify({ level: 'error', event: 'unhandled', name: (e as Error)?.name }));
        send('error', { error: { code: known ? e.code : 'internal_error', message: known ? e.message : 'Unexpected server error.', status: known ? e.status : 500 } });
      } finally {
        clearInterval(beat);
        res.end();
      }
    } catch (e) {
      next(e);
    }
  });

  app.post('/api/chat/reset', (req, res, next) => {
    try {
      if (!deps.agent) throw new AgentError('chat_not_configured', 'Chat is not configured: set GEMINI_API_KEY on the server.', 503);
      const body = ResetBody.safeParse(req.body);
      if (!body.success) throw new AgentError('invalid_request', 'Body must be JSON: { "sessionId": string }.', 400);
      res.json({ sessionId: body.data.sessionId, reset: deps.agent.reset(body.data.sessionId) });
    } catch (e) {
      next(e);
    }
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof AgentError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'invalid_request', message: 'Request body is not valid JSON.' } });
      return;
    }
    if (err && typeof err === 'object' && 'type' in err && (err as { type: string }).type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'invalid_request', message: 'Request body is too large.' } });
      return;
    }
    console.error(JSON.stringify({ level: 'error', event: 'unhandled', name: (err as Error)?.name }));
    res.status(500).json({ error: { code: 'internal_error', message: 'Unexpected server error.' } });
  };
  app.use(onError);
  return app;
}
