import type { AirportRecord } from './airportBuild.js';
import { distanceMiles, normalizeState } from './geo.js';

export type ResolveResult =
  | { status: 'found'; airport: AirportRecord; matchedBy: 'code' | 'icao' | 'city' | 'name' }
  | { status: 'ambiguous'; candidates: AirportRecord[]; reason: string; /** Set only when one candidate carries at least 80% of the candidates' passenger traffic; callers must still state the assumption. */ suggested?: AirportRecord }
  | { status: 'not_found'; reason: string };

const norm = (s: string | undefined): string => (s ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const cityOf = (a: AirportRecord): string => norm((a.city ?? '').split(',')[0]);
const MAX_CANDIDATES = 8;

/** In-memory lookup over the processed airport list. Never guesses: an unclear name returns candidates. */
export class AirportIndex {
  private readonly byCode = new Map<string, AirportRecord>();
  private readonly byIcao = new Map<string, AirportRecord>();

  /** `weight` orders ambiguous candidates (e.g. by passengers); it never decides a match. */
  constructor(readonly airports: readonly AirportRecord[], private readonly weight: (code: string) => number = () => 0) {
    for (const a of airports) {
      this.byCode.set(a.code, a);
      if (a.icao) this.byIcao.set(a.icao, a);
    }
  }

  /** Passengers in the latest 12 months (the ordering weight), or 0 when unknown. */
  weightOf(code: string): number {
    return this.weight(code);
  }

  get(code: string): AirportRecord | undefined {
    return this.byCode.get(code.trim().toUpperCase());
  }

  private ranked(list: AirportRecord[]): AirportRecord[] {
    return [...list].sort((a, b) => this.weight(b.code) - this.weight(a.code) || a.code.localeCompare(b.code));
  }

  /** Resolves a code ("LAX", "KLAX") or a place/airport name ("Santa Ana", "Logan"), optionally narrowed by state. */
  resolve(query: string, opts: { state?: string } = {}): ResolveResult {
    const raw = query.trim();
    if (raw === '') return { status: 'not_found', reason: 'empty query' };
    const state = opts.state === undefined ? undefined : normalizeState(opts.state);
    if (opts.state !== undefined && !state) return { status: 'not_found', reason: `unknown state "${opts.state}"` };
    const inScope = (a: AirportRecord): boolean => (state ? a.state === state : true);

    const upper = raw.toUpperCase();
    if (/^[A-Z0-9]{3}$/.test(upper)) {
      const hit = this.byCode.get(upper);
      if (hit && inScope(hit)) return { status: 'found', airport: hit, matchedBy: 'code' };
    }
    if (/^[A-Z]{4}$/.test(upper)) {
      const hit = this.byIcao.get(upper);
      if (hit && inScope(hit)) return { status: 'found', airport: hit, matchedBy: 'icao' };
    }

    const q = norm(raw);
    if (q.length < 3) return { status: 'not_found', reason: `"${raw}" is too short to match a place or airport name; give an airport code or a city` };
    const pool = this.airports.filter(inScope);

    // A city match and a name match are pooled: "Logan" is a city in Utah and also Boston's airport name, so it must not
    // silently resolve to either one.
    const cityMatches = pool.filter((a) => cityOf(a) === q);
    const tokens = q.split(' ');
    const nameMatches = pool.filter((a) => {
      const hay = `${norm(a.name)} ${cityOf(a)}`;
      return tokens.every((t) => hay.includes(t));
    });
    const pooled = [...new Set([...cityMatches, ...nameMatches])];
    if (pooled.length === 1) {
      const airport = pooled[0] as AirportRecord;
      return { status: 'found', airport, matchedBy: cityMatches.includes(airport) ? 'city' : 'name' };
    }
    if (pooled.length > 1) {
      const ranked = this.ranked(pooled);
      const total = ranked.reduce((sum, c) => sum + this.weight(c.code), 0);
      const top = ranked[0] as AirportRecord;
      const suggested = total > 0 && this.weight(top.code) >= 0.8 * total ? top : undefined;
      return { status: 'ambiguous', candidates: ranked.slice(0, MAX_CANDIDATES), reason: `"${raw}" matches ${pooled.length} airports`, ...(suggested ? { suggested } : {}) };
    }
    return { status: 'not_found', reason: `no airport matches "${raw}"${state ? ` in ${state}` : ''}` };
  }

  /** Airports in any of the given states. Unknown state names are reported, not ignored. */
  inStates(states: readonly string[]): { airports: AirportRecord[]; unknown: string[] } {
    const codes = new Set<string>();
    const unknown: string[] = [];
    for (const s of states) {
      const n = normalizeState(s);
      if (n) codes.add(n);
      else unknown.push(s);
    }
    return { airports: this.airports.filter((a) => a.state !== undefined && codes.has(a.state)), unknown };
  }

  /** Airports within `radiusMiles` of a point. Airports without FAA coordinates cannot be placed and are counted separately. */
  near(point: { lat: number; lon: number }, radiusMiles: number): { airports: Array<{ airport: AirportRecord; miles: number }>; withoutCoordinates: number } {
    const out: Array<{ airport: AirportRecord; miles: number }> = [];
    let missing = 0;
    for (const a of this.airports) {
      if (a.lat === undefined || a.lon === undefined) {
        missing += 1;
        continue;
      }
      const miles = distanceMiles(point, { lat: a.lat, lon: a.lon });
      if (miles <= radiusMiles) out.push({ airport: a, miles });
    }
    return { airports: out.sort((x, y) => x.miles - y.miles), withoutCoordinates: missing };
  }
}
