import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { parseConfig } from './config.js';

describe('GET /health', () => {
  it('reports status and whether chat is available, without exposing the key', async () => {
    const server = createApp(parseConfig({ GEMINI_API_KEY: 'secret-key' })).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(JSON.parse(text)).toMatchObject({ status: 'ok', chat: false });
      expect(text).not.toContain('secret-key');
    } finally {
      server.close();
    }
  });
});
