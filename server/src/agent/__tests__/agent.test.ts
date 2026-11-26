import { describe, expect, it } from 'vitest';
import { AgentError } from '../errors.js';
import { contentToText } from '../agent.js';
import { ProviderError } from '../../data/errors.js';
import { TrafficProvider } from '../../data/trafficProvider.js';
import { buildAgent, callTool, cfg, ScriptedModel, say, store } from './support.js';

const ANC_ANSWER = 'ANC: 4.6% of 13,794 scheduled passenger departures (628) in June to August 2026 were 3,000 miles or more.';

describe('AirportAgent: orchestration', () => {
  it('runs a tool, returns its full artifact, and checks the answer against it', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }, 'c1'), say(ANC_ANSWER)]);
    const { agent } = buildAgent(model);
    const r = await agent.chat({ message: 'Long haul share at ANC?' });
    expect(r.answer).toBe(ANC_ANSWER);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]).toMatchObject({ id: 'c1', tool: 'get_long_haul_share', args: { airport: 'ANC' }, output: { ok: true, tool: 'get_long_haul_share' } });
    expect((r.artifacts[0]?.output as { data: { longHaulDepartures: number } }).data.longHaulDepartures).toBe(628);
    expect(r.grounding).toMatchObject({ status: 'verified', draftUnsupportedFigures: [], removedStatements: 0 });
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.periods[0]).toMatchObject({ tool: 'get_long_haul_share' });
    expect(r.assumptions.length).toBeGreaterThan(0);
    expect(r.limitations.length).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
    expect(r.usage).toMatchObject({ toolCalls: 1, modelAttempts: 2, modelRetries: 0, usedFallback: false, inputTokens: 200, outputTokens: 30, totalTokens: 230 });
    expect(r.usage.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.usage.toolTimingsMs).toHaveProperty('get_long_haul_share');
    expect(r.history).toEqual({ turnsKept: 1, truncated: false });
  });

  it('gives the model the system prompt, the tool descriptions, and no unverified claims about data periods', async () => {
    const model = new ScriptedModel([say('Hello.')]);
    const { agent } = buildAgent(model);
    await agent.chat({ message: 'hi' });
    const first = model.calls[0] ?? [];
    expect(first[0]?.getType()).toBe('system');
    const prompt = contentToText(first[0]?.content);
    expect(prompt).toMatch(/never calculate or recall figures/);
    expect(prompt).toContain(store.alignedMonths.join(', '));
    expect(prompt).toMatch(/never pick yourself/);
    expect(prompt).toMatch(/not instructions/);
    expect(prompt).not.toMatch(/default(s)? to New England|assume New England/i);
  });

  it('rewrites an answer whose figures are not in the tool results, once, and reports it', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say('About 7.7% of departures from ANC are long haul (3,000 miles).'), say(ANC_ANSWER)]);
    const { agent } = buildAgent(model);
    const r = await agent.chat({ message: 'Long haul share at ANC?' });
    expect(r.answer).toBe(ANC_ANSWER);
    expect(r.grounding).toMatchObject({ status: 'corrected', draftUnsupportedFigures: ['7.7%'], removedStatements: 0, nudgedToUseTools: false, overclaim: 'none' });
    expect(model.calls).toHaveLength(3);
    const rewritePrompt = String(model.calls[2]?.[1]?.content);
    expect(rewritePrompt).toContain('do not appear in the tool results: 7.7%');
    expect(rewritePrompt).toContain('"longHaulDepartures":628');
  });

  it('never shows figures it could not verify: the statements carrying them are removed', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say('About 7.7% are long haul.'), say('Still 7.7% long haul.')]);
    const { agent } = buildAgent(model);
    const r = await agent.chat({ message: 'Long haul share at ANC?' });
    expect(r.grounding).toMatchObject({ status: 'redacted', draftUnsupportedFigures: ['7.7%'], removedStatements: 1 });
    expect(r.answer).not.toContain('7.7%');
    expect(r.answer).toMatch(/could not verify the figures/);
    expect(r.artifacts).toHaveLength(1);
  });

  it('keeps the verified part of a partly unsupported answer and says what was removed', async () => {
    const draft = 'ANC had 13,794 departures in the period.\nIts delay rate was 31.7%.\n- Long haul share 4.6% (628 departures).\n- Cancellation rate 9.9%.';
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say(draft)]);
    const { agent } = buildAgent(model, { config: cfg({ GROUNDING_CORRECTION: 'false' }) });
    const r = await agent.chat({ message: 'x?' });
    expect(r.answer).toContain('13,794 departures');
    expect(r.answer).toContain('4.6% (628');
    expect(r.answer).not.toContain('31.7%');
    expect(r.answer).not.toContain('9.9%');
    expect(r.answer).toMatch(/2 statements were removed/);
    expect(r.grounding).toMatchObject({ status: 'redacted', removedStatements: 2 });
  });

  it('can be told not to rewrite, and then redacts straight away', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say('About 7.7% are long haul.')]);
    const { agent } = buildAgent(model, { config: cfg({ GROUNDING_CORRECTION: 'false' }) });
    const r = await agent.chat({ message: 'x?' });
    expect(model.calls).toHaveLength(2);
    expect(r.grounding.status).toBe('redacted');
  });

  it('sends the model back to use tools when it answers with figures but called none, and uses the second attempt', async () => {
    const model = new ScriptedModel([say('SFO load factor is 82.2% and taxi-out is 19.3 minutes.'), callTool('analyze_demand_pressure', { airport: 'SFO' }), say('SFO seat load factor is 81.7% over the latest 12 months; it is an indicator, not unmet demand.')]);
    const r = await buildAgent(model).agent.chat({ message: 'What is the unmet demand at SFO?' });
    expect(r.grounding).toMatchObject({ nudgedToUseTools: true, status: 'verified', removedStatements: 0 });
    expect(r.artifacts.map((a) => a.tool)).toEqual(['analyze_demand_pressure']);
    expect(r.answer).toContain('81.7%');
    expect(r.answer).not.toContain('82.2%');
    expect(contentToText(model.calls[1]?.at(-1)?.content)).toMatch(/do not answer from memory/);
    expect(contentToText(model.calls[1]?.at(-1)?.content)).toContain('What is the unmet demand at SFO?');
  });

  it('gives no figures at all if the model still will not call a tool after being sent back', async () => {
    const model = new ScriptedModel([say('SFO load factor is 82.2%.'), say('SFO load factor is 82.2%.')]);
    const r = await buildAgent(model).agent.chat({ message: 'SFO load factor?' });
    expect(r.artifacts).toEqual([]);
    expect(r.answer).not.toMatch(/82\.2/);
    expect(r.answer).toMatch(/could not retrieve data/);
    expect(r.grounding).toMatchObject({ status: 'redacted', nudgedToUseTools: true });
  });

  it('does not nudge an answer that has no figures', async () => {
    const model = new ScriptedModel([say('I can only help with US airport analysis.')]);
    const r = await buildAgent(model).agent.chat({ message: 'pizza?' });
    expect(model.calls).toHaveLength(1);
    expect(r.grounding.nudgedToUseTools).toBe(false);
  });

  it('answers without tools for out-of-scope input, with nothing to verify', async () => {
    const model = new ScriptedModel([say('I can only help with US airport analysis.')]);
    const r = await buildAgent(model).agent.chat({ message: 'pizza?' });
    expect(r.artifacts).toEqual([]);
    expect(r.grounding.status).toBe('no_figures');
    expect(r.usage.toolCalls).toBe(0);
  });
});

