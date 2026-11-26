import type { AirportIdentity } from './aggregate.js';
import type { FaaArcgisClient, FaaFacility, FaaRunway } from './faaArcgis.js';

export interface Runway {
  readonly id: string;
  readonly lengthFt?: number;
  readonly widthFt?: number;
  readonly surface?: string;
}

/** One airport as the application knows it. Identifier is the IATA-style 3-character code that BTS uses. */
export interface AirportRecord {
  readonly code: string;
  readonly name?: string;
  /** City as BTS spells it, e.g. "Los Angeles, CA". */
  readonly city?: string;
  readonly state?: string;
  readonly country?: string;
  readonly lat?: number;
  readonly lon?: number;
  readonly icao?: string;
  readonly faaId?: string;
  readonly scheduledService?: boolean;
  readonly towerType?: string;
  readonly elevationFt?: number;
  readonly runways: readonly Runway[];
  /** True when an FAA facility with the same identifier and a consistent state was found. */
  readonly faaMatched: boolean;
  readonly faaMatchMethod?: 'identifier' | 'override';
  /** Set when BTS lists more than one numeric airport id for the code (code reused over time). */
  readonly ambiguousCode: boolean;
  /** Why the FAA record was not attached, when it was not. */
  readonly faaIssue?: 'not-found' | 'state-mismatch';
}

export interface AirportsFile {
  readonly generatedAt: string;
  readonly faaEffectiveDate?: string;
  readonly summary: { total: number; matchedToFaa: number; unmatched: number; ambiguousCodes: number; stateMismatches: number };
  readonly airports: AirportRecord[];
}

/**
 * BTS identifies airports by IATA code and the FAA by its own location identifier. They are equal for most airports; these
 * are the ones with passenger traffic where they differ. Each pair was checked against the FAA record (name, city, state).
 */
export const FAA_ID_OVERRIDES: Readonly<Record<string, string>> = {
  AZA: 'IWA', FCA: 'GPI', USA: 'JQF', SCE: 'UNV', CLD: 'CRQ', GUF: 'JKA', YUM: 'NYL', MQT: 'SAW', HHH: 'HXD', SPN: 'GSN', TIQ: 'TNI', ROP: 'GRO',
};
/** BTS files several Pacific territories under the state code TT (Trust Territories). */
const TT_TERRITORIES = new Set(['GU', 'MP', 'AS', 'PW', 'FM', 'MH']);
const norm = (s: string | undefined): string => (s ?? '').toUpperCase().replace(/[^A-Z]/g, '');

/** True when the FAA and BTS records can describe the same place: same state, same city, or a TT territory. */
export function sameLocation(bts: { city?: string | undefined; state?: string | undefined }, faa: { city?: string | undefined; state?: string | undefined }): boolean {
  if (!bts.state || !faa.state || bts.state === faa.state) return true;
  if (bts.state === 'TT' && TT_TERRITORIES.has(faa.state)) return true;
  const btsCity = norm((bts.city ?? '').split(',')[0]);
  return btsCity !== '' && btsCity === norm(faa.city);
}

const stripCodeSuffix = (name: string): string => name.replace(/\s*\([A-Z0-9]{3}\)\s*$/, '').trim();
const titleCase = (s: string): string => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());

export interface BuildInput {
  readonly identities: readonly AirportIdentity[];
  readonly traffic: readonly { airport: string; airportName?: string | undefined; cityName?: string | undefined }[];
  readonly faa: Pick<FaaArcgisClient, 'airportsByCode' | 'runways'>;
  readonly now?: () => Date;
}

/**
 * Joins BTS identities with FAA facility data. The FAA record is attached only when its identifier matches and its
 * state agrees with BTS; a mismatch is recorded instead of silently attaching the wrong coordinates.
 */
