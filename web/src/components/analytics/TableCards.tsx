import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardNote } from '@/components/ui/card';
import type { ToolSuccess } from '@/types';
import { DASH, compact, fracPct, int, num, pct, signed } from '@/utils/format';
import { AirportName, DataTable, Facts, Kpis, NUM, PageNote, periodsLine } from './shared';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Airport screen: one row per airport with the metrics a screen can filter and sort on. A dash means unavailable, not zero. */
export function ScreenCard({ o }: { o: ToolSuccess }) {
  const rows: any[] = o.data.rows ?? [];
  const max = Math.max(1, ...rows.map((r) => r.passengers12m ?? 0));
  const miss = o.data.airportsMissingAFilteredOrSortedMetric;
  return (
    <Card>
      <CardHeader title="Airport screen" subtitle={`${o.data.scope} · ${periodsLine(o)}`} />
      <DataTable>
        <thead>
          <tr><th>Airport</th><th>Passengers (12 mo)</th><th className={NUM}>Growth</th><th className={NUM}>Load factor</th><th className={NUM}>Dep./runway/day</th><th className={NUM}>Taxi-out</th><th className={NUM}>Delayed 15+</th><th className={NUM}>Intl. share</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.code}>
              <td><AirportName a={r} /></td>
              <td>
                <span className="flex min-w-36 items-center gap-2">
                  <span className="h-2 flex-1 overflow-hidden rounded bg-muted"><span className="block h-full rounded-r bg-[var(--chart-1)]" style={{ width: `${r.passengers12m === undefined ? 0 : (r.passengers12m / max) * 100}%` }} /></span>
                  <span className="tnum w-12 text-right text-xs">{compact(r.passengers12m)}</span>
                </span>
              </td>
              <td className={NUM}>{r.passengerGrowthPct === undefined ? DASH : signed(r.passengerGrowthPct, 1, '%')}</td>
              <td className={NUM}>{pct(r.loadFactorPct)}</td>
              <td className={NUM}>{num(r.departuresPerRunwayDay, 0)}</td>
              <td className={NUM}>{r.medianTaxiOutMin === undefined ? DASH : `${num(r.medianTaxiOutMin, 0)} min`}</td>
              <td className={NUM}>{pct(r.departureDelayRatePct)}</td>
              <td className={NUM}>{pct(r.internationalDepartureSharePct)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      <PageNote o={o} />
      {miss?.count ? <CardNote>{miss.count} airports were skipped because a filtered or sorted metric was missing for them (for example no on-time data).</CardNote> : null}
      <CardNote>A dash means the figure is not available (not zero). Operational columns are blank where on-time data covers under half of scheduled passenger flights.</CardNote>
    </Card>
  );
}

export function TrafficCard({ o }: { o: ToolSuccess }) {
  const rows: any[] = o.data.airports ?? [];
  return (
    <Card>
      <CardHeader title="Passenger and seat trends" subtitle={periodsLine(o)} />
      <DataTable>
        <thead><tr><th>Airport</th><th className={NUM}>Passengers</th><th className={NUM}>Change</th><th className={NUM}>Seats change</th><th className={NUM}>Load factor</th><th className={NUM}>Demand vs seats</th><th className={NUM}>Departures change</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.airport}>
              <td><strong>{t.airport}</strong></td>
              <td className={NUM}>{int(t.current?.passengers)}</td>
              <td className={NUM}>{t.passengers?.pct === undefined ? DASH : signed(t.passengers.pct * 100, 1, '%')}</td>
              <td className={NUM}>{t.seats?.pct === undefined ? DASH : signed(t.seats.pct * 100, 1, '%')}</td>
              <td className={NUM}>{fracPct(t.loadFactor?.current)}{t.loadFactor?.changePoints === undefined ? '' : ` (${signed(t.loadFactor.changePoints, 1, ' pts')})`}</td>
              <td className={NUM}>{t.passengerVsSeatGrowthPoints === undefined ? DASH : signed(t.passengerVsSeatGrowthPoints, 1, ' pts')}</td>
              <td className={NUM}>{t.departures?.pct === undefined ? DASH : signed(t.departures.pct * 100, 1, '%')}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
      {rows.filter((t) => t.issues?.length).map((t) => <CardNote key={t.airport} className="text-warning">{t.airport}: {t.issues.join('; ')}</CardNote>)}
      <CardNote>Change is against the same months a year earlier unless stated. "Demand vs seats" is passenger growth minus seat growth. Load factor measures aircraft fullness, not congestion.</CardNote>
    </Card>
  );
}