describe('AirportAgent: tool failures and ambiguity', () => {
  it('reports ambiguity as structured data and flags that a clarification is needed', async () => {
    const model = new ScriptedModel([callTool('get_traffic_metrics', { airports: ['Portland'] }), say('Which Portland do you mean: PDX (Oregon) or PWM (Maine)?')]);
    const r = await buildAgent(model).agent.chat({ message: 'Traffic at Portland?' });
    expect(r.errors).toEqual([{ tool: 'get_traffic_metrics', code: 'ambiguous_airport', message: expect.stringContaining('Portland') }]);
    expect(r.ambiguities[0]).toMatchObject({ input: 'Portland' });
    expect(r.ambiguities[0]?.options.map((o) => o.code)).toEqual(expect.arrayContaining(['PDX', 'PWM']));
    expect(r.needsClarification).toBe(true);
    expect(r.grounding.status).toBe('no_figures');
  });

  it('surfaces a data-source failure and keeps the failure in the artifacts; no numbers appear', async () => {
    const failing = { monthly: async () => { throw new ProviderError('bts-socrata', 'timeout', 'timed out after 20000 ms'); } } as unknown as TrafficProvider;
    const model = new ScriptedModel([callTool('get_traffic_metrics', { airports: ['DEN'] }), say('The BTS data source timed out, so I cannot give Denver passenger numbers right now. Please try again.')]);
    const r = await buildAgent(model, { traffic: failing }).agent.chat({ message: 'Denver passengers?' });
    expect(r.errors[0]).toMatchObject({ code: 'provider_error' });
    expect(r.artifacts[0]?.output.ok).toBe(false);
    expect(r.grounding.checked).toBe(0);
  });

  it('turns arguments rejected by the tool schema into a structured failure the model can react to', async () => {
    const model = new ScriptedModel([callTool('rank_expansion_opportunities', { state: 'MA' }), say('I will retry with the right parameter.')]);
    const r = await buildAgent(model).agent.chat({ message: 'rank MA' });
    expect(r.artifacts[0]?.output).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    expect(r.errors[0]?.code).toBe('invalid_arguments');
  });

  it('lets the model recover after a failed call by calling again with corrected arguments', async () => {
    const model = new ScriptedModel([callTool('rank_expansion_opportunities', { state: 'MA' }, 'a'), callTool('rank_expansion_opportunities', { states: ['MA'], top_n: 3 }, 'b'), say('Boston (BOS) is the top-ranked Massachusetts airport in this screening.')]);
    const r = await buildAgent(model).agent.chat({ message: 'rank MA' });
    expect(r.artifacts.map((a) => a.output.ok)).toEqual([false, true]);
    expect(r.answer).toMatch(/Boston/);
  });
});

