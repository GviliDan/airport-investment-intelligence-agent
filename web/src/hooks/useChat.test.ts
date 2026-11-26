// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '@/types';

vi.mock('@/services/api', async () => {
  const actual = await vi.importActual<typeof import('@/services/api')>('@/services/api');
  return { ...actual, sendMessage: vi.fn(), resetConversation: vi.fn(async () => undefined) };
});
import { ChatError, resetConversation, sendMessage } from '@/services/api';
import { useChat } from './useChat';

const reply = (sessionId: string, answer = 'ok') => ({ sessionId, answer }) as unknown as ChatResponse;
const send = vi.mocked(sendMessage);

beforeEach(() => vi.clearAllMocks());

describe('useChat', () => {
  it('adds a pending turn, streams progress into it, and fills in the response', async () => {
    send.mockImplementation(async (_b, onProgress) => {
      onProgress({ type: 'tool_start', tool: 'screen_airports' });
      return reply('s1');
    });
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('Rank Texas'); });
    const t = result.current.turns[0]!;
    expect(t.user).toBe('Rank Texas');
    expect(t.pending).toBe(false);
    expect(t.response?.answer).toBe('ok');
    expect(t.steps.length).toBeGreaterThan(0);
    expect(result.current.busy).toBe(false);
  });
  it('continues the same conversation: the session id from one answer is sent with the next message', async () => {
    send.mockResolvedValueOnce(reply('s1')).mockResolvedValueOnce(reply('s1'));
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('first'); });
    await act(async () => { await result.current.send('follow-up'); });
    expect(send.mock.calls[0]![0].sessionId).toBeUndefined();
    expect(send.mock.calls[1]![0].sessionId).toBe('s1');
  });
  it('keeps a failed turn with its typed error and retries it in place', async () => {
    send.mockRejectedValueOnce(new ChatError({ code: 'model_unavailable', message: 'busy', status: 503 })).mockResolvedValueOnce(reply('s2', 'second try'));
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('hello'); });
    expect(result.current.turns[0]!.error?.code).toBe('model_unavailable');
    const id = result.current.turns[0]!.id;
    await act(async () => { await result.current.send('hello', id); });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0]!.response?.answer).toBe('second try');
    expect(result.current.turns[0]!.error).toBeUndefined();
  });
  it('reset clears the turns, cancels the request in flight and tells the server to drop the session', async () => {
    send.mockResolvedValueOnce(reply('s9'));
    const { result } = renderHook(() => useChat());
    await act(async () => { await result.current.send('one'); });
    let signal: AbortSignal | undefined;
    send.mockImplementationOnce((_b, _p, s) => { signal = s; return new Promise(() => undefined); });
    act(() => { void result.current.send('two'); });
    expect(result.current.busy).toBe(true);
    act(() => result.current.reset());
    expect(signal?.aborted).toBe(true);
    expect(result.current.turns).toEqual([]);
    expect(resetConversation).toHaveBeenCalledWith('s9');
    await act(async () => { send.mockResolvedValueOnce(reply('s10')); await result.current.send('fresh'); });
    expect(send.mock.calls.at(-1)![0].sessionId).toBeUndefined();
  });
});
