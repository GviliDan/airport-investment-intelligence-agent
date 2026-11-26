import type { ApiError } from '@/types';

export interface ErrorView {
  title: string;
  detail: string;
  /** What the user can do about it. */
  hint: string;
  retryable: boolean;
}

/** User-facing wording for each failure the server or the network can report. Never shows raw provider text. */
export function describeError(e: ApiError): ErrorView {
  switch (e.code) {
    case 'model_unavailable':
      return /quota/i.test(e.message)
        ? { title: 'The AI model has reached its usage quota', detail: 'The free Gemini quota is used up for now, so I cannot write answers.', hint: 'Try again later, or set a fallback model or paid key on the server. The data itself is unaffected.', retryable: true }
        : { title: 'The AI model is busy', detail: 'Gemini is overloaded or rate-limiting requests right now. I already retried automatically.', hint: 'Wait a few seconds and retry. Nothing was answered, so no figures are missing or invented.', retryable: true };
    case 'timeout':
      return { title: 'This took too long', detail: 'The question was stopped before it finished.', hint: 'Retry, or ask something narrower (one region or a few airports).', retryable: true };
    case 'server_busy':
      return { title: 'The assistant is busy', detail: 'Other conversations are using all available capacity.', hint: 'Retry in a moment.', retryable: true };
    case 'session_busy':
      return { title: 'Still answering your previous message', detail: 'This conversation can handle one message at a time.', hint: 'Wait for the current answer to finish.', retryable: false };
    case 'chat_not_configured':
      return { title: 'Chat is not set up', detail: 'The server has no Gemini API key configured.', hint: 'Add GEMINI_API_KEY to the server environment and restart it.', retryable: false };
    case 'invalid_request':
      return { title: 'That message could not be sent', detail: e.message, hint: 'Messages must be 1 to 2,000 characters.', retryable: false };
    case 'network':
      return { title: 'Cannot reach the server', detail: e.message, hint: 'Check that the server is running and your connection is working, then retry.', retryable: true };
    default:
      return { title: 'Something went wrong', detail: 'The assistant failed to process this message.', hint: 'Retry. If it keeps happening, start a new conversation.', retryable: true };
  }
}
