/**
 * Programmatic control over tool arguments that change what a question means.
 *
 * The model fills in tool arguments, and models tend to add things the user never asked for (a passenger floor, a different
 * window) or to drop a scope the user gave earlier. This module checks, in code, where each such argument came from:
 *
 *  - explicit: its number or keyword appears in the user's message, or it equals what an earlier call used;
 *  - derived: the user asked for a relative change ("double the growth weight") of something used before;
 *  - assumed: neither. Assumed narrowing arguments are ignored (the tool default applies) and the result says so.
 *
 * Omitted arguments that the user set explicitly earlier are carried forward in follow-ups. A geographic scope the user
 * never named is never silently adopted: with an earlier scope it is restored; otherwise (an informal place such as "the
 * Southeast") it is kept but reported as the assistant's interpretation. Every action is returned as a notice that travels
 * to the user. These are heuristics over wording, not a proof of intent: they reduce silent changes, they do not remove them.
 */
import { CENSUS_DIVISIONS, CENSUS_REGIONS, US_STATES } from '../data/geo.js';

export type Args = Record<string, unknown>;

export interface PriorCall {
  readonly tool: string;
  readonly args: Args;
  /** Policed parameters of that call that were explicit or derived (so worth carrying forward). */
  readonly explicit: readonly string[];
}

export interface PolicyContext {
  readonly userText: string;
  /** Calls from earlier turns and earlier in this turn, oldest first. */
  readonly prior: readonly PriorCall[];
}

export interface Notice {
  readonly kind: 'ignored_parameter' | 'inherited_parameter' | 'scope_restored' | 'scope_interpreted';
  readonly tool: string;
  readonly param?: string;
  readonly message: string;
}

export interface PolicyResult {
  readonly args: Args;
  readonly notices: readonly Notice[];
  /** Policed parameters of the final call that are explicit or derived. */
  readonly explicit: readonly string[];
}

/** Tools whose arguments include a geographic scope. */
const SCOPE_TOOLS = new Set(['find_airports', 'screen_airports', 'rank_expansion_opportunities']);
const SCOPE_PARAMS = ['states', 'region', 'airport_codes', 'near_airport', 'latitude', 'longitude', 'radius_miles'] as const;

/** Parameters that narrow or reshape an analysis: each needs the user's backing. Value = the tool's own default, which needs none. */
const POLICED: Record<string, { tools: ReadonlySet<string>; default?: unknown; kind: 'number' | 'weights' | 'option' | 'classes' }> = {
  min_passengers: { tools: new Set(['screen_airports', 'rank_expansion_opportunities']), default: 100_000, kind: 'number' },
  filters: { tools: new Set(['screen_airports']), kind: 'number' },
  window_months: { tools: new Set(['get_traffic_metrics', 'rank_expansion_opportunities']), default: 12, kind: 'number' },
  threshold_miles: { tools: new Set(['get_long_haul_share']), default: 3000, kind: 'number' },
  min_miles: { tools: new Set(['search_routes']), kind: 'number' },
  max_miles: { tools: new Set(['search_routes']), kind: 'number' },
  weights: { tools: new Set(['rank_expansion_opportunities']), kind: 'weights' },
  correlation_adjustment: { tools: new Set(['rank_expansion_opportunities']), kind: 'option' },
  missing_data_policy: { tools: new Set(['rank_expansion_opportunities']), kind: 'option' },
  service_classes: { tools: new Set(['get_route_network', 'search_routes', 'get_long_haul_share']), kind: 'classes' },
};

const RELATIVE = /\b(double|twice|triple|halve|half|more|less|fewer|higher|lower|increase|decrease|raise|reduce|bigger|smaller|heavier|lighter|instead)\b/i;
const RESET = /\b(default|reset|remove|without|ignore|drop|any size|all (?:us |u\.s\. )?airports|nationwide|whole country|entire country|across the (country|us|u\.s\.)|everywhere)\b/i;
const WEIGHT_WORDS = /(weight|emphasi|prioriti|importan|matter|focus|favou?r|care (more|about)|heav|more heavily|less heavily)/i;
const OPTION_WORDS = /(correlat|overlap|double.?count|missing|incomplete|neutral|redistribut|impute)/i;
const CLASS_WORDS = /(cargo|freight|charter|non.?scheduled|all flights|every flight|including)/i;

