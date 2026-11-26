'use client';

import { useCallback, useRef, useState } from 'react';
import { ChatError, resetConversation, sendMessage } from '@/services/api';
import type { ApiError, ChatResponse } from '@/types';
import { applyProgress, type Step } from '@/utils/progress';

export interface Turn {
  id: number;
  user: string;
  response?: ChatResponse;
  error?: ApiError;
  /** Progress steps streamed while the agent works. */
  steps: Step[];
  startedAt: number;
  pending: boolean;
}

/**
 * Conversation state and the streaming of one answer. Each message becomes a turn; progress events from the stream
 * update its steps live, and the final result (or a typed error) replaces them. The session id is kept in a ref so a
 * follow-up continues the same server-side conversation.
 */
export function useChat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const session = useRef<string | undefined>(undefined);
  const nextId = useRef(1);
  const controller = useRef<AbortController | null>(null);

  const patch = useCallback((id: number, change: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? change(t) : t))), []);

  /** Sends a message; with `replaceId` it re-runs a failed turn in place (Retry). */
  const send = useCallback(
    async (text: string, replaceId?: number) => {
      const id = replaceId ?? nextId.current++;
      const fresh: Turn = { id, user: text, steps: [], startedAt: Date.now(), pending: true };
      setTurns((ts) => (replaceId === undefined ? [...ts, fresh] : ts.map((t) => (t.id === id ? fresh : t))));
      const ctrl = new AbortController();
      controller.current = ctrl;
      try {
        const response = await sendMessage({ message: text, sessionId: session.current }, (e) => patch(id, (t) => ({ ...t, steps: applyProgress(t.steps, e) })), ctrl.signal);
        session.current = response.sessionId;
        patch(id, (t) => ({ ...t, response, pending: false }));
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        const error = e instanceof ChatError ? e.info : { code: 'internal_error', message: 'The request failed.', status: 500 };
        patch(id, (t) => ({ ...t, error, pending: false }));
      }
    },
    [patch],
  );

  const reset = useCallback(() => {
    controller.current?.abort();
    const sid = session.current;
    session.current = undefined;
    setTurns([]);
    if (sid) void resetConversation(sid);
  }, []);

  return { turns, busy: turns.some((t) => t.pending), send, reset, lastId: turns.at(-1)?.id };
}
