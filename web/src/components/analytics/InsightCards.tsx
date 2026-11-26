'use client';

import type { ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardNote } from '@/components/ui/card';
import type { ToolSuccess } from '@/types';
import { DASH, fracPct, int, monthLabel, num, pct, signed } from '@/utils/format';
import { BarsChart, MonthlyLineChart, PercentileTrack } from './charts';
import { routeRows } from './TableCards';
import { DataTable, LiveStatus, NUM, Subhead, periodsLine } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

const VERDICT_TEXT = (v: string | undefined, a: string, b: string): string => (v === 'indistinguishable' || v === undefined ? 'no clear difference' : `${v === 'a-higher' ? a : b} higher`);

/** Two or more airports side by side: a rate chart for the headline measures, then the full table and the tool's own verdicts. */
export function OperationsCard({ o }: { o: ToolSuccess }) {
  const airports: any[] = o.data.airports ?? [];
  const cmp: any[] = o.data.comparisons ?? [];
  const chart = airports.map((a) => ({ code: a.code, delayed: (a.operations?.derived?.departureDelayRate15 ?? 0) * 100, cancelled: (a.operations?.derived?.cancellationRate ?? 0) * 100, weak: a.operations?.reliable === false }));
  const row = (label: string, f: (a: any) => ReactNode) => <tr><th scope="row" className="!font-normal !text-foreground">{label}</th>{airports.map((a) => <td key={a.code} className={NUM}>{f(a)}</td>)}</tr>;
  return (
    <Card>
      <CardHeader title="Operations comparison" subtitle={periodsLine(o)} />
      <div className="h-48" role="img" aria-label="Share of departures delayed 15+ minutes and cancelled, by airport">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chart} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} />
            <XAxis dataKey="code" />
            <YAxis width={40} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.5 }} formatter={(v) => `${Number(v).toFixed(1)}%`} contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
            <Legend iconType="square" itemSorter={null} wrapperStyle={{ fontSize: 12 }} />
            <Bar dataKey="delayed" name="Delayed 15+ min" fill="var(--chart-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="cancelled" name="Cancelled" fill="var(--chart-2)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-3">
        <DataTable>
          <thead><tr><th />{airports.map((a) => <th key={a.code} className={NUM}>{a.code}{a.operations?.reliable === false ? <Badge tone="warn" className="ml-1" title={(a.operations.notes ?? []).join(' ')}>▲ weak data</Badge> : null}</th>)}</tr></thead>
          <tbody>
            {row('Flights (reporting carriers)', (a) => int(a.operations?.scheduledDepartures))}
            {row('Departures delayed 15+ min', (a) => fracPct(a.operations?.derived?.departureDelayRate15))}
            {row('Cancelled', (a) => fracPct(a.operations?.derived?.cancellationRate))}
            {row('Median taxi-out', (a) => (a.operations?.derived?.medianTaxiOutMin === undefined ? DASH : `${num(a.operations.derived.medianTaxiOutMin, 0)} min`))}
            {row('Average departure delay', (a) => (a.operations?.derived?.meanDepartureDelayMin === undefined ? DASH : `${num(a.operations.derived.meanDepartureDelayMin, 1)} min`))}
            {row('Commercial runways', (a) => int(a.airfield?.commercialRunways))}
            {row('Departures per runway per day', (a) => num(a.airfield?.departuresPerCommercialRunwayPerDay, 0))}
            {row('On-time data coverage', (a) => fracPct(a.operations?.coverage?.ratio, 0))}
          </tbody>
        </DataTable>
      </div>
      {cmp.map((c) => (
        <CardNote key={`${c.a}-${c.b}`}>
          <strong className="text-foreground">{c.a} vs {c.b}:</strong> delayed 15+ min — {c.departureDelayRate15 ? `${fracPct(c.departureDelayRate15.rateA)} vs ${fracPct(c.departureDelayRate15.rateB)}, ${VERDICT_TEXT(c.departureDelayRate15.verdict, c.a, c.b)}` : DASH}; cancellations — {c.cancellationRate ? `${fracPct(c.cancellationRate.rateA, 2)} vs ${fracPct(c.cancellationRate.rateB, 2)}, ${VERDICT_TEXT(c.cancellationRate.verdict, c.a, c.b)}` : DASH}; median taxi-out gap {c.medianTaxiOutDifferenceMin === undefined ? DASH : `${signed(c.medianTaxiOutDifferenceMin, 0, ' min')} (${c.a} minus ${c.b})`}.
        </CardNote>
      ))}
      {airports.map((a) => <LiveStatus key={a.code} code={a.code} status={a.currentFaaStatus} />)}
      <CardNote>These are operations measures for airlines that report to BTS (June–August). Delays and taxi times reflect weather and airline operations as well as airport capacity and say nothing about terminal capacity. No single congestion score is computed.</CardNote>
    </Card>
  );
}

const CLASS_LABEL: Record<string, string> = { F: 'scheduled passenger/cargo', G: 'scheduled all-cargo', L: 'non-scheduled passenger/cargo', P: 'non-scheduled all-cargo' };

