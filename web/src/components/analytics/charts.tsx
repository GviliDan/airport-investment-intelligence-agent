'use client';

import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { METRIC_ORDER, METRIC_SHORT, metricColor } from '@/constants/metrics';
import { DASH } from '@/utils/format';

/** Tooltip card shared by all charts. */
function ChartTip({ active, label, rows }: { active?: boolean; label?: ReactNode; rows: Array<{ name: string; value: string; color?: string }> }) {
  if (!active || rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-md">
      {label ? <p className="mb-1 font-medium">{label}</p> : null}
      {rows.map((r) => (
        <p key={r.name} className="flex items-center gap-2 text-muted-foreground">
          {r.color ? <span className="h-2 w-2 rounded-sm" style={{ background: r.color }} /> : null}
          {r.name}: <span className="tnum font-medium text-foreground">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export function MetricLegend({ metrics }: { metrics: string[] }) {
  return (
    <ul className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground" aria-label="Score components">
      {metrics.map((m) => (
        <li key={m} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: metricColor(m) }} />
          {METRIC_SHORT[m] ?? m}
        </li>
      ))}
    </ul>
  );
}

export interface ScoreRow {
  code: string;
  score: number;
  /** points per metric id (imputed metrics are flagged in `imputed`) */
  points: Record<string, number>;
  imputed: string[];
}

/** Opportunity scores as stacked horizontal bars: each segment is one metric's contribution to the 0-100 score. */
export function ScoreStackChart({ rows, metrics }: { rows: ScoreRow[]; metrics: string[] }) {
  const data = rows.map((r) => ({ code: r.code, score: r.score, imputed: r.imputed, ...r.points }));
  const height = Math.max(120, rows.length * 34 + 30);
  const ordered = METRIC_ORDER.filter((m) => metrics.includes(m));
  return (
    <div style={{ height }} role="img" aria-label="Stacked bars: each airport's score split by metric">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ left: 4, right: 16, top: 4, bottom: 4 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} />
          <XAxis type="number" domain={[0, 100]} tickCount={6} />
          <YAxis type="category" dataKey="code" width={44} tick={{ fontWeight: 600 }} />
          <Tooltip
            cursor={{ fill: 'var(--muted)', opacity: 0.5 }}
            content={({ active, payload, label }) => (
              <ChartTip
                active={active}
                label={`${String(label)} · score ${(payload?.[0]?.payload as { score: number } | undefined)?.score.toFixed(1) ?? ''}`}
                rows={(payload ?? []).map((p) => ({ name: METRIC_SHORT[String(p.dataKey)] ?? String(p.dataKey), value: `${Number(p.value).toFixed(1)} pts${(p.payload as { imputed: string[] }).imputed.includes(String(p.dataKey)) ? ' (missing data, neutral value)' : ''}`, color: metricColor(String(p.dataKey)) }))}
              />
            )}
          />
          {ordered.map((m, i) => (
            <Bar key={m} dataKey={m} stackId="score" fill={metricColor(m)} stroke="var(--card)" strokeWidth={1.5} isAnimationActive={false} radius={i === ordered.length - 1 ? [0, 4, 4, 0] : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface BarDatum {
  label: string;
  value: number | undefined;
  text: string;
  /** Highlighted bars use the primary series colour; others are muted. */
  highlight?: boolean;
  note?: string;
}

/** One series of horizontal bars with the value written at the end of each bar. */
export function BarsChart({ data, ariaLabel, max }: { data: BarDatum[]; ariaLabel: string; max?: number }) {
  const rows = data.map((d) => ({ ...d, v: d.value ?? 0 }));
  const top = max ?? Math.max(0.0001, ...rows.map((r) => r.v));
  return (
    <div style={{ height: rows.length * 30 + 12 }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 64, top: 2, bottom: 2 }} barCategoryGap={5}>
          <XAxis type="number" hide domain={[0, top]} />
          <YAxis type="category" dataKey="label" width={104} axisLine={false} tickLine={false} />
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.5 }} content={({ active, payload }) => <ChartTip active={active} rows={payload?.[0] ? [{ name: String((payload[0].payload as BarDatum).label), value: `${(payload[0].payload as BarDatum).text}${(payload[0].payload as BarDatum).note ? ` · ${(payload[0].payload as BarDatum).note}` : ''}` }] : []} />} />
          <Bar dataKey="v" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {rows.map((r) => (
              <Cell key={r.label} fill={r.highlight === false ? 'var(--muted-foreground)' : 'var(--chart-1)'} fillOpacity={r.highlight === false ? 0.45 : 1} />
            ))}
            <LabelList dataKey="text" position="right" fill="var(--foreground)" fontSize={12} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <ul className="sr-only">{rows.map((r) => <li key={r.label}>{r.label}: {r.text}</li>)}</ul>
    </div>
  );
}

export interface Point {
  x: string;
  y: number | undefined;
}

/** A single-series line over months. A month without data is a gap, never a zero. */
export function MonthlyLineChart({ points, format, label }: { points: Point[]; format: (n: number) => string; label: string }) {
  if (points.filter((p) => p.y !== undefined).length < 2) return <p className="text-sm text-muted-foreground">Not enough monthly data to draw a trend.</p>;
  return (
    <div className="h-44" role="img" aria-label={`${label} by month`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ left: 0, right: 12, top: 8, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="x" interval="preserveStartEnd" minTickGap={28} />
          <YAxis width={44} domain={['auto', 'auto']} tickFormatter={format} />
          <Tooltip content={({ active, payload, label: l }) => <ChartTip active={active} label={String(l)} rows={payload?.[0]?.value === undefined ? [] : [{ name: label, value: format(Number(payload[0].value)), color: 'var(--chart-1)' }]} />} />
          <Line type="monotone" dataKey="y" stroke="var(--chart-1)" strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: 'var(--card)' }} activeDot={{ r: 5 }} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 0-100 position among peers, drawn as a dot on a track. Undefined means too few peers to say. */
export function PercentileTrack({ value }: { value: number | undefined }) {
  if (value === undefined) return <span className="text-muted-foreground" title="Too few peers had this value to place it">{DASH}</span>;
  const v = Math.min(100, Math.max(0, value));
  return (
    <span className="inline-flex w-36 items-center gap-3" role="img" aria-label={`${value.toFixed(0)}th percentile among peers`} title={`${value.toFixed(0)}th percentile among peers`}>
      <span className="relative h-1 flex-1 rounded-full bg-muted">
        <span className="absolute -top-[5px] h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-card bg-[var(--chart-1)] ring-1 ring-[var(--chart-1)]" style={{ left: `${v}%` }} />
      </span>
      <span className="tnum w-6 text-right text-xs">{value.toFixed(0)}</span>
    </span>
  );
}
