import type { FetchLike } from '../http.js';

export interface Call {
  url: string;
}

/** Scripted fetch: each response is used once, in order; the last one repeats. Records requested URLs. */
export function scriptedFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: FetchLike = async (input) => {
    calls.push({ url: String(input) });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return (r as Response).clone();
  };
  return { fetch, calls };
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const text = (body: string, status = 200): Response => new Response(body, { status });
