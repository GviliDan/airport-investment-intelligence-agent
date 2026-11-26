import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';

describe('parseConfig', () => {
  it('applies defaults and treats blank values as unset', () => {
    const c = parseConfig({ GEMINI_API_KEY: '', GEMINI_MODEL: '  ', PORT: '' });
    expect(c.PORT).toBe(3001);
    expect(c.GEMINI_MODEL).toBe('gemini-3.5-flash-lite');
    expect(c.GEMINI_API_KEY).toBeUndefined();
  });
  it('reads the model from the environment', () => {
    expect(parseConfig({ GEMINI_MODEL: 'some-model' }).GEMINI_MODEL).toBe('some-model');
  });
  it('rejects an invalid step limit', () => {
    expect(() => parseConfig({ AGENT_MAX_STEPS: '0' })).toThrow();
  });
});
