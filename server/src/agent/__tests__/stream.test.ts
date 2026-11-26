import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { AirportAgent } from '../agent.js';
import { AgentError } from '../errors.js';
import { buildAgent, callTool, cfg, ScriptedModel, say, store } from './support.js';

interface SseEvent {
  event: string | undefined;
  data: any;
}

async function withServer<T>(agent: AirportAgent, fn: (base: string) => Promise<T>): Promise<T> {
  const server = createApp(cfg(), { agent, store }).listen(0);
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}
const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event:'))
    .map((block) => ({ event: /^event: (.*)$/m.exec(block)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null') }));
}

describe('POST /api/chat/stream', () => {
  it('streams progress events and then the full result', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'Anchorage' }), say('ANC: 4.6% of 13,794 departures (628) were 3,000 miles or more.')]);
    const { agent } = buildAgent(model);
    await withServer(agent, async (base) => {
      const res = await post(`${base}/api/chat/stream`, { message: 'Long haul at Anchorage?' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
      const events = parseSse(await res.text());
      expect(events.at(-1)?.event).toBe('result');
      expect(events.filter((e) => e.event === 'result')).toHaveLength(1);
      const progress = events.filter((e) => e.event === 'progress').map((e) => e.data.type as string);
      expect(progress).toEqual(expect.arrayContaining(['thinking', 'tool_start', 'tool_done', 'checking']));
      expect(progress.indexOf('tool_start')).toBeLessThan(progress.indexOf('tool_done'));
      const result = events.at(-1)?.data;
      expect(result.answer).toMatch(/4\.6%/);
      expect(result.interpretations).toEqual([expect.objectContaining({ tool: 'get_long_haul_share', input: 'Anchorage', used: expect.objectContaining({ code: 'ANC' }) })]);
      expect(result.interpretations[0].alternatives.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['MRI']));
    });
  });

  it('reports a failure inside the stream as an error event', async () => {
    const stub = { chat: async () => { throw new AgentError('model_unavailable', 'The language model is temporarily unavailable.', 503); }, reset: () => false } as unknown as AirportAgent;
    await withServer(stub, async (base) => {
      const events = parseSse(await (await post(`${base}/api/chat/stream`, { message: 'hi' })).text());
      expect(events).toEqual([{ event: 'error', data: { error: { code: 'model_unavailable', message: 'The language model is temporarily unavailable.', status: 503 } } }]);
    });
  });

  it('rejects an invalid request with ordinary JSON before streaming', async () => {
    const { agent } = buildAgent(new ScriptedModel([say('hi')]));
    await withServer(agent, async (base) => {
      const bad = await post(`${base}/api/chat/stream`, { nope: true });
      expect(bad.status).toBe(400);
      expect(bad.headers.get('content-type')).toMatch(/json/);
    });
  });

  it('does not leak unexpected error details into the stream', async () => {
    const stub = { chat: async () => { throw new Error('boom key=SECRET123'); }, reset: () => false } as unknown as AirportAgent;
    await withServer(stub, async (base) => {
      const text = await (await post(`${base}/api/chat/stream`, { message: 'hi' })).text();
      expect(text).toContain('internal_error');
      expect(text).not.toContain('SECRET123');
    });
  });
});

describe('client disconnect', () => {
  it('aborts the agent run when the browser closes the stream', async () => {
    let aborted: Promise<boolean> = Promise.resolve(false);
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const agent = {
      chat: (_input: unknown, opts: { signal?: AbortSignal }) => {
        started();
        aborted = new Promise((resolve) => opts.signal?.addEventListener('abort', () => resolve(true), { once: true }));
        return new Promise(() => undefined); // never answers on its own
      },
    } as unknown as AirportAgent;
    await withServer(agent, async (base) => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/api/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hi' }), signal: ctrl.signal });
      expect(res.status).toBe(200);
      await running;
      ctrl.abort();
      await expect(Promise.race([aborted, new Promise((r) => setTimeout(() => r('timeout'), 3000))])).resolves.toBe(true);
    });
  });
});
