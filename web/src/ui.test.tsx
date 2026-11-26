import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArtifactView } from '@/components/analytics/ArtifactView';
import { Markdown } from '@/components/chat/Markdown';
import { ProgressSteps } from '@/components/chat/ProgressSteps';
import { parseSse } from '@/services/api';
import type { Artifact } from '@/types';
import { describeError } from '@/utils/errors';
import { compact, fracPct, int, monthLabel, num, pct, periodLabel, signed, toolLabel } from '@/utils/format';
import { parseBlocks } from '@/utils/markdown';
import { applyProgress, type Step } from '@/utils/progress';

describe('parseSse', () => {
  it('parses complete events, keeps the unfinished tail, and ignores keep-alive comments', () => {
    const buf = 'event: progress\ndata: {"type":"thinking","attempt":1}\n\n: keep-alive\n\nevent: result\ndata: {"answer":"x"}\n\nevent: prog';
    const { events, rest } = parseSse(buf);
    expect(events).toEqual([{ event: 'progress', data: { type: 'thinking', attempt: 1 } }, { event: 'result', data: { answer: 'x' } }]);
    expect(rest).toBe('event: prog');
  });
  it('skips a malformed event without losing the later ones', () => {
    const { events } = parseSse('event: progress\ndata: {not json}\n\nevent: result\ndata: {"ok":true}\n\n');
    expect(events).toEqual([{ event: 'result', data: { ok: true } }]);
  });
});