describe('AirportAgent: limits and loops', () => {
  it('blocks an identical repeated tool call and tells the model to reuse the earlier result', async () => {
    const same = { airport: 'ANC' };
    const model = new ScriptedModel([callTool('get_long_haul_share', same, 'a'), callTool('get_long_haul_share', same, 'b'), say(ANC_ANSWER)]);
    const r = await buildAgent(model).agent.chat({ message: 'x?' });
    expect(r.usage.duplicateToolCallsBlocked).toBe(1);
    expect(r.artifacts).toHaveLength(1);
    const toolMsgs = (model.calls[2] ?? []).filter((m) => m.getType() === 'tool').map((m) => String(m.content));
    expect(toolMsgs[1]).toMatch(/already made in this turn/);
  });

  it('stops a model that never stops calling tools, at the configured number of model calls', async () => {
    let n = 0;
    const model = new ScriptedModel([() => callTool('find_airports', { states: ['VT'], limit: 1 + (n += 1) % 90 })]);
    const { agent } = buildAgent(model, { config: cfg({ AGENT_MAX_STEPS: '4', AGENT_MAX_TOOL_CALLS: '20', GROUNDING_CORRECTION: 'false' }) });
    const r = await agent.chat({ message: 'loop' });
    expect(model.calls.length).toBeLessThanOrEqual(5);
    expect(r.usage.limitReached).toBe('model_calls');
    expect(r.answer).toMatch(/reached the limit/);
    expect(r.artifacts.length).toBeLessThanOrEqual(4);
  });

  it('caps the number of tool calls and says so to the model', async () => {
    let n = 0;
    const model = new ScriptedModel([() => callTool('find_airports', { states: ['VT'], limit: 2 + (n += 1) }), ...Array.from({ length: 6 }, () => () => callTool('find_airports', { states: ['VT'], limit: 50 + (n += 1) }))]);
    const { agent } = buildAgent(model, { config: cfg({ AGENT_MAX_STEPS: '8', AGENT_MAX_TOOL_CALLS: '2', GROUNDING_CORRECTION: 'false' }) });
    const r = await agent.chat({ message: 'loop' });
    expect(r.usage.limitReached).toBeDefined();
    expect(r.usage.toolCalls).toBeLessThanOrEqual(8);
  });

  it('times out a stuck model with a typed error, not a hang', async () => {
    const slow = new ScriptedModel([() => new Promise((resolve) => setTimeout(() => resolve(say('late')), 3_000))]);
    const { agent } = buildAgent(slow, { config: cfg({ REQUEST_TIMEOUT_MS: '1000' }) });
    const started = Date.now();
    await expect(agent.chat({ message: 'hi' })).rejects.toMatchObject({ code: 'timeout', status: 504 });
    expect(Date.now() - started).toBeLessThan(2_800);
  }, 10_000);
});

