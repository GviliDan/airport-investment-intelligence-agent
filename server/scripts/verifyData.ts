/** Prints a verification report over the committed processed datasets: coverage, cross-dataset consistency and spot checks. */
import { deriveOnTime, sumOnTime } from '../src/data/aggregate.js';
import { loadDataStore } from '../src/data/store.js';

const store = await loadDataStore();
const pct = (v: number | undefined): string => (v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);
const num = (v: number | undefined, d = 1): string => (v === undefined ? 'n/a' : v.toFixed(d));

console.log('aligned months:', store.alignedMonths.join(', '));
console.log('airports:', store.airportsFile.summary, 'FAA effective', store.airportsFile.faaEffectiveDate);
console.log('traffic rows', store.traffic.length, 'segments rows', store.segments.length, 'ontime rows', store.onTime.length);

// 1. Cross-dataset: T-100 summary departures vs sum of segment performed departures (same source family, should agree).
let compared = 0;
let worst = { airport: '', month: '', diffPct: 0 };
const segDeps = new Map<string, number>();
for (const s of store.segments) segDeps.set(`${s.origin}|${s.month}`, (segDeps.get(`${s.origin}|${s.month}`) ?? 0) + s.depsPerformed);
for (const t of store.traffic) {
  if (!store.alignedMonths.includes(t.month) || !t.departures || t.departures < 500) continue;
  const seg = segDeps.get(`${t.airport}|${t.month}`);
  if (seg === undefined) continue;
  compared += 1;
  const diffPct = Math.abs(seg - t.departures) / t.departures;
  if (diffPct > worst.diffPct) worst = { airport: t.airport, month: t.month, diffPct };
}
console.log(`\nsegment vs summary departures: ${compared} airport-months compared, worst gap ${worst.airport} ${worst.month} ${pct(worst.diffPct)}`);

// 2. Spot checks across regions.
const sample = ['BOS', 'BTV', 'JFK', 'ATL', 'MIA', 'DEN', 'ABQ', 'PDX', 'BOI', 'MSP', 'LAX', 'SNA', 'SFO', 'ANC', 'HNL', 'SJU'];
console.log('\nairport  state  pax(last12)  OT flights(3mo)  dep>=15m  cancel  medTaxiOut  runways  coords  FAA');
for (const code of sample) {
  const a = store.airports.get(code);
  const pax = (store.trafficByAirport.get(code) ?? []).filter((r) => r.month > '2025-08').reduce((s, r) => s + (r.passengers ?? 0), 0);
  const ot = deriveOnTime(sumOnTime(store.onTimeByAirport.get(code) ?? []));
  console.log(
    `${code.padEnd(8)} ${(a?.state ?? '?').padEnd(6)} ${String(pax).padStart(11)}  ${String(ot.scheduledDepartures).padStart(14)}  ${pct(ot.departureDelayRate15).padStart(8)}  ${pct(ot.cancellationRate).padStart(6)}  ${num(ot.medianTaxiOutMin).padStart(10)}  ${String(a?.runways.length ?? '?').padStart(7)}  ${a?.lat !== undefined ? 'yes' : 'NO '}     ${a?.faaMatched ? 'yes' : 'NO'}`,
  );
}

// 3. Long-haul share example (distance >= 3000 mi, scheduled passenger service, performed departures), by month.
for (const code of ['ANC', 'HNL', 'SFO']) {
  const rows = store.segments.filter((s) => s.origin === code && s.cls === 'F' && store.alignedMonths.includes(s.month));
  const total = rows.reduce((s, r) => s + r.depsPerformed, 0);
  const long = rows.filter((r) => r.distance >= 3000).reduce((s, r) => s + r.depsPerformed, 0);
  console.log(`${code} scheduled-passenger departures ${total}, >=3000 mi ${long} (${pct(total ? long / total : undefined)}) over ${store.alignedMonths.length} months`);
}

// 4. On-time coverage versus T-100 scheduled passenger departures (reporting carriers only).
const cov: Array<[string, number]> = [];
for (const code of sample) {
  const segF = store.segments.filter((s) => s.origin === code && s.cls === 'F').reduce((s, r) => s + r.depsPerformed, 0);
  const ot = sumOnTime(store.onTimeByAirport.get(code) ?? []).dep.scheduled;
  if (segF > 0) cov.push([code, ot / segF]);
}
console.log('\nOn-time flights as share of T-100 scheduled-passenger departures:', cov.map(([c, r]) => `${c} ${pct(r)}`).join(', '));

// 5. Resolution checks.
for (const q of ['Santa Ana', 'LA', 'Los Angeles', 'New York', 'Washington', 'Portland', 'Kodiak', 'logan', 'KSFO', 'Gotham']) {
  const r = store.airports.resolve(q);
  console.log(`resolve("${q}") ->`, r.status === 'found' ? `${r.airport.code} via ${r.matchedBy}` : r.status === 'ambiguous' ? `ambiguous: ${r.candidates.map((c) => c.code).join(',')}` : `not_found (${r.reason})`);
}