export const routeRows = (rows: any[]) => (
  <DataTable>
    <thead><tr><th>Route</th><th className={NUM}>Distance</th><th className={NUM}>Departures</th><th className={NUM}>Seats</th><th className={NUM}>Passengers</th><th className={NUM}>Load factor</th></tr></thead>
    <tbody>
      {rows.map((r) => (
        <tr key={`${r.origin}-${r.dest}`}>
          <td><strong>{r.origin}</strong> → <strong>{r.dest}</strong>{r.destCountry && r.destCountry !== 'US' ? <span className="text-muted-foreground"> {r.destCountry}</span> : null}</td>
          <td className={NUM}>{int(r.distanceMiles)} mi</td>
          <td className={NUM}>{int(r.departures)}</td>
          <td className={NUM}>{compact(r.seats)}</td>
          <td className={NUM}>{compact(r.passengers)}</td>
          <td className={NUM}>{fracPct(r.loadFactor)}</td>
        </tr>
      ))}
    </tbody>
  </DataTable>
);

export function NetworkCard({ o }: { o: ToolSuccess }) {
  const d = o.data;
  return (
    <Card>
      <CardHeader title={`Route network: ${d.origin}`} subtitle={periodsLine(o)} />
      <Kpis>
        <span><strong>{int(d.destinations)}</strong> nonstop destinations</span>
        <span><strong>{int(d.internationalDestinations)}</strong> international</span>
        <span><strong>{int(d.departures)}</strong> departures</span>
        <span><strong>{fracPct(d.internationalDepartureShare)}</strong> international share</span>
      </Kpis>
      {routeRows(d.topRoutes ?? [])}
    </Card>
  );
}

export function RoutesCard({ o }: { o: ToolSuccess }) {
  return (
    <Card>
      <CardHeader title="Routes" subtitle={periodsLine(o)} />
      {routeRows(o.data.routes ?? [])}
      <PageNote o={o} />
    </Card>
  );
}

export function InfrastructureCard({ o }: { o: ToolSuccess }) {
  return (
    <Card>
      <CardHeader title="Infrastructure" subtitle={periodsLine(o)} />
      {(o.data.airports ?? []).map((a: any) => (
        <div key={a.code} className="border-t border-border pt-3 first:border-t-0 first:pt-0 [&:not(:first-of-type)]:mt-3">
          <h4 className="text-sm font-semibold">
            <AirportName a={a} /> {a.faaMatched ? null : <Badge tone="warn" title={a.faaIssue}>no FAA match</Badge>}
          </h4>
          <Kpis>
            <span><strong>{int(a.commercialRunways)}</strong> commercial runways</span>
            <span>longest <strong>{a.longestRunwayFt ? `${int(a.longestRunwayFt)} ft` : DASH}</strong></span>
            <span><strong>{num(a.departuresPerCommercialRunwayPerDay, 0)}</strong> departures/runway/day</span>
            <span>tower <strong>{a.towerType ?? DASH}</strong></span>
          </Kpis>
          {a.runways?.length ? (
            <DataTable className="text-[12.5px]">
              <thead><tr><th>Runway</th><th className={NUM}>Length</th><th className={NUM}>Width</th><th>Surface</th></tr></thead>
              <tbody>{a.runways.map((r: any) => <tr key={r.id}><td>{r.id}</td><td className={NUM}>{r.lengthFt ? `${int(r.lengthFt)} ft` : DASH}</td><td className={NUM}>{r.widthFt ? `${int(r.widthFt)} ft` : DASH}</td><td>{r.surface ?? DASH}</td></tr>)}</tbody>
            </DataTable>
          ) : <p className="text-sm text-muted-foreground">No runway data.</p>}
        </div>
      ))}
      <CardNote>Terminal size, gates and passenger-processing capacity are not available from these sources.</CardNote>
    </Card>
  );
}