describe('AirportAgent: model failures', () => {
  const overloaded = () => new Error('[GoogleGenerativeAI Error]: [503 Service Unavailable] This model is currently experiencing high demand.');

  it('retries a transient model error and records it', async () => {
    const model = new ScriptedModel([overloaded(), say('Hello.')]);
    const r = await buildAgent(model).agent.chat({ message: 'hi' });
    expect(r.answer).toBe('Hello.');
    expect(r.usage).toMatchObject({ modelAttempts: 2, modelRetries: 1 });
  });

  it('falls back to the secondary model when the primary keeps failing', async () => {
    const primary = new ScriptedModel([overloaded()], 'primary-model');
    const fallback = new ScriptedModel([say('From the fallback.')], 'fallback-model');
    const { agent } = buildAgent(primary, { fallback, config: cfg({ GEMINI_MODEL: 'primary-model', MODEL_MAX_RETRIES: '1' }) });
    const r = await agent.chat({ message: 'hi' });
    expect(r.answer).toBe('From the fallback.');
    expect(r.usage.usedFallback).toBe(true);
    expect(primary.calls.length).toBe(2);
    expect(fallback.calls.length).toBe(1);
  });

  it('reports model_unavailable (503) when retries and fallback are exhausted, without leaking the raw error', async () => {
    const leak = new Error('[503 Service Unavailable] overloaded https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=SUPERSECRETKEY123456');
    const logs: unknown[] = [];
    const { agent } = buildAgent(new ScriptedModel([leak]), { logs });
    const err = await agent.chat({ message: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err).toMatchObject({ code: 'model_unavailable', status: 503 });
    expect(String((err as Error).message)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(logs)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(logs)).toContain('[redacted]');
  });

  it('does not retry permanent errors such as an invalid key', async () => {
    const model = new ScriptedModel([new Error('[403 Forbidden] API key not valid')]);
    const err = await buildAgent(model).agent.chat({ message: 'hi' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'internal_error', status: 500 });
    expect(model.calls).toHaveLength(1);
  });

  it('does not store a failed turn in the conversation', async () => {
    const model = new ScriptedModel([new Error('503 overloaded'), new Error('503 overloaded'), new Error('503 overloaded'), say('ok')]);
    const { agent, conversations } = buildAgent(model, { config: cfg({ MODEL_MAX_RETRIES: '1' }) });
    await expect(agent.chat({ message: 'first' })).rejects.toBeInstanceOf(AgentError);
    expect(conversations.size).toBe(1);
    const session = conversations.open();
    expect(session.turns).toHaveLength(0);
  });
});

describe('AirportAgent: conversations', () => {
  it('replays earlier turns with a memory note of the tools used, so follow-ups can reuse arguments', async () => {
    const model = new ScriptedModel([callTool('rank_expansion_opportunities', { states: ['TX'], top_n: 3 }), say('Austin (AUS) ranks first in this screening of Texas airports.'), say('Done.')]);
    const { agent } = buildAgent(model);
    const first = await agent.chat({ message: 'Rank Texas' });
    await agent.chat({ sessionId: first.sessionId, message: 'And Florida?' });
    const second = model.calls[2] ?? [];
    expect(second.map((m) => m.getType())).toEqual(['system', 'human', 'ai', 'human']);
    expect(String(second[1]?.content)).toBe('Rank Texas');
    const memory = String(second[2]?.content);
    expect(memory).toContain('Austin (AUS) ranks first');
    expect(memory).toContain('rank_expansion_opportunities({"states":["TX"],"top_n":3})');
    expect(memory).toMatch(/never to be repeated/);
    expect(String(second[3]?.content)).toBe('And Florida?');
  });

  it('keeps conversations isolated: another session sees none of this history', async () => {
    const model = new ScriptedModel([say('Reply one.'), say('Reply two.'), say('Reply three.')]);
    const { agent } = buildAgent(model);
    const a = await agent.chat({ message: 'secret question from A' });
    const b = await agent.chat({ message: 'question from B' });
    expect(a.sessionId).not.toBe(b.sessionId);
    const seenByB = JSON.stringify(model.calls[1]?.map((m) => m.content));
    expect(seenByB).not.toContain('secret question from A');
    expect(seenByB).not.toContain('Reply one');
    await agent.chat({ sessionId: a.sessionId, message: 'again' });
    expect(JSON.stringify(model.calls[2]?.map((m) => m.content))).toContain('secret question from A');
    expect(JSON.stringify(model.calls[2]?.map((m) => m.content))).not.toContain('question from B');
  });

  it('resets a conversation', async () => {
    const model = new ScriptedModel([say('One.'), say('Two.')]);
    const { agent } = buildAgent(model);
    const a = await agent.chat({ message: 'remember this' });
    expect(agent.reset(a.sessionId)).toBe(true);
    expect(agent.reset(a.sessionId)).toBe(false);
    await agent.chat({ sessionId: a.sessionId, message: 'hello again' });
    expect(JSON.stringify(model.calls[1]?.map((m) => m.content))).not.toContain('remember this');
  });

  it('bounds history by turns and says it was truncated', async () => {
    const model = new ScriptedModel([say('ok')]);
    const { agent } = buildAgent(model, { config: cfg({ HISTORY_MAX_TURNS: '2' }) });
    let sid: string | undefined;
    let last;
    for (let i = 1; i <= 4; i += 1) {
      last = await agent.chat({ sessionId: sid, message: `message ${i}` });
      sid = last.sessionId;
    }
    expect(last?.history).toEqual({ turnsKept: 2, truncated: true });
    const final = JSON.stringify(model.calls.at(-1)?.map((m) => m.content));
    expect(final).toContain('message 3');
    expect(final).not.toContain('message 1');
  });

  it('lets a follow-up restate figures the user already saw without a new tool call', async () => {
    const model = new ScriptedModel([callTool('get_long_haul_share', { airport: 'ANC' }), say(ANC_ANSWER), say('As before, 628 of 13,794 departures (4.6%).')]);
    const { agent } = buildAgent(model);
    const a = await agent.chat({ message: 'ANC long haul?' });
    const b = await agent.chat({ sessionId: a.sessionId, message: 'Repeat that.' });
    expect(b.grounding.status).toBe('verified');
  });

  it('rejects a second message while the first is still being answered, and rejects bad input', async () => {
    let release: (m: ReturnType<typeof say>) => void = () => undefined;
    const model = new ScriptedModel([() => new Promise((resolve) => { release = resolve; })]);
    const { agent } = buildAgent(model);
    const first = agent.chat({ message: 'slow' });
    await new Promise((r) => setTimeout(r, 50));
    const sid = [...(agent as unknown as { deps: { conversations: { sessions: Map<string, unknown> } } }).deps.conversations['sessions' as never] as unknown as Map<string, unknown>][0]?.[0] as string;
    await expect(agent.chat({ sessionId: sid, message: 'second' })).rejects.toMatchObject({ code: 'session_busy', status: 409 });
    release(say('done'));
    await first;
    await expect(agent.chat({ message: '   ' })).rejects.toMatchObject({ code: 'invalid_request', status: 400 });
    await expect(agent.chat({ message: 'x'.repeat(2001) })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(agent.chat({ sessionId: 'not-a-uuid', message: 'hi' })).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('limits concurrent turns', async () => {
    const releases: Array<(m: ReturnType<typeof say>) => void> = [];
    const model = new ScriptedModel([() => new Promise((resolve) => { releases.push(resolve); })]);
    const { agent } = buildAgent(model, { config: cfg({ MAX_CONCURRENT_TURNS: '1' }) });
    const first = agent.chat({ message: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    await expect(agent.chat({ message: 'b' })).rejects.toMatchObject({ code: 'server_busy', status: 429 });
    releases[0]?.(say('ok'));
    await first;
  });
});
