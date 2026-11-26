import { z } from 'zod';
import type { AnalyticsService, Scope } from '../analytics/service.js';
import type { AirportRecord } from '../data/airportBuild.js';
import { CENSUS_DIVISIONS, CENSUS_REGIONS, normalizeState } from '../data/geo.js';
import type { DataStore } from '../data/store.js';
import { fail, type Interpretation, type ToolFailure } from './envelope.js';

export interface ToolContext {
  readonly service: AnalyticsService;
  readonly store: DataStore;
  /**
   * When a name matches several airports and one carries at least 80% of their passengers (for example "Anchorage",
   * "Denver", "Honolulu"), use it and disclose the interpretation in the result. Names that also belong to a commercial
   * airport in another state (Portland, Washington) or have no dominant airport are never guessed.
   * Default true; set false to require a code for every ambiguous name.
   */
  readonly autoResolveDominant?: boolean;
  /** Collects interpretations made while a tool runs; the runner turns them into warnings on the result. */
  readonly notes?: string[];
  readonly interpretations?: Interpretation[];
}

/** Supported named regions: the nine Census divisions and four Census regions. Anything else must be given as states. */
export const REGION_NAMES = [...Object.keys(CENSUS_DIVISIONS), ...Object.keys(CENSUS_REGIONS)] as [string, ...string[]];

export const airportRef = z
  .string()
  .min(2)
  .max(80)
  .describe('Airport code or name, e.g. "LAX" or "Santa Ana". An ambiguous name returns an error listing the options.');

/** Geographic scope shared by listing, screening and ranking tools. Fields combine as an intersection; with none, all US airports. */
export const scopeShape = {
  states: z.array(z.string().min(2)).max(60).optional().describe('US state codes or names, e.g. ["MA","Vermont"]. Use for informal areas.'),
  region: z.enum(REGION_NAMES).optional().describe('Census division or region; merged with states.'),
  airport_codes: z.array(airportRef).max(60).optional().describe('Restrict to these airports.'),
  near_airport: airportRef.optional().describe('Radius center airport (needs radius_miles).'),
  latitude: z.number().min(-90).max(90).optional().describe('Radius center latitude (needs longitude and radius_miles).'),
  longitude: z.number().min(-180).max(180).optional().describe('Radius center longitude.'),
  radius_miles: z.number().min(1).max(3000).optional().describe('Radius in miles.'),
};
export type ScopeArgs = z.infer<z.ZodObject<typeof scopeShape>>;

const brief = (a: AirportRecord) => ({ code: a.code, ...(a.name ? { name: a.name } : {}), ...(a.city ? { city: a.city } : {}), ...(a.state ? { state: a.state } : {}) });

const COMMERCIAL_PASSENGERS = 100_000;
/**
 * True when a city of that name in a different state has an airport with real commercial service (Portland, OR and Portland, ME):
 * then traffic dominance says nothing about which place the user means. Tiny or state-less records (military or general-aviation
 * fields that share a name) do not count.
 */
function spansPlaces(ref: string, suggested: AirportRecord, candidates: readonly AirportRecord[], ctx: ToolContext): boolean {
  const place = ref.trim().toLowerCase();
  // Only airports in a city of that very name count; an airport that merely has the word in its name (Manchester-Boston) does not.
  return candidates.some((c) => c.code !== suggested.code && c.state !== suggested.state && (c.city ?? '').split(',')[0]?.trim().toLowerCase() === place && ctx.store.airports.weightOf(c.code) >= COMMERCIAL_PASSENGERS);
}

/**
 * Resolves airport references to codes. If any reference is ambiguous or unknown nothing is selected: the failure lists the
 * options so the caller (or the user) chooses, instead of the tool guessing.
 */