const WORD_NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Numbers a user can mean in a message: 500,000, 5M, 5 million, 2.5k, six, and period words (year = 12 months, quarter = 3). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.toLowerCase().matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(?:(k|thousand|mm|m|million|bn|b|billion)(?![a-z])|(%))?/g)) {
    const n = Number((m[1] as string).replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const mult = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 }[m[2] as string] ?? 1;
    out.add(n * mult);
    out.add(n);
    if (m[3] === '%') out.add(n / 100); // "84%" may be passed to a tool as 0.84
  }
  for (const w of text.toLowerCase().match(/\b[a-z]+\b/g) ?? []) if (w in WORD_NUMBERS) out.add(WORD_NUMBERS[w] as number);
  if (/\byear\b/i.test(text)) out.add(12);
  if (/\bquarter\b/i.test(text)) out.add(3);
  if (/\bhalf[- ]year\b/i.test(text)) out.add(6);
  return out;
}

const numbersOf = (v: unknown, into: number[] = []): number[] => {
  if (typeof v === 'number') into.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersOf(x, into));
  else if (v && typeof v === 'object') Object.values(v as Args).forEach((x) => numbersOf(x, into));
  return into;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = (v: unknown): boolean => v === undefined || v === null || (Array.isArray(v) && v.length === 0);

function lastCall(prior: readonly PriorCall[], tools: ReadonlySet<string>, param: string, explicitOnly: boolean): PriorCall | undefined {
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const c = prior[i] as PriorCall;
    if (tools.has(c.tool) && !isEmpty(c.args[param]) && (!explicitOnly || c.explicit.includes(param))) return c;
  }
  return undefined;
}

/** Why a value is backed by the conversation, or undefined if it is not. */
function support(name: string, value: unknown, ctx: PolicyContext, userNumbers: Set<number>): 'explicit' | 'derived' | undefined {
  const spec = POLICED[name] as NonNullable<(typeof POLICED)[string]>;
  if (spec.default !== undefined && same(value, spec.default)) return 'explicit';
  if (ctx.prior.some((c) => same(c.args[name], value) && c.explicit.includes(name))) return 'explicit';
  const prev = lastCall(ctx.prior, spec.tools, name, false);
  const relative = RELATIVE.test(ctx.userText);
  switch (spec.kind) {
    case 'number': {
      const nums = numbersOf(value);
      if (nums.length > 0 && nums.every((n) => userNumbers.has(n))) return 'explicit';
      return relative && prev ? 'derived' : undefined;
    }
    case 'weights': {
      const nums = numbersOf(value).filter((n) => n > 0);
      if (WEIGHT_WORDS.test(ctx.userText)) return nums.length > 0 && nums.every((n) => userNumbers.has(n)) ? 'explicit' : 'derived';
      return prev && relative ? 'derived' : undefined;
    }
    case 'option':
      return OPTION_WORDS.test(ctx.userText) ? 'explicit' : undefined;
    case 'classes':
      return CLASS_WORDS.test(ctx.userText) ? 'explicit' : undefined;
  }
}

/* ------------------------------------------------------------------------------------------------ scope */

const STATE_NAMES = Object.entries(US_STATES).map(([code, name]) => ({ code, name: name.toLowerCase() }));

/** Places (states, regions) a message names, as state codes and region names. */
export function placesIn(text: string): { states: Set<string>; regions: Set<string>; any: boolean } {
  const lower = text.toLowerCase();
  const states = new Set<string>();
  const regions = new Set<string>();
  for (const s of STATE_NAMES) {
    if (new RegExp(String.raw`\b${s.name}\b`).test(lower)) states.add(s.code);
    if (new RegExp(String.raw`\b${s.code}\b`).test(text)) states.add(s.code); // case-sensitive: "MA", not the word "ma"
  }
  for (const r of [...Object.keys(CENSUS_DIVISIONS), ...Object.keys(CENSUS_REGIONS)]) if (lower.includes(r.toLowerCase())) regions.add(r);
  return { states, regions, any: states.size > 0 || regions.size > 0 };
}

const norm = (s: string): string => s.trim().toLowerCase();

function scopeOf(args: Args): Args {
  return Object.fromEntries(SCOPE_PARAMS.filter((p) => !isEmpty(args[p])).map((p) => [p, args[p]]));
}