export async function buildAirports({ identities, traffic, faa, now = () => new Date() }: BuildInput): Promise<AirportsFile> {
  const byCode = new Map<string, AirportIdentity>(identities.map((i) => [i.code, i]));
  const trafficNames = new Map<string, { name?: string; city?: string }>();
  for (const t of traffic) {
    const name = t.airportName ? stripCodeSuffix(t.airportName) : undefined;
    trafficNames.set(t.airport, { ...(name ? { name } : {}), ...(t.cityName ? { city: stripCodeSuffix(t.cityName) } : {}) });
    if (!byCode.has(t.airport)) byCode.set(t.airport, { code: t.airport, btsIds: [] });
  }
  // Only US airports can be in the FAA register; foreign destinations keep their BTS identity only.
  const usCodes = [...byCode.values()].filter((i) => i.country === 'US' || (i.country === undefined && trafficNames.has(i.code))).map((i) => i.code);
  const faaIdFor = (code: string): string => FAA_ID_OVERRIDES[code] ?? code;
  const facilities = new Map<string, FaaFacility>((await faa.airportsByCode([...new Set(usCodes.map(faaIdFor))])).data.map((f) => [f.faaId, f]));
  const runwaysBy = new Map<string, Runway[]>();
  const matchedCodes = [...facilities.keys()];
  for (const r of (await faa.runways(matchedCodes)).data as FaaRunway[]) {
    const list = runwaysBy.get(r.airport) ?? [];
    list.push({ id: r.id, ...(r.lengthFt !== undefined ? { lengthFt: r.lengthFt } : {}), ...(r.widthFt !== undefined ? { widthFt: r.widthFt } : {}), ...(r.surface ? { surface: r.surface } : {}) });
    runwaysBy.set(r.airport, list);
  }

  let stateMismatches = 0;
  const airports: AirportRecord[] = [...byCode.values()]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((id) => {
      const tn = trafficNames.get(id.code);
      const f = facilities.get(faaIdFor(id.code));
      const state = id.state;
      const mismatch = f !== undefined && !sameLocation({ city: id.city ?? tn?.city, state }, f);
      if (mismatch) stateMismatches += 1;
      const use = f && !mismatch ? f : undefined;
      const name = tn?.name ?? (use?.name ? titleCase(use.name) : undefined);
      const faaIssue = usCodes.includes(id.code) && !use ? (mismatch ? ('state-mismatch' as const) : ('not-found' as const)) : undefined;
      const rec: AirportRecord = {
        code: id.code,
        ...(name ? { name } : {}),
        ...((id.city ?? tn?.city) ? { city: (id.city ?? tn?.city) as string } : {}),
        ...((state ?? use?.state) ? { state: (state ?? use?.state) as string } : {}),
        ...((id.country ?? use?.country) ? { country: (id.country ?? use?.country) as string } : {}),
        ...(use?.lat !== undefined ? { lat: use.lat } : {}),
        ...(use?.lon !== undefined ? { lon: use.lon } : {}),
        ...(use?.icao ? { icao: use.icao } : {}),
        ...(use ? { faaId: use.faaId, scheduledService: use.scheduledService, faaMatchMethod: FAA_ID_OVERRIDES[id.code] ? ('override' as const) : ('identifier' as const) } : {}),
        ...(use?.towerType ? { towerType: use.towerType } : {}),
        ...(use?.elevationFt !== undefined ? { elevationFt: use.elevationFt } : {}),
        runways: use ? (runwaysBy.get(use.faaId) ?? []) : [],
        faaMatched: use !== undefined,
        ambiguousCode: id.btsIds.length > 1,
        ...(faaIssue ? { faaIssue } : {}),
      };
      return rec;
    });

  const effective = [...facilities.values()].map((f) => f.effectiveDate).filter((d): d is string => Boolean(d)).sort().at(-1);
  const matched = airports.filter((a) => a.faaMatched).length;
  return {
    generatedAt: now().toISOString(),
    ...(effective ? { faaEffectiveDate: effective } : {}),
    summary: {
      total: airports.length,
      matchedToFaa: matched,
      unmatched: usCodes.length - matched,
      ambiguousCodes: airports.filter((a) => a.ambiguousCode).length,
      stateMismatches,
    },
    airports,
  };
}
