import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { Config } from '../config.js';
import type { RateLimiter } from './rateLimiter.js';
import { limiterFor } from './rateLimiter.js';

/**
 * Gemini chat model that waits for a free slot in its per-model rate limit before every request. Retries by the agent
 * middleware call the model again, so they pass through the limiter too: the quota is never exceeded by retrying.
 */
class RateLimitedGemini extends ChatGoogleGenerativeAI {
  constructor(fields: ConstructorParameters<typeof ChatGoogleGenerativeAI>[0], private readonly limiter: RateLimiter) {
    super(fields);
  }

  override async _generate(messages: BaseMessage[], options: this['ParsedCallOptions'], runManager?: CallbackManagerForLLMRun): Promise<ChatResult> {
    await this.limiter.acquire(options.signal);
    return super._generate(messages, options, runManager);
  }
}

/**
 * Builds the Gemini chat model. The model name always comes from configuration, never from code. Retries are handled one
 * level up (see retry.ts and the agent middleware) so there is a single, bounded retry policy; this class only paces requests.
 */
export function createChatModel(config: Config, modelName: string = config.GEMINI_MODEL): ChatGoogleGenerativeAI {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set; chat is unavailable.');
  return new RateLimitedGemini({ model: modelName, apiKey: config.GEMINI_API_KEY, temperature: 0, maxRetries: 0 }, limiterFor(modelName, config.MODEL_RPM));
}