/** True when every state, region and airport in the scope arguments is named in the text or an earlier scope. */
function scopeGrounded(scope: Args, ctx: PolicyContext): boolean {
  const places = placesIn(ctx.userText);
  const text = ctx.userText.toLowerCase();
  const priorScopes = ctx.prior.filter((c) => SCOPE_TOOLS.has(c.tool)).map((c) => scopeOf(c.args));
  const priorStates = new Set(priorScopes.flatMap((s) => ((s.states as string[] | undefined) ?? []).map(norm)));
  for (const s of (scope.states as string[] | undefined) ?? []) {
    const n = norm(s);
    const code = STATE_NAMES.find((x) => x.name === n || x.code.toLowerCase() === n)?.code;
    if (!(code && places.states.has(code)) && !priorStates.has(n) && !(code && [...priorStates].some((p) => STATE_NAMES.find((x) => x.name === p || x.code.toLowerCase() === p)?.code === code))) return false;
  }
  if (typeof scope.region === 'string' && !places.regions.has(scope.region) && !priorScopes.some((p) => p.region === scope.region)) return false;
  for (const ref of [...((scope.airport_codes as string[] | undefined) ?? []), ...(typeof scope.near_airport === 'string' ? [scope.near_airport] : [])]) {
    const r = norm(ref);
    if (!text.includes(r) && !JSON.stringify(ctx.prior).toLowerCase().includes(r)) return false;
  }
  return true;
}

const describeScope = (s: Args): string =>
  [s.states ? `states ${(s.states as string[]).join(', ')}` : '', s.region ? `region ${String(s.region)}` : '', s.airport_codes ? `airports ${(s.airport_codes as string[]).join(', ')}` : '', s.near_airport ? `within ${String(s.radius_miles)} miles of ${String(s.near_airport)}` : '']
    .filter(Boolean)
    .join('; ') || 'all US airports';

/* ------------------------------------------------------------------------------------------------ entry point */

export function applyArgPolicy(tool: string, input: Args, ctx: PolicyContext): PolicyResult {
  const args: Args = { ...input };
  const notices: Notice[] = [];
  const explicit: string[] = [];
  const userNumbers = numbersIn(ctx.userText);
  const reset = RESET.test(ctx.userText);

  // 1. Narrowing parameters the model supplied: keep what the conversation backs, ignore the rest.
  for (const [name, spec] of Object.entries(POLICED)) {
    if (!spec.tools.has(tool) || isEmpty(args[name])) continue;
    const why = support(name, args[name], ctx, userNumbers);
    if (why) explicit.push(name);
    else {
      notices.push({ kind: 'ignored_parameter', tool, param: name, message: `Ignored ${name.replaceAll('_', ' ')} (${JSON.stringify(args[name])}): you did not ask for it, so the default was used. Ask for it explicitly if you want it.` });
      delete args[name];
    }
  }

  // 2. Parameters the user set explicitly earlier and the model left out: carry them forward in follow-ups.
  if (!reset) {
    for (const [name, spec] of Object.entries(POLICED)) {
      if (!spec.tools.has(tool) || !isEmpty(args[name])) continue;
      const prev = lastCall(ctx.prior, spec.tools, name, true);
      if (prev) {
        args[name] = prev.args[name];
        explicit.push(name);
        notices.push({ kind: 'inherited_parameter', tool, param: name, message: `Kept ${name.replaceAll('_', ' ')} (${JSON.stringify(prev.args[name])}) from your earlier question. Say "reset" to drop it.` });
      }
    }
  }

  // 3. Geographic scope.
  if (SCOPE_TOOLS.has(tool)) {
    const scope = scopeOf(args);
    const places = placesIn(ctx.userText);
    const prevScopeCall = [...ctx.prior].reverse().find((c) => SCOPE_TOOLS.has(c.tool) && Object.keys(scopeOf(c.args)).length > 0);
    const hasScope = Object.keys(scope).length > 0;
    if (!hasScope && !places.any && !reset && prevScopeCall) {
      const prevScope = scopeOf(prevScopeCall.args);
      Object.assign(args, prevScope);
      notices.push({ kind: 'scope_restored', tool, message: `Kept the scope from your earlier question (${describeScope(prevScope)}). Say "all US airports" to widen it.` });
    } else if (hasScope && !scopeGrounded(scope, ctx)) {
      if (!places.any && !reset && prevScopeCall && !same(scopeOf(prevScopeCall.args), scope)) {
        for (const p of SCOPE_PARAMS) delete args[p];
        const prevScope = scopeOf(prevScopeCall.args);
        Object.assign(args, prevScope);
        notices.push({ kind: 'scope_restored', tool, message: `The assistant tried to change the scope to ${describeScope(scope)}, which you did not ask for; kept ${describeScope(prevScope)} from your earlier question.` });
      } else {
        notices.push({ kind: 'scope_interpreted', tool, message: `You did not name ${describeScope(scope)}; the assistant chose this scope to match your wording. Tell it if you meant something else.` });
      }
    }
  }
  return { args, notices, explicit };
}
