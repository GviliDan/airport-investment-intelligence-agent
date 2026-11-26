import { z } from 'zod';
import { TtlCache } from './cache.js';
import { ProviderError } from './errors.js';
import { getJson, type HttpOptions } from './http.js';
import { isAirportCode, type Provenance, type Sourced } from './types.js';
import { parseResponse } from './validate.js';

const ROOT = 'https://services.arcgis.com/xOi1kZaI0eWDREZv/arcgis/rest/services';
export const FAA_FACILITIES_URL = `${ROOT}/NTAD_Aviation_Facilities/FeatureServer/0/query`;
export const FAA_RUNWAYS_URL = `${ROOT}/Runways_View/FeatureServer/0/query`;
const SOURCE = 'faa-arcgis';
const PAGE = 1_000;
const MAX_PAGES = 20;
// Keeps the GET query string well under typical 2-4 KB server limits (longer ones return a misleading 404).
const MAX_CODES = 60;

const FACILITY_FIELDS = [
  'ARPT_ID', 'ARPT_NAME', 'CITY', 'STATE_CODE', 'COUNTRY_CODE', 'ICAO_ID', 'LAT_DECIMAL', 'LONG_DECIMAL',
  'FACILITY_USE_CODE', 'FAR_139_CARRIER_SER_CODE', 'TWR_TYPE_CODE', 'ELEV', 'EFF_DATE',
] as const;

const nullable = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);

const FacilityAttrs = z.object({
  ARPT_ID: z.string().min(1),
  ARPT_NAME: nullable(z.string()),
  CITY: nullable(z.string()),
  STATE_CODE: nullable(z.string()),
  COUNTRY_CODE: nullable(z.string()),
  ICAO_ID: nullable(z.string()),
  LAT_DECIMAL: nullable(z.number()),
  LONG_DECIMAL: nullable(z.number()),
  FACILITY_USE_CODE: nullable(z.string()),
  FAR_139_CARRIER_SER_CODE: nullable(z.string()),
  TWR_TYPE_CODE: nullable(z.string()),
  ELEV: nullable(z.number()),
  EFF_DATE: nullable(z.string()),
});

const RunwayAttrs = z.object({
  ARPT_ID: z.string().min(1),
  RWY_ID: z.string().min(1),
  RWY_LEN: nullable(z.number()),
  RWY_WIDTH: nullable(z.number()),
  SURFACE_TYPE_CODE: nullable(z.string()),
});

const Page = <A extends z.ZodType>(attrs: A) =>
  z.object({
    features: z.array(z.object({ attributes: attrs })),
    exceededTransferLimit: z.boolean().optional(),
    error: z.object({ message: z.string().optional() }).optional(),
  });

export interface FaaFacility {
  /** FAA location identifier; equals the IATA code for most commercial airports but not all. */
  readonly faaId: string;
  readonly name?: string;
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly icao?: string;
  readonly lat?: number;
  readonly lon?: number;
  /** PU = public use. */
  readonly useCode?: string;
  /** True when the airport holds an FAA Part 139 certificate for scheduled air-carrier service. */
  readonly scheduledService: boolean;
  readonly towerType?: string;
  readonly elevationFt?: number;
  readonly effectiveDate?: string;
}

export interface FaaRunway {
  readonly airport: string;
  readonly id: string;
  readonly lengthFt?: number;
  readonly widthFt?: number;
  readonly surface?: string;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function mapFacility(a: z.output<typeof FacilityAttrs>): FaaFacility {
  return defined({
    faaId: a.ARPT_ID,
    name: a.ARPT_NAME,
    city: a.CITY,
    state: a.STATE_CODE,
    country: a.COUNTRY_CODE,
    icao: a.ICAO_ID,
    lat: a.LAT_DECIMAL,
    lon: a.LONG_DECIMAL,
    useCode: a.FACILITY_USE_CODE,
    scheduledService: a.FAR_139_CARRIER_SER_CODE === 'S',
    towerType: a.TWR_TYPE_CODE,
    elevationFt: a.ELEV,
    effectiveDate: a.EFF_DATE,
  });
}

export interface FaaArcgisOptions extends Omit<HttpOptions, 'source'> {
  readonly facilitiesUrl?: string;
  readonly runwaysUrl?: string;
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
}

const quote = (values: readonly string[]): string => [...new Set(values)].sort().map((v) => `'${v}'`).join(',');

/** Live client for the FAA / NTAD ArcGIS FeatureServer (no key). */
export class FaaArcgisClient {
  private readonly cache: TtlCache<unknown>;
  private readonly now: () => Date;

  constructor(private readonly opts: FaaArcgisOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.cache = new TtlCache(opts.cacheTtlMs ?? 24 * 3600_000);
  }

