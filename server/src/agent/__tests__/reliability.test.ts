import { describe, expect, it } from 'vitest';
import { OVERCLAIM_NOTE, overclaims } from '../wording.js';
import type { Artifact } from '../types.js';
import { buildAgent, callTool, cfg, ScriptedModel, say, type Step } from './support.js';

const compare = (reliable: boolean, verdicts: [string, string]): Artifact => ({
  id: 'c1', tool: 'compare_operations', args: {},
  output: { ok: true, tool: 'compare_operations', periods: {}, sources: [], assumptions: [], limitations: [], data: { airports: [{ operations: { reliable } }, { operations: { reliable } }], comparisons: [{ departureDelayRate15: { verdict: verdicts[0] }, cancellationRate: { verdict: verdicts[1] } }] } },
});

describe('overclaims', () => {
  it('flags strong wording when coverage is weak or no verdict shows a difference', () => {
    expect(overclaims('STT is significantly higher than GUM.', [compare(false, ['a-higher', 'a-higher'])])).toBe(true);
    expect(overclaims('LAX is much higher than SNA.', [compare(true, ['indistinguishable', 'indistinguishable'])])).toBe(true);
  });
  it('allows strong wording when reliable data and the tool verdict support it', () => {
    expect(overclaims('A is significantly higher.', [compare(true, ['a-higher', 'indistinguishable'])])).toBe(false);
  });
  it('ignores answers without strong wording, and turns without a comparison', () => {
    expect(overclaims('The rates are 24% and 25%.', [compare(false, ['indistinguishable', 'indistinguishable'])])).toBe(false);
    expect(overclaims('significantly higher', [])).toBe(false);
  });
});

describe('AirportAgent: overclaiming wording', () => {
  const run = (script: Step[]) => {
    const model = new ScriptedModel(script);
    return { model, ...buildAgent(model) };
  };

  it('asks for a neutral rewrite when the comparison data are weak', async () => {
    const { agent, model } = run([
      callTool('compare_operations', { airports: ['GUM', 'STT'] }),
      say('STT has a significantly higher departure delay rate than GUM.'),
      say('STT shows a higher departure delay rate than GUM, but on-time coverage is weak so the figures are indicative.'),
    ]);
    const r = await agent.chat({ message: 'Compare delays at GUM and STT.' });
    expect(r.grounding.overclaim).toBe('rewritten');
    expect(r.answer).not.toMatch(/significantly/i);
    expect(String(model.calls[2]?.[1]?.content)).toMatch(/Rewrite without strong wording/);
  });

  it('keeps the wording but adds a note if the rewrite still overclaims', async () => {
    const { agent } = run([
      callTool('compare_operations', { airports: ['GUM', 'STT'] }),
      say('STT is significantly worse than GUM.'),
      say('STT is substantially worse than GUM.'),
    ]);
    const r = await agent.chat({ message: 'Compare delays at GUM and STT.' });
    expect(r.grounding.overclaim).toBe('noted');
    expect(r.answer).toContain(OVERCLAIM_NOTE);
  });

  it('does nothing when the wording is neutral', async () => {
    const { agent, model } = run([callTool('compare_operations', { airports: ['GUM', 'STT'] }), say('STT shows a higher delay rate than GUM, on indicative data.')]);
    const r = await agent.chat({ message: 'Compare delays at GUM and STT.' });
    expect(r.grounding.overclaim).toBe('none');
    expect(model.calls).toHaveLength(2);
  });
});

describe('AirportAgent: fallback chain', () => {
  const quota = () => new Error('[429 Too Many Requests] You exceeded your current quota. Generate content requests per day limit exceeded. Please retry in 15h36m43s.');
  const overloaded = () => new Error('[503 Service Unavailable] This model is currently experiencing high demand.');

  it('moves down the chain: overloaded primary, exhausted first fallback, working second fallback', async () => {
    const primary = new ScriptedModel([overloaded()], 'primary-model');
    const fb1 = new ScriptedModel([quota()], 'fallback-one');
    const fb2 = new ScriptedModel([say('Answered by the second fallback.')], 'fallback-two');
    const config = cfg({ GEMINI_MODEL: 'primary-model', MODEL_MAX_RETRIES: '0' });
    const { agent: rebuilt } = buildAgent(primary, { config, fallbacks: [fb1, fb2] });
    const r = await rebuilt.chat({ message: 'hi' });
    expect(r.answer).toBe('Answered by the second fallback.');
    expect(r.usage.usedFallback).toBe(true);
    expect(fb1.calls).toHaveLength(1);
    expect(fb2.calls).toHaveLength(1);
  });

  it('reports a quota error clearly when every model is exhausted, and does not retry a daily quota', async () => {
    const primary = new ScriptedModel([quota()], 'primary-model');
    const { agent } = buildAgent(primary, { config: cfg({ MODEL_MAX_RETRIES: '3' }) });
    const err = await agent.chat({ message: 'hi' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'model_unavailable', status: 503 });
    expect(String((err as Error).message)).toMatch(/quota/);
    expect(primary.calls).toHaveLength(1);
  });
});
