import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { AgentError } from '../errors.js';
import type { AirportAgent } from '../agent.js';
import { buildAgent, callTool, cfg, ScriptedModel, say, store } from './support.js';

async function withServer<T>(config: ReturnType<typeof cfg>, agent: AirportAgent | undefined, fn: (url: string) => Promise<T>): Promise<T> {
  const server = createApp(config, { ...(agent ? { agent } : {}), store }).listen(0);
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (url: string, body: unknown, raw = false) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });

describe('chat HTTP API', () => {
  it('answers a chat message with the full response contract', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say('ANC: 4.6% of 13,794 departures (628) were 3,000 miles or more.')]);
    const { agent } = buildAgent(model);
    await withServer(cfg(), agent, async (base) => {
      const res = await post(`${base}/api/chat`, { message: 'Long haul at ANC?' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body).sort()).toEqual(['ambiguities', 'answer', 'artifacts', 'assumptions', 'controls', 'errors', 'grounding', 'history', 'interpretations', 'limitations', 'needsClarification', 'periods', 'sessionId', 'sources', 'turn', 'usage', 'warnings']);
      expect(body.artifacts[0].output.data.share).toBeCloseTo(628 / 13794, 10);
      expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      const again = await (await post(`${base}/api/chat`, { sessionId: body.sessionId, message: 'again' })).json();
      expect(again.sessionId).toBe(body.sessionId);
      expect(again.turn).toBe(2);
    });
  });

  it('resets a conversation', async () => {
    const { agent } = buildAgent(new ScriptedModel([say('hi')]));
    await withServer(cfg(), agent, async (base) => {
      const { sessionId } = await (await post(`${base}/api/chat`, { message: 'hello' })).json();
      expect(await (await post(`${base}/api/chat/reset`, { sessionId })).json()).toEqual({ sessionId, reset: true });
      expect(await (await post(`${base}/api/chat/reset`, { sessionId })).json()).toEqual({ sessionId, reset: false });
      expect((await post(`${base}/api/chat/reset`, { sessionId: 'nope' })).status).toBe(400);
    });
  });

  it('validates the request body', async () => {
    const { agent } = buildAgent(new ScriptedModel([say('hi')]));
    await withServer(cfg(), agent, async (base) => {
      for (const bad of [{}, { message: 5 }, { message: 'hi', extra: true }, { message: '' }, { message: 'x'.repeat(2001) }, { message: 'hi', sessionId: 'abc' }]) {
        const res = await post(`${base}/api/chat`, bad);
        expect(res.status, JSON.stringify(bad).slice(0, 40)).toBe(400);
        expect((await res.json()).error.code).toBe('invalid_request');
      }
      expect((await post(`${base}/api/chat`, '{not json', true)).status).toBe(400);
      expect((await post(`${base}/api/chat`, JSON.stringify({ message: 'x'.repeat(30_000) }), true)).status).toBe(413);
    });
  });

  it('maps service failures to status codes with safe messages', async () => {
    const stub = (e: Error) => ({ chat: async () => { throw e; }, reset: () => false }) as unknown as AirportAgent;
    for (const [err, status, code] of [
      [new AgentError('model_unavailable', 'temporarily unavailable', 503), 503, 'model_unavailable'],
      [new AgentError('timeout', 'too long', 504), 504, 'timeout'],
      [new AgentError('session_busy', 'busy', 409), 409, 'session_busy'],
      [new Error('boom with secret key=ABC123'), 500, 'internal_error'],
    ] as const) {
      await withServer(cfg(), stub(err), async (base) => {
        const res = await post(`${base}/api/chat`, { message: 'hi' });
        expect(res.status).toBe(status);
        const body = await res.json();
        expect(body.error.code).toBe(code);
        expect(JSON.stringify(body)).not.toContain('ABC123');
      });
    }
  });

  it('answers 503 chat_not_configured when there is no model key, while health and meta still work', async () => {
    await withServer(cfg({ GEMINI_API_KEY: '' }), undefined, async (base) => {
      const res = await post(`${base}/api/chat`, { message: 'hi' });
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe('chat_not_configured');
      expect((await (await fetch(`${base}/health`)).json()).chat).toBe(false);
    });
  });

  it('serves data periods and the tool list at /api/meta, never the API key', async () => {
    await withServer(cfg({ GEMINI_API_KEY: 'sk-super-secret-value' }), undefined, async (base) => {
      const text = await (await fetch(`${base}/api/meta`)).text();
      const body = JSON.parse(text);
      expect(body.tools).toHaveLength(13);
      expect(body.data.alignedOperationalMonths).toEqual(['2026-06', '2026-07', '2026-08']);
      expect(body.config).toMatchObject({ model: 'gemini-3.5-flash-lite', chatConfigured: true });
      expect(text).not.toContain('sk-super-secret-value');
    });
  });
});