export function resolveAirports(tool: string, refs: readonly string[], ctx: ToolContext): { codes: string[] } | ToolFailure {
  const codes: string[] = [];
  const ambiguous: Array<NonNullable<ToolFailure['error']['candidates']>[number]> = [];
  const unknown: string[] = [];
  for (const ref of refs) {
    const r = ctx.store.airports.resolve(ref);
    if (r.status === 'found') codes.push(r.airport.code);
    else if (r.status === 'ambiguous' && r.suggested && ctx.autoResolveDominant !== false && !spansPlaces(ref, r.suggested, r.candidates, ctx)) {
      codes.push(r.suggested.code);
      const others = r.candidates.filter((c) => c.code !== r.suggested?.code).map((c) => c.code);
      ctx.interpretations?.push({ input: ref, used: { code: r.suggested.code, ...(r.suggested.name ? { name: r.suggested.name } : {}) }, alternatives: r.candidates.filter((c) => c.code !== r.suggested?.code).map(brief) });
      ctx.notes?.push(`Airport name interpretation: "${ref}" matched ${r.candidates.length} airports; ${r.suggested.code} (${r.suggested.name ?? r.suggested.city ?? ''}) was used because it carries at least 80% of their passengers. Others: ${others.join(', ')}. Say so, and offer the alternatives.`);
    } else if (r.status === 'ambiguous') ambiguous.push({ input: ref, options: r.candidates.map(brief), ...(r.suggested ? { suggested: r.suggested.code } : {}) });
    else unknown.push(`"${ref}": ${r.reason}`);
  }
  if (ambiguous.length > 0) {
    return fail(tool, 'ambiguous_airport', `Ambiguous airport name: ${ambiguous.map((a) => `"${a.input}"`).join(', ')}. No airport was chosen.`, { candidates: ambiguous, hint: 'Ask the user which airport is meant, or retry with the airport code. A "suggested" code is the busiest candidate, not a confirmed match.' });
  }
  if (unknown.length > 0) return fail(tool, 'unknown_airport', `Could not identify: ${unknown.join('; ')}`, { hint: 'Use a 3-letter airport code, or call resolve_airport to search by name.' });
  return { codes: [...new Set(codes)] };
}

/** Turns scope arguments into an analytics scope, rejecting incomplete or unsupported combinations explicitly. */
export function buildScope(tool: string, args: ScopeArgs, ctx: ToolContext): { scope: Scope } | ToolFailure {
  const states = [...(args.states ?? []), ...(args.region ? [...(CENSUS_DIVISIONS[args.region] ?? CENSUS_REGIONS[args.region] ?? [])] : [])];
  const bad = (args.states ?? []).filter((s) => normalizeState(s) === undefined);
  if (bad.length > 0) {
    return fail(tool, 'unsupported_scope', `Not US states or territories: ${bad.join(', ')}. This dataset covers US airports only.`, { hint: 'Use two-letter state codes or full state names; for regions without a Census name pass the states explicitly.' });
  }
  const hasCenter = args.near_airport !== undefined || args.latitude !== undefined || args.longitude !== undefined;
  if ((args.latitude === undefined) !== (args.longitude === undefined)) return fail(tool, 'invalid_arguments', 'latitude and longitude must be given together.');
  if (hasCenter && args.radius_miles === undefined) return fail(tool, 'invalid_arguments', 'A radius search needs radius_miles.');
  if (args.radius_miles !== undefined && !hasCenter) return fail(tool, 'invalid_arguments', 'radius_miles needs a center: near_airport or latitude and longitude.');
  if (args.near_airport !== undefined && args.latitude !== undefined) return fail(tool, 'invalid_arguments', 'Give either near_airport or latitude/longitude, not both.');

  let near: Scope['near'];
  if (args.radius_miles !== undefined) {
    if (args.near_airport !== undefined) {
      const r = resolveAirports(tool, [args.near_airport], ctx);
      if ('ok' in r) return r;
      const center = ctx.store.airports.get(r.codes[0] as string);
      if (center?.lat === undefined || center.lon === undefined) return fail(tool, 'data_unavailable', `${center?.code ?? args.near_airport} has no FAA coordinates, so it cannot be used as a radius center.`, { hint: 'Give latitude and longitude instead.' });
      near = { lat: center.lat, lon: center.lon, radiusMiles: args.radius_miles };
    } else near = { lat: args.latitude as number, lon: args.longitude as number, radiusMiles: args.radius_miles };
  }
  let codes: string[] | undefined;
  if (args.airport_codes && args.airport_codes.length > 0) {
    const r = resolveAirports(tool, args.airport_codes, ctx);
    if ('ok' in r) return r;
    codes = r.codes;
  }
  return { scope: { ...(states.length ? { states } : {}), ...(codes ? { codes } : {}), ...(near ? { near } : {}) } };
}

export const intLimit = (def: number, max: number) => z.number().int().min(1).max(max).default(def).describe(`Max rows (default ${def}).`);
export const offsetArg = z.number().int().min(0).default(0).describe('Rows to skip (paging).');
export const monthArg = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'use YYYY-MM');
export const serviceClassArg = z
  .array(z.enum(['F', 'G', 'L', 'P']))
  .min(1)
  .max(4)
  .optional()
  .describe('F scheduled passenger/cargo (default), G scheduled cargo, L non-scheduled, P non-scheduled cargo.');
