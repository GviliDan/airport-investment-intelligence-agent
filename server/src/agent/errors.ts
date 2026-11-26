export type AgentErrorCode = 'chat_not_configured' | 'invalid_request' | 'session_busy' | 'server_busy' | 'model_unavailable' | 'timeout' | 'internal_error';

/** A failure of the chat service itself (not of a tool). Messages are safe to show to clients: they never contain keys. */
export class AgentError extends Error {
  constructor(readonly code: AgentErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = 'AgentError';
  }
}
