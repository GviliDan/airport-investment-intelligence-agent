/**
 * Builds the lightweight processed datasets in data/processed/ from BTS and FAA sources.
 *
 *   npm run data:build -- --months 2026-06,2026-07,2026-08 [--only segments,ontime,traffic,airports,manifest]
 *
 * Needs data/raw/segment_YYYY-MM.zip and data/raw/ontime_YYYY-MM.zip (see `npm run data:download`) for the
 * segments and ontime steps, and network access for the traffic and airports steps. Output is deterministic
 * for the same inputs apart from the retrievedAt timestamps.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OnTimeAggregator, SegmentAggregator, type AirportIdentity, type OnTimeAirportMonth, type SegmentRecord } from '../src/data/aggregate.js';
import { BtsSocrataClient, type MonthlyTraffic } from '../src/data/btsSocrata.js';
import { csvRows, openFirstZipEntry } from '../src/data/csv.js';
import { FaaArcgisClient } from '../src/data/faaArcgis.js';
import { PROCESSED_DIR, RAW_DIR, readGzipCsv, readGzipJson, writeGzipCsv, writeGzipJson, writeJson } from '../src/data/files.js';
import { buildAirports } from '../src/data/airportBuild.js';
import { monthRange, shiftMonth } from '../src/data/types.js';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const months = (opt('months') ?? '2026-06,2026-07,2026-08').split(',').map((m) => m.trim()).sort();
const only = new Set((opt('only') ?? 'segments,ontime,traffic,airports,manifest').split(','));
const file = (name: string): string => resolve(PROCESSED_DIR, name);
const workFile = (name: string): string => resolve(RAW_DIR, 'work', name);
const log = (m: string): void => console.log(`[data:build] ${m}`);

export const SEGMENT_COLUMNS = ['month', 'origin', 'dest', 'cls', 'distance', 'depsScheduled', 'depsPerformed', 'seats', 'passengers', 'freightLbs', 'mailLbs', 'originCountry', 'destCountry'] as const;
export const TRAFFIC_COLUMNS = ['airport', 'month', 'airportName', 'cityName', 'departures', 'passengers', 'seats', 'loadFactorPct', 'freightLbs', 'mailLbs', 'domesticDepartures', 'internationalDepartures'] as const;

async function buildSegments(): Promise<void> {
  const all: SegmentRecord[] = [];
  const identities = new Map<string, AirportIdentity>();
  const stats: Record<string, unknown> = {};
  for (const month of months) {
    const agg = new SegmentAggregator(month);
    for await (const row of csvRows(await openFirstZipEntry(resolve(RAW_DIR, `segment_${month}.zip`)))) agg.add(row);
    all.push(...agg.records());
    for (const id of agg.airports()) {
      const prev = identities.get(id.code);
      identities.set(id.code, { ...prev, ...id, btsIds: [...new Set([...(prev?.btsIds ?? []), ...id.btsIds])].sort() });
    }
    stats[month] = agg.stats;
    log(`segments ${month}: ${JSON.stringify(agg.stats)}`);
  }
  await writeGzipCsv(file('route-segments.csv.gz'), SEGMENT_COLUMNS, all);
  await writeGzipJson(workFile('segment-airports.json.gz'), { airports: [...identities.values()], stats });
}

async function buildOnTime(): Promise<void> {
  const all: OnTimeAirportMonth[] = [];
  const stats: Record<string, unknown> = {};
  for (const month of months) {
    const agg = new OnTimeAggregator(month);
    for await (const row of csvRows(await openFirstZipEntry(resolve(RAW_DIR, `ontime_${month}.zip`)))) agg.add(row);
    all.push(...agg.records());
    stats[month] = agg.stats;
    log(`ontime ${month}: ${JSON.stringify(agg.stats)}`);
  }
  await writeGzipJson(file('ontime-airport-month.json.gz'), all);
  await writeGzipJson(workFile('ontime-stats.json.gz'), stats);
}

async function buildTraffic(): Promise<MonthlyTraffic[]> {
  const bts = new BtsSocrataClient({ timeoutMs: 60_000 });
  const end = months.at(-1) as string;
  // 36 months back from the last aligned month: enough for year-over-year comparisons of any aligned window.
  const result = await bts.monthlyTraffic({ from: shiftMonth(end, 35), to: end });
  const rows = result.data.slice().sort((a, b) => (a.airport + a.month).localeCompare(b.airport + b.month));
  await writeGzipCsv(file('traffic-monthly.csv.gz'), TRAFFIC_COLUMNS, rows);
  log(`traffic: ${rows.length} airport-months from ${shiftMonth(end, 35)} to ${end}`);
  return rows;
}

async function buildAirportsFile(): Promise<void> {
  const traffic = await readGzipCsv(file('traffic-monthly.csv.gz'));
  const work = (await readGzipJson(workFile('segment-airports.json.gz'))) as { airports: AirportIdentity[] };
  const result = await buildAirports({
    identities: work.airports,
    traffic: traffic.map((r) => ({ airport: r.airport as string, airportName: r.airportName || undefined, cityName: r.cityName || undefined })),
    faa: new FaaArcgisClient({ timeoutMs: 60_000 }),
  });
  await writeJson(file('airports.json'), result);
  log(`airports: ${result.airports.length} (matched to FAA ${result.summary.matchedToFaa}, unmatched ${result.summary.unmatched}, ambiguous codes ${result.summary.ambiguousCodes})`);
}

async function sha(path: string): Promise<{ bytes: number; sha256: string }> {
  const buf = await readFile(path);
  return { bytes: (await stat(path)).size, sha256: createHash('sha256').update(buf).digest('hex') };
}

async function buildManifest(): Promise<void> {
  const trafficRows = await readGzipCsv(file('traffic-monthly.csv.gz'));
  const segRows = await readGzipCsv(file('route-segments.csv.gz'));
  const onTime = (await readGzipJson(file('ontime-airport-month.json.gz'))) as OnTimeAirportMonth[];
  const work = (await readGzipJson(workFile('segment-airports.json.gz'))) as { stats: unknown };
  const otStats = (await readGzipJson(workFile('ontime-stats.json.gz'))) as unknown;
  const names = ['airports.json', 'traffic-monthly.csv.gz', 'route-segments.csv.gz', 'ontime-airport-month.json.gz'];
  const files: Record<string, unknown> = {};
  for (const n of names) files[n] = await sha(file(n));
  const trafficMonths = [...new Set(trafficRows.map((r) => r.month))].sort();
  const manifest = {
    generatedAt: new Date().toISOString(),
    alignedMonths: months,
    description: 'Processed, committed datasets. Raw BTS downloads are never committed; rebuild with npm run data:download and npm run data:build.',
    datasets: {
      'traffic-monthly': {
        source: 'BTS T-100 Segment Summary By Origin Airport (data.bts.gov r495-tyji, Socrata API)',
        period: { start: trafficMonths[0], end: trafficMonths.at(-1) },
        rows: trafficRows.length,
        airports: new Set(trafficRows.map((r) => r.airport)).size,
        note: 'All carriers, scheduled and non-scheduled, passengers and cargo; airports with no activity in a month have no row.',
      },
      'route-segments': {
        source: 'BTS T-100 Segment (All Carriers) via TranStats download form',
        period: { start: months[0], end: months.at(-1) },
        rows: segRows.length,
        buildStats: work.stats,
        note: 'Summed over carriers and aircraft type per month/origin/destination/service class. Inactive zero-activity rows dropped.',
      },
      'ontime-airport-month': {
        source: 'BTS Reporting Carrier On-Time Performance via TranStats download form',
        period: { start: months[0], end: months.at(-1) },
        rows: onTime.length,
        airports: new Set(onTime.map((r) => r.airport)).size,
        buildStats: otStats,
        note: 'Only carriers with at least 1% of US domestic scheduled passenger revenue report; cargo, small carriers and non-reporting operators are absent.',
      },
      airports: { source: 'FAA Aviation Facilities (NTAD ArcGIS) joined to BTS identities', file: 'airports.json' },
    },
    files,
  };
  await writeJson(file('manifest.json'), manifest);
  log(`manifest written for ${monthRange(months[0] as string, months.at(-1) as string).join(', ')}`);
}

const steps: Array<[string, () => Promise<unknown>]> = [
  ['segments', buildSegments],
  ['ontime', buildOnTime],
  ['traffic', buildTraffic],
  ['airports', buildAirportsFile],
  ['manifest', buildManifest],
];
for (const [name, run] of steps) if (only.has(name)) await run();
