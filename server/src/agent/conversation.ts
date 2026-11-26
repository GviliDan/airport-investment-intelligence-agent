import { randomUUID } from 'node:crypto';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { PriorCall } from '../tools/index.js';
import { AgentError } from './errors.js';

export interface Turn {
  readonly user: string;
  readonly assistant: string;
  /** One line per tool call made in the turn (arguments and an outline of the result), for follow-up questions. */
  readonly digest: readonly string[];
  /** Numbers the user saw in this turn; follow-ups may restate them without a fresh tool call. */
  readonly numbers: readonly number[];
  /** Tool calls of the turn with the arguments that ran, so follow-ups can carry forward what the user set. */
  readonly calls?: readonly PriorCall[];
}

export interface StoreOptions {
  readonly maxTurns: number;
  readonly maxChars: number;
  readonly ttlMs: number;
  readonly maxSessions: number;
  readonly now?: () => number;
  readonly newId?: () => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const turnChars = (t: Turn): number => t.user.length + t.assistant.length + t.digest.reduce((n, d) => n + d.length, 0);

export class Session {
  turns: Turn[] = [];
  busy = false;
  /** True once older turns were dropped to stay within the history bounds. */
  truncated = false;
  lastUsed: number;
  constructor(readonly id: string, now: number, private readonly opts: Pick<StoreOptions, 'maxTurns' | 'maxChars'>) {
    this.lastUsed = now;
  }

  /** Messages replayed to the model: prior user messages and answers, each answer followed by a note on the tools it used. */
  toMessages(): BaseMessage[] {
    return this.turns.flatMap((t) => [
      new HumanMessage(t.user),
      new AIMessage(
        t.digest.length > 0
          ? `${t.assistant}\n\n[Memory note, not part of the reply and never to be repeated to the user. Tools used in this turn: ${t.digest.join(' | ')}]`
          : t.assistant,
      ),
    ]);
  }

  /** Tool calls from the kept turns, oldest first. */
  priorCalls(): PriorCall[] {
    return this.turns.flatMap((t) => [...(t.calls ?? [])]);
  }

  numbers(): Set<number> {
    return new Set(this.turns.flatMap((t) => t.numbers));
  }

  add(turn: Turn): void {
    this.turns.push(turn);
    while (this.turns.length > this.opts.maxTurns) this.drop();
    while (this.turns.length > 1 && this.turns.reduce((n, t) => n + turnChars(t), 0) > this.opts.maxChars) this.drop();
  }

  private drop(): void {
    this.turns.shift();
    this.truncated = true;
  }
}

/**
 * In-memory conversations keyed by an unguessable session id. Sessions never share state, expire after inactivity, and the
 * least recently used one is evicted when the store is full. There is no persistence: a restart clears everything.
 */
export class ConversationStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly opts: StoreOptions) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Returns the session for a client-supplied id, or creates one (with a fresh id when none is given). */
  open(id?: string): Session {
    if (id !== undefined && !UUID.test(id)) throw new AgentError('invalid_request', 'sessionId must be a UUID returned by a previous response.', 400);
    this.sweep();
    const sid = id ?? this.newId();
    const existing = this.sessions.get(sid);
    if (existing) {
      existing.lastUsed = this.now();
      return existing;
    }
    if (this.sessions.size >= this.opts.maxSessions) this.evictOldest();
    const s = new Session(sid, this.now(), this.opts);
    this.sessions.set(sid, s);
    return s;
  }

  /** Forgets a conversation. Returns whether it existed. */
  reset(id: string): boolean {
    if (!UUID.test(id)) throw new AgentError('invalid_request', 'sessionId must be a UUID.', 400);
    return this.sessions.delete(id);
  }

  private sweep(): void {
    const cutoff = this.now() - this.opts.ttlMs;
    for (const [id, s] of this.sessions) if (!s.busy && s.lastUsed < cutoff) this.sessions.delete(id);
  }

  private evictOldest(): void {
    let oldest: Session | undefined;
    for (const s of this.sessions.values()) if (!s.busy && (!oldest || s.lastUsed < oldest.lastUsed)) oldest = s;
    if (!oldest) throw new AgentError('server_busy', 'Too many active conversations; try again shortly.', 429);
    this.sessions.delete(oldest.id);
  }
}
