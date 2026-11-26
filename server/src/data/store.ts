import { resolve } from 'node:path';
import { z } from 'zod';
import type { OnTimeAirportMonth, SegmentRecord } from './aggregate.js';
import type { AirportsFile } from './airportBuild.js';
import { AirportIndex } from './airportIndex.js';
import type { MonthlyTraffic } from './btsSocrata.js';
import { PROCESSED_DIR, readGzipCsv, readGzipJson, readJson } from './files.js';

const counts = z.number().nonnegative();
const hist = z.record(z.string(), counts);
const OnTimeSchema = z.array(
  z.object({
    airport: z.string(),
    month: z.string().regex(/^\d{4}-\d{2}$/),
    reportingCarriers: counts,
    dep: z.object({ scheduled: counts, cancelled: counts, cancelledByCode: hist, delayMeasured: counts, delayed15: counts, delayMinutes: counts, taxiOutN: counts, taxiOutSum: counts, taxiOutHist: hist }),
    arr: z.object({
      scheduled: counts, cancelled: counts, diverted: counts, delayMeasured: counts, delayed15: counts, delayMinutes: counts, taxiInN: counts, taxiInSum: counts, causeFlights: counts,
      causeMinutes: z.object({ carrier: counts, weather: counts, nas: counts, security: counts, lateAircraft: counts }),
    }),
  }),
);

const AirportsSchema = z.object({
  generatedAt: z.string(),
  faaEffectiveDate: z.string().optional(),
  summary: z.object({ total: z.number(), matchedToFaa: z.number(), unmatched: z.number(), ambiguousCodes: z.number(), stateMismatches: z.number() }),
  airports: z.array(z.object({ code: z.string(), runways: z.array(z.object({ id: z.string() }).passthrough()), faaMatched: z.boolean(), ambiguousCode: z.boolean() }).passthrough()),
});

const ManifestSchema = z
  .object({
    generatedAt: z.string(),
    alignedMonths: z.array(z.string().regex(/^\d{4}-\d{2}$/)).min(1),
    datasets: z.record(z.string(), z.object({ source: z.string() }).passthrough()),
  })
  .passthrough();
export type Manifest = z.infer<typeof ManifestSchema>;

export class DataStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataStoreError';
  }
}

/** A numeric CSV cell: empty means missing (undefined); anything else must parse, or the dataset is rejected. */
function optNum(row: Record<string, string>, col: string, file: string): number | undefined {
  const v = row[col];
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DataStoreError(`${file}: column ${col} has non-numeric value "${v}"`);
  return n;
}
function reqNum(row: Record<string, string>, col: string, file: string): number {
  const n = optNum(row, col, file);
  if (n === undefined) throw new DataStoreError(`${file}: column ${col} is empty`);
  return n;
}

export interface DataStore {
  readonly manifest: Manifest;
  readonly airportsFile: AirportsFile;
  readonly airports: AirportIndex;
  readonly traffic: readonly MonthlyTraffic[];
  readonly trafficByAirport: ReadonlyMap<string, readonly MonthlyTraffic[]>;
  readonly segments: readonly SegmentRecord[];
  readonly onTime: readonly OnTimeAirportMonth[];
  readonly onTimeByAirport: ReadonlyMap<string, readonly OnTimeAirportMonth[]>;
  readonly segmentsByOrigin: ReadonlyMap<string, readonly SegmentRecord[]>;
  /** Months for which route-segment and on-time data are both present (the aligned analysis window). */
  readonly alignedMonths: readonly string[];
  /**
   * How much of an airport's scheduled passenger service the on-time dataset covers: on-time scheduled flights divided by
   * T-100 scheduled passenger departures over the same months. Carriers below the BTS reporting threshold are missing from
   * on-time data, so delay statistics describe only the covered share. Undefined when T-100 shows no scheduled service.
   */
  onTimeCoverage(airport: string, months?: readonly string[]): { ratio: number | undefined; onTimeFlights: number; t100ScheduledDepartures: number };
}

const group = <T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
};

async function guarded<T>(file: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DataStoreError(`${file} is missing from data/processed. Restore it from the repository or rebuild with npm run data:build.`);
    }
    if (err instanceof DataStoreError) throw err;
    throw new DataStoreError(`${file} could not be read: ${(err as Error).message}`);
  }
}

