import { z } from 'zod';
import { TtlCache } from './cache.js';
import { ProviderError } from './errors.js';
import { getJson, type HttpOptions } from './http.js';
import { isAirportCode, isMonth, type Month, type Provenance, type Sourced } from './types.js';
import { parseResponse } from './validate.js';

export const BTS_SUMMARY_URL = 'https://data.bts.gov/resource/r495-tyji.json';
const DATASET = 'BTS T-100 Segment Summary By Origin Airport (data.bts.gov r495-tyji)';
const SOURCE = 'bts-socrata';
const PAGE = 50_000;

/** Socrata sends every number as a string and omits null fields; an absent field stays undefined, never 0. */
const num = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform(Number);

const RowDto = z.object({
  origin_airport_code: z.string().regex(/^[A-Z0-9]{3}$/),
  origin_airport_name: z.string().optional(),
  origin_city_name: z.string().optional(),
  reporting_month: z.string().regex(/^\d{4}-\d{2}-01T00:00:00(\.000)?$/),
  total_departures: num.optional(),
  total_passengers: num.optional(),
  total_seats: num.optional(),
  total_load_factor: num.optional(),
  total_freight_lbs: num.optional(),
  total_mail_lbs: num.optional(),
  domestic_departures: num.optional(),
  outbound_international: num.optional(),
});

/** One airport-month of BTS T-100 origin-airport totals (all carriers, scheduled and non-scheduled). */
export interface MonthlyTraffic {
  readonly airport: string;
  readonly month: Month;
  readonly airportName?: string;
  readonly cityName?: string;
  readonly departures?: number;
  readonly passengers?: number;
  readonly seats?: number;
  /** BTS-reported load factor, percent. */
  readonly loadFactorPct?: number;
  readonly freightLbs?: number;
  readonly mailLbs?: number;
  readonly domesticDepartures?: number;
  readonly internationalDepartures?: number;
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function mapRows(payload: unknown): MonthlyTraffic[] {
  return parseResponse(SOURCE, z.array(RowDto), payload, 'traffic rows').map((r) =>
    defined({
      airport: r.origin_airport_code,
      month: r.reporting_month.slice(0, 7),
      airportName: r.origin_airport_name,
      cityName: r.origin_city_name,
      departures: r.total_departures,
      passengers: r.total_passengers,
      seats: r.total_seats,
      loadFactorPct: r.total_load_factor,
      freightLbs: r.total_freight_lbs,
      mailLbs: r.total_mail_lbs,
      domesticDepartures: r.domestic_departures,
      internationalDepartures: r.outbound_international,
    }),
  );
}

export interface TrafficQuery {
  /** Omit for all airports. */
  readonly airports?: readonly string[];
  readonly from: Month;
  readonly to: Month;
}

export interface BtsSocrataOptions extends Omit<HttpOptions, 'source'> {
  readonly baseUrl?: string;
  readonly now?: () => Date;
  readonly cacheTtlMs?: number;
  /** Rows per request; Socrata allows up to 50,000. Tests lower it to exercise pagination. */
  readonly pageSize?: number;
}

/** Live client for the BTS Socrata API (no key). Paginates, validates, retries, and caches identical queries. */
export class BtsSocrataClient {
  private readonly cache: TtlCache<Sourced<MonthlyTraffic[]>>;
  private readonly baseUrl: string;
  private readonly now: () => Date;

  constructor(private readonly opts: BtsSocrataOptions = {}) {
    this.baseUrl = opts.baseUrl ?? BTS_SUMMARY_URL;
    this.now = opts.now ?? (() => new Date());
    this.cache = new TtlCache(opts.cacheTtlMs ?? 6 * 3600_000);
  }

  private get(url: URL): Promise<unknown> {
    return getJson(url, { ...this.opts, source: SOURCE });
  }

  /** Earliest and latest month the dataset publishes. */
  async availablePeriod(): Promise<Sourced<{ start: Month; end: Month }>> {
    const url = new URL(this.baseUrl);
    url.searchParams.set('$select', 'min(reporting_month) as mn,max(reporting_month) as mx');
    const rows = parseResponse(SOURCE, z.array(z.object({ mn: z.string(), mx: z.string() })).length(1), await this.get(url), 'period');
    const r = rows[0] as { mn: string; mx: string };
    const period = { start: r.mn.slice(0, 7), end: r.mx.slice(0, 7) };
    return { data: period, provenance: this.provenance(period) };
  }

  monthlyTraffic(query: TrafficQuery): Promise<Sourced<MonthlyTraffic[]>> {
    const { airports, from, to } = query;
    if (!isMonth(from) || !isMonth(to) || from > to) throw new ProviderError(SOURCE, 'invalid-request', `invalid period ${from}..${to}`);
    const codes = airports ? [...new Set(airports)].sort() : undefined;
    if (codes?.some((c) => !isAirportCode(c))) throw new ProviderError(SOURCE, 'invalid-request', 'airport codes must be 3 letters or digits');
    if (codes?.length === 0) return Promise.resolve({ data: [], provenance: this.provenance({ start: from, end: to }) });
    return this.cache.get(`${codes?.join(',') ?? '*'}|${from}|${to}`, () => this.fetchTraffic(codes, from, to));
  }

  private async fetchTraffic(codes: string[] | undefined, from: Month, to: Month): Promise<Sourced<MonthlyTraffic[]>> {
    const where = [`reporting_month >= '${from}-01T00:00:00'`, `reporting_month <= '${to}-01T00:00:00'`];
    if (codes) where.push(`origin_airport_code in(${codes.map((c) => `'${c}'`).join(',')})`);
    const all: MonthlyTraffic[] = [];
    const pageSize = this.opts.pageSize ?? PAGE;
    for (let offset = 0; ; offset += pageSize) {
      const url = new URL(this.baseUrl);
      url.searchParams.set('$select', Object.keys(RowDto.shape).join(','));
      url.searchParams.set('$where', where.join(' AND '));
      url.searchParams.set('$order', 'origin_airport_code,reporting_month');
      url.searchParams.set('$limit', String(pageSize));
      url.searchParams.set('$offset', String(offset));
      const page = mapRows(await this.get(url));
      all.push(...page);
      if (page.length < pageSize) break;
    }
    const keys = new Set<string>();
    for (const r of all) {
      const k = `${r.airport}|${r.month}`;
      if (keys.has(k)) throw new ProviderError(SOURCE, 'invalid-response', `duplicate row ${k}`);
      keys.add(k);
    }
    return { data: all, provenance: this.provenance({ start: from, end: to }) };
  }

  private provenance(period: { start: Month; end: Month }): Provenance {
    return { source: SOURCE, dataset: DATASET, retrievedAt: this.now().toISOString(), period };
  }
}
