import type { ApiError, ChatResponse, Meta, ProgressEvent } from '@/types';

/** Parses a server-sent-events text buffer. Returns complete events and the unconsumed remainder. */
export function parseSse(buffer: string): { events: Array<{ event: string; data: unknown }>; rest: string } {
  const events: Array<{ event: string; data: unknown }> = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    if (block.trim() === '' || block.startsWith(':')) continue; // keep-alive comment
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
    const raw = /^data: (.*)$/m.exec(block)?.[1];
    if (raw === undefined) continue;
    try {
      events.push({ event, data: JSON.parse(raw) });
    } catch {
      /* ignore a malformed event rather than break the stream */
    }
  }
  return { events, rest };
}

export class ChatError extends Error {
  constructor(readonly info: ApiError) {
    super(info.message);
    this.name = 'ChatError';
  }
}

const networkError = (): ChatError => new ChatError({ code: 'network', message: 'Could not reach the server.', status: 0 });

async function readError(res: Response): Promise<ChatError> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    return new ChatError({ code: body.error?.code ?? 'internal_error', message: body.error?.message ?? 'The request failed.', status: res.status });
  } catch {
    return new ChatError({ code: 'internal_error', message: 'The request failed.', status: res.status });
  }
}

/**
 * Sends a message and streams progress. Resolves with the final response; rejects with a ChatError for any failure,
 * whether it happens before the stream (HTTP status) or inside it (an `error` event).
 */
export async function sendMessage(body: { message: string; sessionId?: string | undefined }, onProgress: (e: ProgressEvent) => void, signal?: AbortSignal): Promise<ChatResponse> {
  let res: Response;
  try {
    res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw networkError();
  }
  if (!res.ok || !res.body) throw await readError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSse(buffer);
      buffer = rest;
      for (const e of events) {
        if (e.event === 'progress') onProgress(e.data as ProgressEvent);
        else if (e.event === 'result') return e.data as ChatResponse;
        else if (e.event === 'error') {
          const err = (e.data as { error: { code: string; message: string; status?: number } }).error;
          throw new ChatError({ code: err.code, message: err.message, status: err.status ?? 500 });
        }
      }
    }
  } catch (e) {
    if (e instanceof ChatError || (e as Error).name === 'AbortError') throw e;
    throw networkError();
  }
  throw new ChatError({ code: 'network', message: 'The connection closed before an answer arrived.', status: 0 });
}

export async function resetConversation(sessionId: string): Promise<void> {
  try {
    await fetch('/api/chat/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId }) });
  } catch {
    /* the local conversation is cleared either way; the server forgets it after its idle timeout */
  }
}

export async function fetchMeta(): Promise<Meta | null> {
  try {
    const res = await fetch('/api/meta');
    return res.ok ? ((await res.json()) as Meta) : null;
  } catch {
    return null;
  }
}
