'use client';

import { Fragment, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardNote } from '@/components/ui/card';
import { METRIC_ORDER, METRIC_SHORT } from '@/constants/metrics';
import type { ToolSuccess } from '@/types';
import { DASH, compact, fracPct, int, monthLabel, num, pct, signed } from '@/utils/format';
import { MetricLegend, ScoreStackChart, type ScoreRow } from './charts';
import { AirportName, DataTable, Disclosure, Facts, NUM } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const metricValue = (id: string, raw: number | undefined): string => {
  if (raw === undefined) return DASH;
  switch (id) {
    case 'scale': return `${int(raw)} passengers`;
    case 'momentum': return `${signed(raw, 1, '%')} (adjusted)`;
    case 'capacityGap': return `${signed(raw, 1)} pts (adjusted)`;
    case 'runwayLoad': return `${num(raw, 0)} per runway/day`;
    case 'taxiOut': return `${num(raw, 0)} min`;
    default: return pct(raw);
  }
};

/** The opportunity ranking: a stacked-bar view of every score, then a table where each airport opens into its per-metric breakdown. */
export function RankingCard({ o }: { o: ToolSuccess }) {
  const rk = o.data.ranking;
  const ranked: any[] = rk.ranked ?? [];
  const [open, setOpen] = useState<string | null>(ranked[0]?.code ?? null);
  const active = METRIC_ORDER.filter((m) => (rk.weights?.[m] ?? 0) > 0);
  const cs = rk.candidateSet ?? {};
  const w = rk.periods?.passengerWindow;
  const ops: string[] = rk.periods?.operationalMonths ?? [];
  const chartRows: ScoreRow[] = ranked.map((a) => ({ code: a.code, score: a.score, points: Object.fromEntries(a.contributions.map((c: any) => [c.metric, c.points])), imputed: a.contributions.filter((c: any) => c.imputed).map((c: any) => c.metric) }));

  return (
    <Card>
      <CardHeader
        title="Expansion screening ranking"
        subtitle={<>{o.data.scope} · passengers {w ? `${monthLabel(w.from)} to ${monthLabel(w.to)}` : DASH} · operations {ops.length ? `${monthLabel(ops[0] as string)} to ${monthLabel(ops.at(-1) as string)}` : DASH}</>}
        badge={<Badge tone="info" title="Scores are percentile positions relative to the airports in this list. They are not forecasts of profit or evidence that a terminal is capacity-constrained.">Relative score, not ROI</Badge>}
      />
      <p className="text-[12.5px] text-muted-foreground">
        {cs.scored} ranked · {cs.unscored} not scored · {cs.excluded} below the passenger threshold. Each bar splits an airport's 0–100 score by metric.
      </p>
      <MetricLegend metrics={[...active]} />
      <ScoreStackChart rows={chartRows} metrics={[...active]} />

      <div className="mt-3">
        <DataTable>
          <thead>
            <tr><th>#</th><th>Airport</th><th className={NUM}>Score</th><th className={NUM}>Passengers</th><th className={NUM}>Growth</th><th className={NUM}>Load factor</th><th>Data</th><th /></tr>
          </thead>
          <tbody>
            {ranked.map((a) => {
              const isOpen = open === a.code;
              const partial = a.coverage?.weightCoverage < 1;
              return (
                <Fragment key={a.code}>
                  <tr className={isOpen ? 'bg-muted/60' : ''}>
                    <td className="w-8 text-muted-foreground">{a.rank}</td>
                    <td><AirportName a={a} /></td>
                    <td className={`${NUM} font-semibold`}>{a.score.toFixed(1)}</td>
                    <td className={NUM}>{compact(a.evidence?.passengersLatest12m)}</td>
                    <td className={NUM}>{a.evidence?.passengerGrowthPct === undefined ? DASH : signed(a.evidence.passengerGrowthPct, 1, '%')}</td>
                    <td className={NUM}>{pct(a.evidence?.loadFactorPct)}</td>
                    <td>{partial || a.flags?.length ? <Badge tone="warn" title={[...(a.flags ?? [])].join('; ') || 'Some metrics are missing'}>▲ {partial ? 'partial' : 'note'}</Badge> : <span className="text-muted-foreground">complete</span>}</td>
                    <td><Button variant="link" size="sm" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.code)}>{isOpen ? 'Hide' : 'Why'}</Button></td>
                  </tr>
                  {isOpen ? (
                    <tr className="bg-muted/60">
                      <td colSpan={8} className="!px-3 !pb-3">
                        <DataTable className="text-[12.5px]">
                          <thead><tr><th>Metric</th><th>Value</th><th className={NUM}>Percentile</th><th className={NUM}>Weight used</th><th className={NUM}>Points</th></tr></thead>
                          <tbody>
                            {a.contributions.map((c: any) => (
                              <tr key={c.metric} className={c.imputed ? 'text-muted-foreground' : ''}>
                                <td>{METRIC_SHORT[c.metric] ?? c.label}</td>
                                <td>{c.imputed ? <em>missing: neutral 50th percentile used</em> : metricValue(c.metric, c.raw)}</td>
                                <td className={NUM}>{c.percentile.toFixed(0)}</td>
                                <td className={NUM} title={c.correlationFactor < 1 ? `Configured ${c.configuredWeight}, reduced to ${(c.correlationFactor * 100).toFixed(0)}% because it overlaps other metrics` : undefined}>{c.effectiveWeight.toFixed(1)}%{c.correlationFactor < 1 ? ' *' : ''}</td>
                                <td className={NUM}>{c.points.toFixed(1)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </DataTable>
                        <Facts>
                          <li>Rank would range {a.rankRange?.best}–{a.rankRange?.worst} under equal weights or if any one metric were dropped.</li>
                          {a.scoreBounds && a.scoreBounds.high - a.scoreBounds.low > 0.05 ? <li>Because some data is missing, the score could be anywhere from {a.scoreBounds.low.toFixed(1)} to {a.scoreBounds.high.toFixed(1)}.</li> : null}
                          <li>Departures per runway/day: {num(a.evidence?.departuresPerRunwayDay, 0)} · median taxi-out: {a.evidence?.medianTaxiOutMin === undefined ? DASH : `${num(a.evidence.medianTaxiOutMin, 0)} min`} · delayed 15+ min: {pct(a.evidence?.departureDelayRatePct)} · on-time data coverage: {fracPct(a.coverage?.onTimeCoverage, 0)}</li>
                          {a.contributions.some((c: any) => c.correlationFactor < 1) ? <li className="text-muted-foreground">* Weight reduced because this metric moves together with others, so the same signal is not counted twice.</li> : null}
                          {(a.flags ?? []).map((f: string) => <li key={f} className="text-warning">{f}</li>)}
                          {(a.coverage?.missing ?? []).map((m: any) => <li key={m.metric} className="text-warning">Missing {METRIC_SHORT[m.metric] ?? m.metric}: {m.reason}</li>)}
                        </Facts>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </DataTable>
      </div>

      <Disclosure summary="How to read this, weights and what was left out">
        <Facts>
          {(rk.readingGuide ?? []).map((g: string) => <li key={g}>{g}</li>)}
          <li>Weights (before overlap adjustment): {Object.entries(rk.weights ?? {}).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${METRIC_SHORT[k] ?? k} ${v}`).join(', ')}. Missing data policy: {rk.missingDataPolicy}.</li>
          {(rk.correlationAdjustments ?? []).map((c: any) => <li key={c.metric}>{c.explanation}</li>)}
          {rk.diagnostics?.rankStabilityVsEqualWeights !== undefined ? <li>Rank agreement with an equal-weights ranking: {rk.diagnostics.rankStabilityVsEqualWeights} (1 = identical order).</li> : null}
          {(rk.unscored ?? []).length ? <li>Not scored: {rk.unscored.map((u: any) => `${u.code} (${u.reason})`).join('; ')}</li> : null}
          {(rk.excluded ?? []).length ? <li>Below threshold or too little activity, not ranked: {rk.excluded.slice(0, 12).map((x: any) => x.code).join(', ')}{rk.excluded.length > 12 ? ` and ${rk.excluded.length - 12} more` : ''}.</li> : null}
        </Facts>
      </Disclosure>
      <CardNote>Scores rank airports against each other in this list. They are not profitability, a forecast, or proof that a terminal is constrained.</CardNote>
    </Card>
  );
}