  async airportsByCode(codes: readonly string[]): Promise<Sourced<FaaFacility[]>> {
    const unique = [...new Set(codes)];
    if (unique.some((c) => !isAirportCode(c))) throw new ProviderError(SOURCE, 'invalid-request', 'airport codes must be 3 letters or digits');
    const out: FaaFacility[] = [];
    for (let i = 0; i < unique.length; i += MAX_CODES) {
      out.push(...(await this.facilities(`ARPT_ID IN (${quote(unique.slice(i, i + MAX_CODES))})`)));
    }
    return { data: out, provenance: this.provenance(out) };
  }

  async airportsInStates(states: readonly string[], opts: { scheduledServiceOnly?: boolean } = {}): Promise<Sourced<FaaFacility[]>> {
    if (states.some((s) => !/^[A-Z]{2}$/.test(s))) throw new ProviderError(SOURCE, 'invalid-request', 'states must be 2-letter codes');
    if (states.length === 0) return { data: [], provenance: this.provenance([]) };
    const service = opts.scheduledServiceOnly ? " AND FAR_139_CARRIER_SER_CODE='S'" : '';
    const out = await this.facilities(`STATE_CODE IN (${quote(states)}) AND FACILITY_USE_CODE='PU'${service}`);
    return { data: out, provenance: this.provenance(out) };
  }

  async runways(codes: readonly string[]): Promise<Sourced<FaaRunway[]>> {
    const unique = [...new Set(codes)];
    if (unique.some((c) => !isAirportCode(c))) throw new ProviderError(SOURCE, 'invalid-request', 'airport codes must be 3 letters or digits');
    const out: FaaRunway[] = [];
    for (let i = 0; i < unique.length; i += MAX_CODES) {
      const where = `ARPT_ID IN (${quote(unique.slice(i, i + MAX_CODES))})`;
      const rows = await this.paged(this.opts.runwaysUrl ?? FAA_RUNWAYS_URL, where, 'ARPT_ID,RWY_ID,RWY_LEN,RWY_WIDTH,SURFACE_TYPE_CODE', 'ARPT_ID,RWY_ID', RunwayAttrs);
      for (const r of rows) {
        out.push(defined({ airport: r.ARPT_ID, id: r.RWY_ID, lengthFt: r.RWY_LEN, widthFt: r.RWY_WIDTH, surface: r.SURFACE_TYPE_CODE }));
      }
    }
    return { data: out, provenance: { source: SOURCE, dataset: 'FAA Runways (NTAD ArcGIS Runways_View)', retrievedAt: this.now().toISOString() } };
  }

  private async facilities(filter: string): Promise<FaaFacility[]> {
    const rows = await this.paged(
      this.opts.facilitiesUrl ?? FAA_FACILITIES_URL,
      `SITE_TYPE_CODE='A' AND ${filter}`,
      FACILITY_FIELDS.join(','),
      'STATE_CODE,ARPT_ID',
      FacilityAttrs,
    );
    const seen = new Set<string>();
    const out: FaaFacility[] = [];
    for (const r of rows) {
      if (seen.has(r.ARPT_ID)) continue; // the register can list one identifier twice; keep the first
      seen.add(r.ARPT_ID);
      out.push(mapFacility(r));
    }
    return out;
  }

  private async paged<A extends z.ZodType>(base: string, where: string, outFields: string, orderBy: string, attrs: A): Promise<z.output<A>[]> {
    const rows: z.output<A>[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(base);
      url.searchParams.set('where', where);
      url.searchParams.set('outFields', outFields);
      url.searchParams.set('returnGeometry', 'false');
      url.searchParams.set('orderByFields', orderBy);
      url.searchParams.set('resultRecordCount', String(PAGE));
      url.searchParams.set('resultOffset', String(page * PAGE));
      url.searchParams.set('f', 'json');
      const key = url.toString();
      const raw = await (this.cache.get(key, () => getJson(url, { ...this.opts, source: SOURCE })) as Promise<unknown>);
      const parsed = parseResponse(SOURCE, Page(attrs), raw, 'feature page');
      // ArcGIS reports query errors with HTTP 200 and an `error` object.
      if (parsed.error) throw new ProviderError(SOURCE, 'invalid-request', parsed.error.message ?? 'query rejected');
      rows.push(...(parsed.features as { attributes: z.output<A> }[]).map((f) => f.attributes));
      if (!parsed.exceededTransferLimit) return rows;
    }
    throw new ProviderError(SOURCE, 'invalid-response', `result exceeds ${MAX_PAGES * PAGE} records`);
  }

  private provenance(rows: readonly FaaFacility[]): Provenance {
    const eff = rows.map((r) => r.effectiveDate).filter((d): d is string => Boolean(d)).sort().at(-1);
    return {
      source: SOURCE,
      dataset: 'FAA Aviation Facilities (NTAD ArcGIS)',
      retrievedAt: this.now().toISOString(),
      ...(eff ? { note: `FAA data effective ${eff}` } : {}),
    };
  }
}