export function LongHaulCard({ o }: { o: ToolSuccess }) {
  const d = o.data;
  const sens = (d.sensitivity ?? []).map((s: any) => ({ label: `${int(s.thresholdMiles)}+ miles`, value: s.share, text: fracPct(s.share), highlight: s.thresholdMiles === d.thresholdMiles, note: `${int(s.longHaulDepartures)} departures` }));
  const bands = (d.distanceBands ?? []).map((b: any) => ({ label: b.label, value: b.share, text: `${fracPct(b.share)} · ${int(b.departures)}`, highlight: true }));
  return (
    <Card>
      <CardHeader title={`Long-haul share: ${d.origin}`} subtitle={`${periodsLine(o)} · ${(d.classes ?? []).map((c: string) => CLASS_LABEL[c] ?? c).join(', ')} · ${d.basis} departures`} />
      <p className="my-2 flex flex-wrap items-baseline gap-3">
        <strong className="text-4xl font-semibold tracking-tight">{d.share === undefined ? DASH : fracPct(d.share, 1)}</strong>
        <span className="text-muted-foreground">of {int(d.totalDepartures)} departures are on routes of {int(d.thresholdMiles)} miles or more ({int(d.longHaulDepartures)} departures)</span>
      </p>
      <Subhead>Share at other definitions of "long haul"</Subhead>
      <BarsChart data={sens} ariaLabel="Long-haul share at different distance thresholds" max={Math.max(0.0001, ...sens.map((s: any) => s.value ?? 0))} />
      {d.classSensitivity?.length ? (
        <>
          <Subhead>Share by service-class definition (same threshold and months)</Subhead>
          <ul className="mt-1 space-y-1 text-[13.5px]">
            {d.classSensitivity.map((c: any) => (
              <li key={c.label} className={JSON.stringify(c.classes) === JSON.stringify(d.classes) ? 'font-medium' : ''}>
                <strong>{fracPct(c.share, 1)}</strong> {c.label}: {int(c.longHaulDepartures)} of {int(c.totalDepartures)} departures
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Subhead>Departures by distance</Subhead>
      <BarsChart data={bands} ariaLabel="Departures by distance band" />
      {d.topLongHaulRoutes?.length ? <><Subhead>Busiest long-haul routes</Subhead>{routeRows(d.topLongHaulRoutes)}</> : null}
      <CardNote>"Long haul" has no standard definition; {int(d.thresholdMiles)} miles is a configurable assumption. Counts departures, not passengers.</CardNote>
    </Card>
  );
}

const INDICATOR_FORMAT: Record<string, (v: number) => string> = {
  loadFactor12m: (v) => pct(v), passengerGrowth: (v) => signed(v, 1, '%'), seatGrowth: (v) => signed(v, 1, '%'), passengerVsSeatGap: (v) => signed(v, 1, ' pts'),
  seatsPerDeparture: (v) => `${num(v, 0)} seats`, departuresPerRunwayDay: (v) => num(v, 0), medianTaxiOut: (v) => `${num(v, 0)} min`, departureDelayRate15: (v) => pct(v), cancellationRate: (v) => pct(v),
};

export function PressureCard({ o }: { o: ToolSuccess }) {
  const d = o.data;
  const pts = (d.monthlyLoadFactor ?? []).map((p: any) => ({ x: monthLabel(p.month), y: p.loadFactor === undefined ? undefined : p.loadFactor * 100 }));
  return (
    <Card>
      <CardHeader title={`Demand pressure indicators: ${d.airport}`} subtitle={`Compared with ${d.peerGroup?.size} peers: ${d.peerGroup?.definition}`} badge={<Badge tone="warn" title="Unmet demand cannot be measured with public data">▲ Not unmet demand</Badge>} />
      <p className="my-2 rounded-lg border border-warning/50 bg-warning-bg px-3 py-2 text-[13.5px]">
        Unmet demand (travelers who could not fly or were priced out) is not measurable with public data. These indicators show how tight existing capacity looks compared with similar airports; they do not show why.
      </p>
      <DataTable>
        <thead><tr><th>Indicator</th><th className={NUM}>Value</th><th>Position among peers (0–100)</th></tr></thead>
        <tbody>
          {(d.indicators ?? []).map((i: any) => (
            <tr key={i.id} className={i.standsOut ? 'font-medium' : ''}>
              <td title={`${i.suggests} It does not show: ${i.doesNotShow}`}>{i.label}{i.standsOut ? <Badge tone="info" className="ml-1.5">high vs peers</Badge> : null}</td>
              <td className={NUM}>{i.value === undefined ? DASH : (INDICATOR_FORMAT[i.id]?.(i.value) ?? num(i.value, 1))}</td>
              <td><PercentileTrack value={i.peerPercentile} /></td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <Subhead>Seat load factor by month</Subhead>
      <MonthlyLineChart points={pts} format={(n) => `${n.toFixed(0)}%`} label="Seat load factor" />
      <LiveStatus code={d.airport} status={d.currentFaaStatus} />
      <CardNote>Hover an indicator name for what it suggests and what it does not show. Delay and taxi measures cover June–August only.</CardNote>
    </Card>
  );
}

