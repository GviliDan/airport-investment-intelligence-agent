import { describe, expect, it } from 'vitest';
import { ProviderError } from '../errors.js';
import { getJson, type FetchLike } from '../http.js';
import { json, scriptedFetch, text } from './support.js';

const opts = (fetch: FetchLike, extra = {}) => ({ source: 'test', fetch, backoffMs: 0, ...extra });

describe('getJson', () => {
  it('retries 503 and then succeeds', async () => {
    const { fetch, calls } = scriptedFetch([text('busy', 503), json({ ok: true })]);
    await expect(getJson('http://x', opts(fetch))).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });
  it('retries 429 and reports rate-limited when it never clears', async () => {
    const { fetch, calls } = scriptedFetch([text('slow down', 429)]);
    await expect(getJson('http://x', opts(fetch, { retries: 2 }))).rejects.toMatchObject({ kind: 'rate-limited', status: 429 });
    expect(calls).toHaveLength(3);
  });
  it('does not retry client errors', async () => {
    const { fetch, calls } = scriptedFetch([text('nope', 404)]);
    await expect(getJson('http://x', opts(fetch))).rejects.toMatchObject({ kind: 'http', status: 404 });
    expect(calls).toHaveLength(1);
  });
  it('turns network failures into ProviderError after retries', async () => {
    const { fetch } = scriptedFetch([new TypeError('fetch failed')]);
    const err = await getJson('http://x', opts(fetch, { retries: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: 'network' });
  });
  it('reports timeouts', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const { fetch } = scriptedFetch([timeout]);
    await expect(getJson('http://x', opts(fetch, { retries: 0 }))).rejects.toMatchObject({ kind: 'timeout' });
  });
  it('rejects a body that is not JSON', async () => {
    const { fetch } = scriptedFetch([text('<html>')]);
    await expect(getJson('http://x', opts(fetch))).rejects.toMatchObject({ kind: 'invalid-response' });
  });
});
