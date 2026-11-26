import { createApp } from './app.js';
import { compose } from './compose.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { agent, store } = await compose(config);
createApp(config, { ...(agent ? { agent } : {}), store }).listen(config.PORT, () => {
  console.log(`API listening on http://localhost:${config.PORT} (chat ${agent ? 'enabled' : 'disabled: GEMINI_API_KEY not set'})`);
});