describe('Markdown', () => {
  it('renders bold, italics, lists and paragraphs', () => {
    const html = renderToStaticMarkup(<Markdown text={'**Score:** 65.1\n\n- one\n- two\n\n1. first\n2. second'} />);
    expect(html).toContain('<strong>Score:</strong>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
  });
  it('never turns model text into HTML', () => {
    const html = renderToStaticMarkup(<Markdown text={'<img src=x onerror=alert(1)> and <script>alert(1)</script> **ok**'} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>ok</strong>');
  });
  it('joins wrapped list continuation lines and keeps headings as their own block', () => {
    const blocks = parseBlocks('### Heading\n- item one\n  continued\n- item two');
    expect(blocks).toEqual([{ kind: 'h', level: 3, text: 'Heading' }, { kind: 'ul', items: [{ text: 'item one continued', sub: [] }, { text: 'item two', sub: [] }] }]);
  });
  it('keeps one numbered list when bullets are nested under its items', () => {
    const html = renderToStaticMarkup(<Markdown text={'1. **BOS** score 65.1\n   * Key drivers: scale\n2. **BDL** score 63.2\n   * Key drivers: load factor'} />);
    expect(html.match(/<ol>/g)).toHaveLength(1);
    expect(html.match(/<ul class="mt-0.5">/g)).toHaveLength(2);
    expect(html).toContain('<li><strong>BOS</strong> score 65.1<ul class="mt-0.5"><li>Key drivers: scale</li></ul></li>');
  });
});

describe('format', () => {
  it('shows missing values as a dash, never as zero', () => {
    expect(int(undefined)).toBe('—');
    expect(pct(undefined)).toBe('—');
    expect(fracPct(null)).toBe('—');
    expect(num(Number.NaN)).toBe('—');
    expect(signed(undefined)).toBe('—');
  });
  it('formats numbers', () => {
    expect(int(20984982)).toBe('20,984,982');
    expect(fracPct(0.24148)).toBe('24.1%');
    expect(pct(81.0, 1)).toBe('81.0%');
    expect(signed(-1.86, 1, '%')).toBe('−1.9%');
    expect(signed(3.4, 1, '%')).toBe('+3.4%');
    expect(compact(20984982)).toBe('21M');
    expect(compact(697750)).toBe('698K');
    expect(compact(1280974)).toBe('1.3M');
  });
  it('labels periods and tools', () => {
    expect(monthLabel('2026-08')).toBe('Aug 2026');
    expect(periodLabel('2025-09..2026-08')).toBe('Sep 2025 to Aug 2026');
    expect(periodLabel('latest month 2026-08')).toBe('latest month 2026-08');
    expect(toolLabel('rank_expansion_opportunities')).toBe('Ranking expansion candidates');
    expect(toolLabel('unknown_tool')).toBe('unknown tool');
  });
});

describe('describeError', () => {
  it('explains model overload, quota exhaustion, timeouts and network failures without provider text', () => {
    const overload = describeError({ code: 'model_unavailable', message: 'The language model is temporarily unavailable (rate limit or overload).', status: 503 });
    expect(overload.title).toBe('The AI model is busy');
    expect(overload.retryable).toBe(true);
    const quota = describeError({ code: 'model_unavailable', message: "The language model's usage quota is used up for now. Please try again later.", status: 503 });
    expect(quota.title).toMatch(/quota/);
    expect(describeError({ code: 'timeout', message: 'x', status: 504 }).hint).toMatch(/narrower/);
    expect(describeError({ code: 'network', message: 'x', status: 0 }).retryable).toBe(true);
    expect(describeError({ code: 'session_busy', message: 'x', status: 409 }).retryable).toBe(false);
    expect(describeError({ code: 'chat_not_configured', message: 'x', status: 503 }).hint).toMatch(/GEMINI_API_KEY/);
    expect(describeError({ code: 'weird', message: 'raw provider text key=SECRET', status: 500 }).detail).not.toContain('SECRET');
  });
});

describe('applyProgress', () => {
  it('builds a readable sequence of steps from events', () => {
    let steps: Step[] = [];
    for (const e of [
      { type: 'thinking', attempt: 1 },
      { type: 'tool_start', tool: 'get_long_haul_share' },
      { type: 'tool_done', tool: 'get_long_haul_share' },
      { type: 'thinking', attempt: 2 },
      { type: 'checking' },
    ] as const) steps = applyProgress(steps, e);
    expect(steps.map((s) => `${s.label}:${s.state}`)).toEqual(['Understanding your question:done', 'Measuring long-haul share:done', 'Reading the results:done', 'Checking every figure against the data:running']);
  });
  it('shows a retry notice and clears it when work resumes', () => {
    let steps = applyProgress([], { type: 'thinking', attempt: 1 });
    steps = applyProgress(steps, { type: 'model_retry' });
    expect(steps.some((s) => s.key === 'retry')).toBe(true);
    steps = applyProgress(steps, { type: 'tool_start', tool: 'screen_airports' });
    expect(steps.some((s) => s.key === 'retry')).toBe(false);
  });
  it('renders progress with the elapsed time', () => {
    const html = renderToStaticMarkup(<ProgressSteps steps={[{ key: 'a', label: 'Screening airports', state: 'running' }]} startedAt={Date.now()} />);
    expect(html).toContain('Screening airports');
    expect(html).toContain('0s');
  });
});

const ok = (tool: string, data: unknown, extra: object = {}): Artifact => ({ id: tool, tool, args: {}, output: { ok: true, tool, data, periods: {}, sources: [], assumptions: [], limitations: [], ...extra } as never });

describe('ArtifactView renders authoritative numbers from tool results', () => {
  it('renders a ranking with the score, its components and the weights, and flags that it is not ROI', () => {
    const ranked = [{ rank: 1, code: 'BOS', name: 'Logan', state: 'MA', score: 65.12, scoreBounds: { low: 65.12, high: 65.12 }, rankRange: { best: 1, worst: 3 }, contributions: [{ metric: 'scale', label: 'Passenger scale', pillar: 'demand', raw: 20984982, imputed: false, percentile: 100, configuredWeight: 20, correlationFactor: 0.4, effectiveWeight: 11.2, points: 11.2 }, { metric: 'taxiOut', label: 'Median taxi-out time', pillar: 'strain', imputed: true, percentile: 50, configuredWeight: 10, correlationFactor: 1, effectiveWeight: 14.2, points: 7.1 }], evidence: { passengersLatest12m: 20984982, passengerGrowthPct: -1.9, loadFactorPct: 81 }, coverage: { weightCoverage: 0.9, missing: [{ metric: 'taxiOut', reason: 'no on-time data' }], onTimeCoverage: 0.8, faaMatched: true }, flags: [] }];
    const html = renderToStaticMarkup(<ArtifactView artifact={ok('rank_expansion_opportunities', { scope: 'states MA', ranking: { ranked, weights: { scale: 20, taxiOut: 10 }, candidateSet: { scored: 1, unscored: 0, excluded: 4 }, periods: { passengerWindow: { from: '2025-09', to: '2026-08' }, operationalMonths: ['2026-06', '2026-08'] }, readingGuide: ['It is not a forecast.'], correlationAdjustments: [], missingDataPolicy: 'neutral' } })} />);
    expect(html).toContain('Expansion screening ranking');
    expect(html).toContain('65.1');
    expect(html).toContain('21M');
    expect(html).toContain('Relative score, not ROI');
    expect(html).toContain('Sep 2025 to Aug 2026');
    expect(html).toContain('<td>Scale</td>');
    expect(html).toContain('11.2');
    expect(html).toContain('missing: neutral 50th percentile used');
    expect(html).toContain('4 below the passenger threshold');
  });
  it('shows a missing figure as a dash in a screen table, not zero', () => {
    const html = renderToStaticMarkup(<ArtifactView artifact={ok('screen_airports', { scope: 'all', rows: [{ code: 'GUM', name: 'Guam', passengers12m: 878772 }] })} />);
    expect(html).toContain('GUM');
    expect(html).toContain('—');
    expect(html).not.toMatch(/0\.0%/);
  });
  it('states that demand pressure is not unmet demand', () => {
    const html = renderToStaticMarkup(<ArtifactView artifact={ok('analyze_demand_pressure', { airport: 'SFO', peerGroup: { size: 43, definition: 'big airports' }, indicators: [{ id: 'loadFactor12m', label: 'Load factor', value: 81.7, peerPercentile: 83.7, standsOut: true, suggests: 's', doesNotShow: 'd' }], monthlyLoadFactor: [] })} />);
    expect(html).toContain('Not unmet demand');
    expect(html).toContain('81.7%');
    expect(html).toContain('high vs peers');
  });
  it('shows weak on-time coverage on a comparison', () => {
    const html = renderToStaticMarkup(<ArtifactView artifact={ok('compare_operations', { airports: [{ code: 'GUM', operations: { reliable: false, notes: ['covers only 18%'], derived: {}, coverage: { ratio: 0.18 } }, airfield: {} }], comparisons: [] })} />);
    expect(html).toContain('weak data');
    expect(html).toContain('18%');
  });
  it('reports a failed tool call plainly and does not crash on an unknown tool', () => {
    const failed: Artifact = { id: 'x', tool: 'get_traffic_metrics', args: {}, output: { ok: false, tool: 'get_traffic_metrics', error: { code: 'provider_error', message: 'bts-socrata: timed out' } } };
    expect(renderToStaticMarkup(<ArtifactView artifact={failed} />)).toContain('did not run: bts-socrata: timed out');
    expect(renderToStaticMarkup(<ArtifactView artifact={ok('brand_new_tool', { a: 1 })} />)).toContain('Show result');
  });
  it('renders the long-haul share with its definition and sensitivity', () => {
    const html = renderToStaticMarkup(<ArtifactView artifact={ok('get_long_haul_share', { origin: 'ANC', share: 0.045527, thresholdMiles: 3000, totalDepartures: 13794, longHaulDepartures: 628, classes: ['F'], basis: 'performed', sensitivity: [{ thresholdMiles: 1500, share: 0.255, longHaulDepartures: 3518 }, { thresholdMiles: 3000, share: 0.045527, longHaulDepartures: 628 }], distanceBands: [], classSensitivity: [{ label: 'Scheduled passenger/cargo service only (class F)', classes: ['F'], totalDepartures: 13794, longHaulDepartures: 628, share: 0.045527 }, { label: 'All service classes', classes: ['F', 'G', 'L', 'P'], totalDepartures: 26730, longHaulDepartures: 6662, share: 0.2492 }] })} />);
    expect(html).toContain('4.6%');
    expect(html).toContain('6,662 of 26,730 departures');
    expect(html).toContain('24.9%');
    expect(html).toContain('13,794');
    expect(html).toContain('1,500+ miles');
    expect(html).toContain('no standard definition');
  });
});