export function AirportsCard({ o }: { o: ToolSuccess }) {
  const rows: any[] = o.data.airports ?? [];
  return (
    <Card>
      <CardHeader title="Airports in scope" subtitle={o.data.scope} />
      <DataTable>
        <thead><tr><th>Airport</th><th>City</th><th>Scheduled service</th><th>FAA data</th></tr></thead>
        <tbody>{rows.map((a) => <tr key={a.code}><td><AirportName a={a} /></td><td>{a.city ?? DASH}</td><td>{a.scheduledService === undefined ? DASH : a.scheduledService ? 'yes' : 'no'}</td><td>{a.faaMatched ? 'matched' : <Badge tone="warn">no FAA match</Badge>}</td></tr>)}</tbody>
      </DataTable>
      <PageNote o={o} />
    </Card>
  );
}

export function ResolveCard({ o }: { o: ToolSuccess }) {
  const d = o.data;
  return (
    <Card>
      <CardHeader title="Airport lookup" subtitle={d.status === 'found' ? `Matched by ${d.matchedBy}` : d.reason} />
      {d.status === 'found' ? <AirportName a={d.airport} /> : null}
      {d.status === 'ambiguous' ? <Facts>{d.candidates.map((c: any) => <li key={c.code}><AirportName a={c} /> <span className="text-muted-foreground">· {c.city}</span></li>)}</Facts> : null}
    </Card>
  );
}

export function DisruptionsCard({ o }: { o: ToolSuccess }) {
  const events: any[] = o.data.events ?? [];
  return (
    <Card>
      <CardHeader title="Current FAA disruptions" subtitle={`Live · ${o.periods.current ?? ''}${o.data.faaUpdateTime ? ` · FAA update ${o.data.faaUpdateTime}` : ''}`} badge={<Badge tone="info">Live, not historical</Badge>} />
      {events.length === 0 ? <p className="text-sm">No disruptions reported by the FAA right now.</p> : (
        <Facts>
          {events.map((e, i) => (
            <li key={i}>
              <strong>{e.airport}</strong> · {String(e.kind).replaceAll('-', ' ')}{e.reason ? ` — ${e.reason}` : ''}{e.detail?.Avg ? ` (average ${e.detail.Avg}, maximum ${e.detail.Max ?? DASH})` : ''}
              {e.interpretation ? <span className="text-muted-foreground"> {e.interpretation}</span> : null}
            </li>
          ))}
        </Facts>
      )}
      {o.data.noEventsReportedFor?.length ? <CardNote>No events reported for: {o.data.noEventsReportedFor.join(', ')}. That does not mean operations are normal.</CardNote> : null}
      <PageNote o={o} />
    </Card>
  );
}

export function MethodologyCard({ o }: { o: ToolSuccess }) {
  const d = o.data;
  return (
    <Card>
      <CardHeader title="Methodology" />
      {d.metrics ? <Facts>{d.metrics.map((m: any) => <li key={m.id}><strong>{m.label}</strong> (weight {m.defaultWeight}): {m.why} <span className="text-muted-foreground">{m.caveat}</span></li>)}</Facts> : null}
      {d.opportunityScore ? <Facts>{d.opportunityScore.method.map((m: string) => <li key={m}>{m}</li>)}</Facts> : null}
    </Card>
  );
}
