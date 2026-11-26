import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse, ProgressEvent } from '@/types';
import { ChatError, sendMessage } from './api';

const enc = new TextEncoder();
/** A fetch response whose body delivers the given chunks one at a time, like a network stream. */
const streamOf = (chunks: string[], init: ResponseInit = { status: 200 }) =>
  new Response(new ReadableStream({ start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); } }), init);
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const result = { sessionId: 's1', answer: 'ok' } as unknown as ChatResponse;

afterEach(() => vi.unstubAllGlobals());

describe('sendMessage (SSE client)', () => {
  it('reports progress as it arrives, even when an event is split across chunks, then resolves with the result', async () => {
    const whole = sse('progress', { type: 'tool_start', tool: 'screen_airports' }) + sse('result', result);
    const cut = whole.indexOf('tool_start') + 4;
    vi.stubGlobal('fetch', vi.fn(async () => streamOf([': keep-alive\n\n', whole.slice(0, cut), whole.slice(cut)])));
    const seen: ProgressEvent[] = [];
    await expect(sendMessage({ message: 'hi' }, (e) => seen.push(e))).resolves.toMatchObject({ sessionId: 's1' });
    expect(seen).toEqual([{ type: 'tool_start', tool: 'screen_airports' }]);
  });
  it('turns an error event into a typed ChatError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamOf([sse('error', { error: { code: 'model_unavailable', message: 'busy', status: 503 } })])));
    await expect(sendMessage({ message: 'hi' }, () => undefined)).rejects.toMatchObject({ info: { code: 'model_unavailable', status: 503 } });
  });
  it('reports a connection that closes before an answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => streamOf([sse('progress', { type: 'thinking', attempt: 1 })])));
    await expect(sendMessage({ message: 'hi' }, () => undefined)).rejects.toMatchObject({ info: { code: 'network' } });
  });
  it('reads a JSON error returned before the stream starts, and a failed fetch as a network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'session_busy', message: 'wait' } }), { status: 409 })));
    await expect(sendMessage({ message: 'hi' }, () => undefined)).rejects.toMatchObject({ info: { code: 'session_busy', status: 409 } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    await expect(sendMessage({ message: 'hi' }, () => undefined)).rejects.toBeInstanceOf(ChatError);
  });
});