/** Loads and validates every processed dataset. Fails loudly instead of running on partial or invalid data. */
export async function loadDataStore(dir: string = PROCESSED_DIR): Promise<DataStore> {
  const p = (name: string): string => resolve(dir, name);
  const manifest = await guarded('manifest.json', async () => {
    const parsed = ManifestSchema.safeParse(await readJson(p('manifest.json')));
    if (!parsed.success) throw new DataStoreError(`manifest.json is invalid: ${parsed.error.issues[0]?.message}`);
    return parsed.data;
  });
  const airportsFile = await guarded('airports.json', async () => {
    const parsed = AirportsSchema.safeParse(await readJson(p('airports.json')));
    if (!parsed.success) throw new DataStoreError(`airports.json is invalid: ${parsed.error.issues[0]?.message}`);
    return parsed.data as unknown as AirportsFile;
  });
  const traffic = await guarded('traffic-monthly.csv.gz', async () =>
    (await readGzipCsv(p('traffic-monthly.csv.gz'))).map((r): MonthlyTraffic => {
      const f = 'traffic-monthly.csv.gz';
      const rec: Record<string, unknown> = { airport: r.airport, month: r.month };
      if (!r.airport || !/^\d{4}-\d{2}$/.test(r.month ?? '')) throw new DataStoreError(`${f}: row without a valid airport/month`);
      for (const [col, key] of [['airportName', 'airportName'], ['cityName', 'cityName']] as const) if (r[col]) rec[key] = r[col];
      for (const col of ['departures', 'passengers', 'seats', 'loadFactorPct', 'freightLbs', 'mailLbs', 'domesticDepartures', 'internationalDepartures']) {
        const n = optNum(r, col, f);
        if (n !== undefined) rec[col] = n;
      }
      return rec as unknown as MonthlyTraffic;
    }),
  );
  const segments = await guarded('route-segments.csv.gz', async () =>
    (await readGzipCsv(p('route-segments.csv.gz'))).map((r): SegmentRecord => {
      const f = 'route-segments.csv.gz';
      return {
        month: r.month as string, origin: r.origin as string, dest: r.dest as string, cls: r.cls as string,
        distance: reqNum(r, 'distance', f), depsScheduled: reqNum(r, 'depsScheduled', f), depsPerformed: reqNum(r, 'depsPerformed', f),
        seats: reqNum(r, 'seats', f), passengers: reqNum(r, 'passengers', f), freightLbs: reqNum(r, 'freightLbs', f), mailLbs: reqNum(r, 'mailLbs', f),
        originCountry: r.originCountry ?? '', destCountry: r.destCountry ?? '',
      };
    }),
  );
  const onTime = await guarded('ontime-airport-month.json.gz', async () => {
    const parsed = OnTimeSchema.safeParse(await readGzipJson(p('ontime-airport-month.json.gz')));
    if (!parsed.success) throw new DataStoreError(`ontime-airport-month.json.gz is invalid: ${parsed.error.issues[0]?.message}`);
    return parsed.data as OnTimeAirportMonth[];
  });

  const trafficByAirport = group(traffic, (r) => r.airport);
  const recent = new Map<string, number>();
  const last12 = new Set([...new Set(traffic.map((r) => r.month))].sort().slice(-12));
  for (const r of traffic) if (last12.has(r.month)) recent.set(r.airport, (recent.get(r.airport) ?? 0) + (r.passengers ?? 0));
  const segMonths = new Set(segments.map((s) => s.month));
  const otMonths = new Set(onTime.map((o) => o.month));
  const alignedMonths = [...segMonths].filter((m) => otMonths.has(m)).sort();
  if (alignedMonths.length === 0) throw new DataStoreError('route-segments and ontime datasets share no month; rebuild them for the same period');

  const onTimeByAirport = group(onTime, (r) => r.airport);
  const segmentsByOrigin = group(segments, (r) => r.origin);
  return {
    manifest,
    airportsFile,
    airports: new AirportIndex(airportsFile.airports, (code) => recent.get(code) ?? 0),
    traffic,
    trafficByAirport,
    segments,
    onTime,
    onTimeByAirport,
    segmentsByOrigin,
    alignedMonths,
    onTimeCoverage(airport, months = alignedMonths) {
      const inWindow = new Set(months);
      const onTimeFlights = (onTimeByAirport.get(airport) ?? []).filter((r) => inWindow.has(r.month)).reduce((s, r) => s + r.dep.scheduled, 0);
      const t100 = (segmentsByOrigin.get(airport) ?? []).filter((r) => r.cls === 'F' && inWindow.has(r.month)).reduce((s, r) => s + r.depsScheduled, 0);
      return { ratio: t100 > 0 ? onTimeFlights / t100 : undefined, onTimeFlights, t100ScheduledDepartures: t100 };
    },
  };
}
