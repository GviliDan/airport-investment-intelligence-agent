/** One cheap request to each configured model (primary and fallbacks), to confirm names, keys and tool support are live. Run: npm run check:models */
import { createChatModel } from '../src/agent/llm.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const names = [config.GEMINI_MODEL, ...(config.GEMINI_FALLBACK_MODEL ?? '').split(',').map((s) => s.trim()).filter(Boolean)];
for (const name of names) {
  try {
    const r = await createChatModel(config, name).invoke([{ role: 'user', content: 'Reply with the single word: ok' }]);
    console.log(`${name}: ok (${String(r.content).trim().slice(0, 20)})`);
  } catch (e) {
    console.log(`${name}: FAILED ${(e as Error).message.replace(/key=[^&\s]+/g, 'key=[redacted]').slice(0, 160)}`);
  }
}
