/**
 * Airport Expansion Opportunity ranking.
 *
 * Purpose: help an investor shortlist airports where passenger demand is large, growing and pressing on existing capacity,
 * i.e. where added terminal or airfield capacity is more likely to be used. It is a screening indicator relative to the
 * candidate set. It is NOT a forecast, a profitability or ROI estimate, or an engineering assessment of terminal capacity.
 */
import { percentileRanks, pearson, shrink, median } from './stats.js';
import type { AirportMetrics } from './metrics.js';

export type MetricId = 'scale' | 'momentum' | 'loadFactor' | 'capacityGap' | 'runwayLoad' | 'taxiOut' | 'departureDelay';
export type Pillar = 'demand' | 'tightness' | 'strain' | 'context';

export interface MetricDefinition {
  readonly id: MetricId;
  readonly label: string;
  readonly pillar: Pillar;
  readonly unit: string;
  readonly source: string;
  readonly defaultWeight: number;
  readonly formula: string;
  readonly why: string;
  readonly caveat: string;
}

/**
 * Weights are analyst judgement, not estimated from outcomes (no public data links these metrics to investment returns).
 * They are shown with every result, can be overridden, and the ranking reports how much it moves when they change.
 */
export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    id: 'scale', label: 'Passenger scale', pillar: 'demand', unit: 'passengers (12 months)', source: 'BTS T-100 (Socrata API)', defaultWeight: 20,
    formula: 'sum of passengers over the latest 12 months',
    why: 'A larger passenger base means a larger revenue pool that capacity investment can serve.',
    caveat: 'Size alone is not opportunity; it is balanced by the other metrics. Counts passengers on all carriers, domestic and international.',
  },
  {
    id: 'momentum', label: 'Passenger growth (shrunk)', pillar: 'demand', unit: 'percent, year over year', source: 'BTS T-100 (Socrata API)', defaultWeight: 25,
    formula: 'g = P(latest 12m) / P(prior 12m) - 1; shrunk g* = (n*g + k*median(g)) / (n + k), n = prior-12m passengers, k = 250,000',
    why: 'Sustained growth signals future demand for capacity. 12-month windows remove seasonality.',
    caveat: 'Shrinkage pulls very small airports toward the candidate-set median so a few thousand extra passengers do not look like a trend.',
  },
  {
    id: 'loadFactor', label: 'Seat load factor', pillar: 'tightness', unit: 'percent of seats filled (12 months)', source: 'BTS T-100 (Socrata API)', defaultWeight: 15,
    formula: 'passengers / seats over the latest 12 months (sums, not an average of monthly percentages)',
    why: 'Full aircraft mean airlines have little spare seat capacity to absorb more demand, so added flights are more likely to fill.',
    caveat: 'This measures aircraft fullness, not terminal or runway congestion. Airlines can also run high load factors by design.',
  },
  {
    id: 'capacityGap', label: 'Passenger vs seat growth gap (shrunk)', pillar: 'tightness', unit: 'percentage points', source: 'BTS T-100 (Socrata API)', defaultWeight: 15,
    formula: 'g*(passengers) - g*(seats), each shrunk as above, in percentage points',
    why: 'Passengers growing faster than seats means airlines are filling existing capacity rather than adding it.',
    caveat: 'Related to load factor (the gap drives load-factor change); the two are weighted as one "tightness" pillar for that reason.',
  },
  {
    id: 'runwayLoad', label: 'Departures per commercial runway per day', pillar: 'strain', unit: 'departures / runway / day', source: 'BTS T-100 departures; FAA runways', defaultWeight: 15,
    formula: 'departures over 12 months (all BTS service classes, including all-cargo and charter) / days / count of runways >= 5,000 ft',
    why: 'Indicates how intensively existing airfield infrastructure is used.',
    caveat: 'Departures include cargo and non-scheduled flights, which use runways but not passenger terminals, so at cargo hubs (for example Memphis or Anchorage) this overstates passenger-related pressure. A runway-utilisation proxy only. Says nothing about terminal or gate capacity. Missing for airports without an FAA match (handled by the missing-data policy, never scored as 0).',
  },
  {
    id: 'taxiOut', label: 'Median taxi-out time', pillar: 'strain', unit: 'minutes (latest aligned months)', source: 'BTS On-Time Performance', defaultWeight: 10,
    formula: 'median of TAXI_OUT over all departures in the aligned months (exact, from merged histograms)',
    why: 'Long taxi-out times are a recognised sign of airfield congestion.',
    caveat: 'Depends on airport layout as well as traffic, covers summer months only, and is excluded where on-time data covers under 50% of scheduled passenger departures.',
  },
  {
    id: 'departureDelay', label: 'Departures delayed 15+ minutes', pillar: 'context', unit: 'percent of departures', source: 'BTS On-Time Performance', defaultWeight: 0,
    formula: 'departures with DEP_DEL15=1 / departures with a recorded delay',
    why: 'Operational reliability context for analysts.',
    caveat: 'Default weight 0: delays are driven mostly by weather, airline and air-traffic-system causes rather than airport infrastructure. Enable by giving it a weight.',
  },
];

export const METHOD_NOTES: readonly string[] = [
  'Each metric is converted to a percentile position (0-100) among the candidate airports; ties share the average position. Order matters, magnitude does not, so outliers cannot dominate.',
  'Score = sum over metrics of (weight / sum of weights of metrics available for that airport) x percentile. The contribution of every metric is returned, and contributions add up to the score.',
  'A metric an airport lacks is removed and the remaining weights are re-scaled; it is never treated as 0. An airport is scored only if at least 60% of the configured weight is available; otherwise it is listed as unscored with the reason.',
  'The score is relative to the candidate set. Adding or removing airports changes scores and ranks; scores from different candidate sets cannot be compared.',
  'Metrics whose percentile ranks correlate at 0.7 or more with another weighted metric (within the candidate set) are divided by (1 + sum of those correlations), so shared signal is not counted twice. Contributions show both the configured weight and this factor.',
  'Ranking sensitivity is reported: the range of ranks across equal weights and across dropping each metric in turn.',
  'Growth and load factor use 12-month windows (seasonality-neutral). Operational metrics use the aligned summer months (June-August), which are seasonally busy, so they compare airports with each other, not seasons.',
  'Missing metrics: by default an airport lacking a metric receives the neutral 50th percentile for it, so missing data does not systematically help or hurt; each airport reports score bounds (missing metrics at the bottom or top) and its rank under the alternative policy of redistributing the weight.',
  'Opportunity is not profitability: no revenue, cost, financing, regulatory or competitive data is used.',
];

export interface ScoringConfig {
  /** Overrides for default weights (0 disables a metric). Must be finite and non-negative. */
  readonly weights?: Partial<Record<MetricId, number>>;
  /** Candidates below this many passengers in the latest 12 months are reported as excluded. Default 100,000. */
  readonly minPassengers?: number;
  /** Minimum share of configured weight an airport needs to be scored. Default 0.6. */
  readonly minWeightCoverage?: number;
  /** Pseudo-count k for growth shrinkage, in passengers/seats. Default 250,000. */
  readonly shrinkagePseudoCount?: number;
  /** Number of airports to return in `ranked` (all scored airports are still scored). */
  readonly topN?: number;
  /** Down-weight metrics that are highly correlated with other weighted metrics (default true). */
  readonly correlationAdjustment?: boolean;
  /**
   * How a metric an airport lacks is handled. 'neutral' (default) uses the 50th percentile for it, so incomplete data neither
   * helps nor hurts on average; 'redistribute' moves its weight onto the metrics the airport does have, which favours airports
   * that look good on what they report. Neither treats missing data as zero.
   */
  readonly missingDataPolicy?: 'neutral' | 'redistribute';
}

/** Pairs of weighted metrics whose percentile correlation is at least this are treated as partly the same signal. */
export const CORRELATION_THRESHOLD = 0.7;
/** Correlations from fewer eligible airports than this are too noisy to act on. */
const MIN_AIRPORTS_FOR_CORRELATION = 8;

export interface Contribution {
  readonly metric: MetricId;
  readonly label: string;
  readonly pillar: Pillar;
  readonly unit: string;
  /** Undefined when the airport lacks this metric and a neutral value was used in its place. */
  readonly raw: number | undefined;
  /** True when the metric was missing and the neutral 50th percentile was used (missingDataPolicy 'neutral'). */
  readonly imputed: boolean;
  readonly percentile: number;
  readonly configuredWeight: number;
  /** Multiplier (<= 1) applied because this metric is highly correlated with other weighted metrics; 1 means none. */
  readonly correlationFactor: number;
  /** Weight after re-scaling to the metrics this airport has, in percent. */
  readonly effectiveWeight: number;
  /** effectiveWeight x percentile / 100; contributions sum to the score. */
  readonly points: number;
}

export interface RankedAirport {
  readonly rank: number;
  readonly code: string;
  readonly name: string | undefined;
  readonly city: string | undefined;
  readonly state: string | undefined;
  readonly score: number;
  readonly contributions: readonly Contribution[];
  readonly pillarPoints: Readonly<Record<Pillar, number>>;
  readonly evidence: Evidence;
  /** Data coverage, reported separately from the score. */
  readonly coverage: Coverage;
  /** The score if every missing metric were at the bottom (low) or the top (high) of the candidate set. Equal to the score when nothing is missing. */
  readonly scoreBounds: { readonly low: number; readonly high: number };
  /** Best and worst rank across the sensitivity scenarios. */
  readonly rankRange: { readonly best: number; readonly worst: number };
  readonly flags: readonly string[];
}

export interface Evidence {
  readonly passengersLatest12m: number | undefined;
  readonly passengersPrior12m: number | undefined;
  readonly passengerGrowthPct: number | undefined;
  readonly seatGrowthPct: number | undefined;
  readonly loadFactorPct: number | undefined;
  readonly passengerVsSeatGapPoints: number | undefined;
  readonly departuresLatest12m: number | undefined;
  readonly commercialRunways: number | undefined;
  readonly departuresPerRunwayDay: number | undefined;
  readonly medianTaxiOutMin: number | undefined;
  readonly departureDelayRatePct: number | undefined;
  readonly cancellationRatePct: number | undefined;
  readonly nonstopDestinations: number | undefined;
}

export interface Coverage {
  /** Share of configured weight that had data for this airport (1 = every weighted metric available). */
  readonly weightCoverage: number;
  readonly missing: ReadonlyArray<{ metric: MetricId; reason: string }>;
  readonly onTimeCoverage: number | undefined;
  readonly faaMatched: boolean;
}

export interface UnscoredAirport {
  readonly code: string;
  readonly name: string | undefined;
  readonly state: string | undefined;
  readonly reason: string;
  readonly weightCoverage: number | undefined;
}

export interface OpportunityRanking {
  readonly missingDataPolicy: 'neutral' | 'redistribute';
  /** The exact periods behind each family of metric, so comparisons across runs or airports are never ambiguous. */
  readonly periods: { readonly passengerWindow: { from: string; to: string } | undefined; readonly baselineWindow: { from: string; to: string } | undefined; readonly windowMonths: number; readonly operationalMonths: readonly string[]; readonly notes: readonly string[] };
  readonly readingGuide: readonly string[];
  /** Per-metric multipliers applied to avoid double counting correlated metrics (empty when disabled or not needed). */
  readonly correlationAdjustments: ReadonlyArray<{ metric: MetricId; factor: number; correlatedWith: ReadonlyArray<{ metric: MetricId; correlation: number }>; explanation: string }>;
  readonly asOf: string;
  readonly windowMonths: number;
  readonly operationalMonths: readonly string[];
  readonly weights: Readonly<Record<MetricId, number>>;
  readonly definitions: readonly MetricDefinition[];
  readonly method: readonly string[];
  readonly candidateSet: { readonly considered: number; readonly eligible: number; readonly scored: number; readonly unscored: number; readonly excluded: number };
  readonly ranked: readonly RankedAirport[];
  readonly unscored: readonly UnscoredAirport[];
  readonly excluded: ReadonlyArray<{ code: string; name: string | undefined; reason: string }>;
  readonly diagnostics: {
    readonly highlyCorrelatedMetrics: ReadonlyArray<{ a: MetricId; b: MetricId; correlation: number }>;
    readonly rankStabilityVsEqualWeights: number | undefined;
  };
  readonly warnings: readonly string[];
}

export const READING_GUIDE: readonly string[] = [
  'A high score means demand is large and growing and existing aircraft seats, runways and taxiways look heavily used relative to other candidates.',
  'It is a screening shortlist for further diligence. It is not evidence that a terminal is capacity-constrained: no gate, check-in, security, baggage or terminal-area data is used, and runway or taxi metrics describe the airfield, not the terminal.',
  'It is not a forecast, and not a profitability or return estimate.',
];

const label = (id: MetricId): string => METRIC_DEFINITIONS.find((d) => d.id === id)?.label ?? id;
function explainAdjustment(metric: MetricId, factor: number, links: ReadonlyArray<{ metric: MetricId; correlation: number }>): string {
  return `${label(metric)} counts at ${(factor * 100).toFixed(0)}% of its configured weight because across these airports it moves with ${links.map((l) => `${label(l.metric)} (rank correlation ${l.correlation})`).join(' and ')}, so part of its signal is already counted.`;
}

function periodsOf(m: AirportMetrics | undefined): OpportunityRanking['periods'] {
  const t = m?.traffic;
  return {
    passengerWindow: t ? { from: t.current.from, to: t.current.to } : undefined,
    baselineWindow: t ? { from: t.baseline.from, to: t.baseline.to } : undefined,
    windowMonths: t?.windowMonths ?? 12,
    operationalMonths: m?.operations.months ?? [],
    notes: [
      'Passenger, seat, departure and load-factor metrics cover the passenger window and are compared with the baseline window of equal length, so growth is seasonally matched.',
      'Taxi-out and delay metrics cover only the operational months (a different, shorter and seasonally busy period). They rank airports against each other within those months and say nothing about the rest of the year.',
      'Rankings produced for a different as-of month or window are not comparable with this one.',
    ],
  };
}

const DEFAULTS = { minPassengers: 100_000, minWeightCoverage: 0.6, shrinkagePseudoCount: 250_000 };

export function resolveWeights(overrides: Partial<Record<MetricId, number>> = {}): Record<MetricId, number> {
  const known = new Set(METRIC_DEFINITIONS.map((d) => d.id));
  for (const [k, v] of Object.entries(overrides)) {
    if (!known.has(k as MetricId)) throw new RangeError(`unknown metric "${k}"; valid metrics: ${[...known].join(', ')}`);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new RangeError(`weight for ${k} must be a finite number >= 0`);
  }
  const out = Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, overrides[d.id] ?? d.defaultWeight])) as Record<MetricId, number>;
  if (Object.values(out).every((w) => w === 0)) throw new RangeError('at least one metric needs a weight above 0');
  return out;
}

interface Raw {
  readonly values: Record<MetricId, number | undefined>;
  readonly missing: Record<MetricId, string | undefined>;
  readonly weightOnPrior: number | undefined;
}

function extract(m: AirportMetrics, prior: { pax: number; seats: number }, k: number): Raw {
  const t = m.traffic;
  const missing: Partial<Record<MetricId, string>> = {};
  const values: Partial<Record<MetricId, number>> = {};
  const incomplete = t.issues[0] ?? 'traffic window incomplete';

  if (t.current.passengers !== undefined) values.scale = t.current.passengers;
  else missing.scale = incomplete;

  const paxBase = t.baseline.passengers;
  const seatBase = t.baseline.seats;
  let weightOnPrior: number | undefined;
  let shrunkPax: number | undefined;
  let shrunkSeats: number | undefined;
  if (t.passengers.pct !== undefined && paxBase !== undefined && paxBase > 0) {
    shrunkPax = shrink(t.passengers.pct, paxBase, k, prior.pax);
    weightOnPrior = k / (paxBase + k);
    values.momentum = shrunkPax * 100;
  } else missing.momentum = t.issues.length ? incomplete : 'prior-year passengers are zero or missing';
  if (t.seats.pct !== undefined && seatBase !== undefined && seatBase > 0) shrunkSeats = shrink(t.seats.pct, seatBase, k, prior.seats);
  if (shrunkPax !== undefined && shrunkSeats !== undefined) values.capacityGap = (shrunkPax - shrunkSeats) * 100;
  else missing.capacityGap = t.issues.length ? incomplete : 'seat counts missing or zero';

  if (t.loadFactor.current !== undefined) values.loadFactor = t.loadFactor.current * 100;
  else missing.loadFactor = 'seats missing or zero';

  if (m.departuresPerRunwayDay !== undefined) values.runwayLoad = m.departuresPerRunwayDay;
  else missing.runwayLoad = !m.faaMatched ? 'no FAA match (runways unknown)' : m.runway && m.runway.commercialRunways === 0 ? 'no runway of 5,000 ft or more on record' : 'departures missing';

  const d = m.operations.derived;
  if (m.operations.reliable && d?.medianTaxiOutMin !== undefined) values.taxiOut = d.medianTaxiOutMin;
  else missing.taxiOut = opsReason(m);
  if (m.operations.reliable && d?.departureDelayRate15 !== undefined) values.departureDelay = d.departureDelayRate15 * 100;
  else missing.departureDelay = opsReason(m);

  return { values: values as Record<MetricId, number | undefined>, missing: missing as Record<MetricId, string | undefined>, weightOnPrior };
}

function opsReason(m: AirportMetrics): string {
  const o = m.operations;
  if (!o.available) return 'no on-time data for this airport';
  if (!o.reliable) return o.coverage.ratio === undefined ? 'on-time coverage cannot be judged' : `on-time data covers only ${(o.coverage.ratio * 100).toFixed(0)}% of scheduled passenger departures`;
  return 'metric not reported';
}

const num = (v: number | undefined, f = 1): number | undefined => (v === undefined ? undefined : Number(v.toFixed(f)));

interface Scored {
  readonly bounds?: { low: number; high: number };
  readonly m: AirportMetrics;
  readonly raw: Raw;
  readonly score: number | undefined;
  readonly contributions: Contribution[];
  readonly weightCoverage: number;
}

type Factors = Record<MetricId, number>;
const NO_ADJUSTMENT = Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, 1])) as Factors;
type Links = Map<MetricId, Array<{ metric: MetricId; correlation: number }>>;

/**
 * Each weighted metric is divided by (1 + sum of |correlation| with the other weighted metrics it correlates with at
 * |rho| >= 0.7), so two metrics carrying the same signal share roughly one metric's weight instead of counting twice.
 */
function correlationFactors(percentiles: ReadonlyMap<MetricId, Array<number | undefined>>, weights: Record<MetricId, number>, airports: number): { factors: Factors; links: Links } {
  const factors: Factors = { ...NO_ADJUSTMENT };
  const links: Links = new Map();
  if (airports < MIN_AIRPORTS_FOR_CORRELATION) return { factors, links };
  const active = METRIC_DEFINITIONS.filter((d) => weights[d.id] > 0);
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = (active[i] as MetricDefinition).id;
      const b = (active[j] as MetricDefinition).id;
      const r = pearson(percentiles.get(a) ?? [], percentiles.get(b) ?? []);
      if (r === undefined || Math.abs(r) < CORRELATION_THRESHOLD) continue;
      links.set(a, [...(links.get(a) ?? []), { metric: b, correlation: Number(r.toFixed(2)) }]);
      links.set(b, [...(links.get(b) ?? []), { metric: a, correlation: Number(r.toFixed(2)) }]);
    }
  }
  for (const [metric, list] of links) factors[metric] = 1 / (1 + list.reduce((sum, l) => sum + Math.abs(l.correlation), 0));
  return { factors, links };
}

function scoreSet(
  eligible: readonly { m: AirportMetrics; raw: Raw }[],
  percentiles: ReadonlyMap<MetricId, Array<number | undefined>>,
  weights: Record<MetricId, number>,
  minCoverage: number,
  factors: Factors = NO_ADJUSTMENT,
  policy: 'neutral' | 'redistribute' = 'neutral',
): Scored[] {
  const totalWeight = METRIC_DEFINITIONS.reduce((sum, d) => sum + weights[d.id], 0);
  const used = (id: MetricId): number => weights[id] * factors[id];
  const active = METRIC_DEFINITIONS.filter((d) => weights[d.id] > 0);
  return eligible.map(({ m, raw }, i) => {
    const known = active.filter((d) => percentiles.get(d.id)?.[i] !== undefined);
    const knownConfigured = known.reduce((sum, d) => sum + weights[d.id], 0);
    const knownWeight = known.reduce((sum, d) => sum + used(d.id), 0);
    const weightCoverage = totalWeight > 0 ? knownConfigured / totalWeight : 0;
    if (knownWeight === 0 || weightCoverage < minCoverage) return { m, raw, score: undefined, contributions: [], weightCoverage };
    // 'neutral' keeps every weighted metric in play and fills the gaps with the median position; 'redistribute' drops them.
    const pool = policy === 'neutral' ? active : known;
    const poolWeight = pool.reduce((sum, d) => sum + used(d.id), 0);
    const contributions: Contribution[] = pool.map((d) => {
      const own = percentiles.get(d.id)?.[i];
      const pct = own ?? 50;
      const eff = (used(d.id) / poolWeight) * 100;
      return { metric: d.id, label: d.label, pillar: d.pillar, unit: d.unit, raw: own === undefined ? undefined : raw.values[d.id], imputed: own === undefined, percentile: pct, configuredWeight: weights[d.id], correlationFactor: factors[d.id], effectiveWeight: eff, points: (eff * pct) / 100 };
    });
    const bound = (fill: number): number => contributions.reduce((sum, c) => sum + (c.effectiveWeight * (c.imputed ? fill : c.percentile)) / 100, 0);
    return { m, raw, score: contributions.reduce((sum, c) => sum + c.points, 0), contributions, weightCoverage, bounds: { low: bound(0), high: bound(100) } };
  });
}

/** Deterministic order: score, then larger passenger base, then airport code. */
const byScore = (a: Scored, b: Scored): number =>
  (b.score as number) - (a.score as number) || (b.m.traffic.current.passengers ?? 0) - (a.m.traffic.current.passengers ?? 0) || a.m.code.localeCompare(b.m.code);

function rankMap(scored: readonly Scored[]): Map<string, number> {
  return new Map(scored.filter((s) => s.score !== undefined).sort(byScore).map((s, i) => [s.m.code, i + 1]));
}

export function rankOpportunities(metrics: readonly AirportMetrics[], config: ScoringConfig = {}): OpportunityRanking {
  const weights = resolveWeights(config.weights);
  const minPassengers = config.minPassengers ?? DEFAULTS.minPassengers;
  const minCoverage = config.minWeightCoverage ?? DEFAULTS.minWeightCoverage;
  const k = config.shrinkagePseudoCount ?? DEFAULTS.shrinkagePseudoCount;
  const first = metrics[0];
  const excluded: Array<{ code: string; name: string | undefined; reason: string }> = [];
  const unscored: UnscoredAirport[] = [];
  const warnings: string[] = [];

  const hasWindow = (m: AirportMetrics) => m.traffic.current.complete && m.traffic.current.passengers !== undefined;
  const eligibleMetrics: AirportMetrics[] = [];
  for (const m of metrics) {
    if (!hasWindow(m)) {
      const cur = m.traffic.current;
      if (cur.monthsPresent === 0) excluded.push({ code: m.code, name: m.name, reason: 'no passenger data in the analysis window' });
      else if (cur.passengersPresent < minPassengers) excluded.push({ code: m.code, name: m.name, reason: `reported activity in only ${cur.monthsPresent} of ${m.traffic.windowMonths} months and ${cur.passengersPresent.toLocaleString('en-US')} passengers: below the ${minPassengers.toLocaleString('en-US')} threshold` });
      else unscored.push({ code: m.code, name: m.name, state: m.state, reason: m.traffic.issues[0] ?? 'incomplete passenger data', weightCoverage: undefined });
      continue;
    }
    const pax = m.traffic.current.passengers as number;
    if (pax < minPassengers) excluded.push({ code: m.code, name: m.name, reason: `${pax.toLocaleString('en-US')} passengers in the latest 12 months, below the ${minPassengers.toLocaleString('en-US')} threshold` });
    else eligibleMetrics.push(m);
  }

  // Shrinkage prior: the candidate-set median growth (zero if there is nothing to take a median of).
  const prior = {
    pax: median(eligibleMetrics.map((m) => m.traffic.passengers.pct).filter((v): v is number => v !== undefined)) ?? 0,
    seats: median(eligibleMetrics.map((m) => m.traffic.seats.pct).filter((v): v is number => v !== undefined)) ?? 0,
  };
  const eligible = eligibleMetrics.map((m) => ({ m, raw: extract(m, prior, k) }));
  const percentiles = new Map<MetricId, Array<number | undefined>>(METRIC_DEFINITIONS.map((d) => [d.id, percentileRanks(eligible.map((e) => e.raw.values[d.id]))]));

  const useAdjustment = config.correlationAdjustment !== false;
  const adjust = (w: Record<MetricId, number>): { factors: Factors; links: Links } => (useAdjustment ? correlationFactors(percentiles, w, eligible.length) : { factors: NO_ADJUSTMENT, links: new Map() });
  const policy = config.missingDataPolicy ?? 'neutral';
  const main = adjust(weights);
  const base = scoreSet(eligible, percentiles, weights, minCoverage, main.factors, policy);
  for (const s of base) {
    if (s.score === undefined) unscored.push({ code: s.m.code, name: s.m.name, state: s.m.state, reason: `only ${(s.weightCoverage * 100).toFixed(0)}% of the configured weight has data (minimum ${(minCoverage * 100).toFixed(0)}%)`, weightCoverage: s.weightCoverage });
  }
  const scored = base.filter((s) => s.score !== undefined).sort(byScore);
  const ranks = rankMap(base);

  // Sensitivity: equal weights, and dropping each weighted metric in turn.
  const active = METRIC_DEFINITIONS.filter((d) => weights[d.id] > 0);
  const equalWeights = Object.fromEntries(METRIC_DEFINITIONS.map((d) => [d.id, weights[d.id] > 0 ? 1 : 0])) as Record<MetricId, number>;
  const scenarios: Array<{ w: Record<MetricId, number>; policy: 'neutral' | 'redistribute' }> = [
    { w: equalWeights, policy },
    ...(active.length > 1 ? active.map((drop) => ({ w: { ...weights, [drop.id]: 0 } as Record<MetricId, number>, policy })) : []),
    { w: weights, policy: policy === 'neutral' ? 'redistribute' : 'neutral' },
  ];
  const scenarioRanks = scenarios.map(({ w, policy: pol }) => rankMap(scoreSet(eligible, percentiles, w, minCoverage, adjust(w).factors, pol)));
  const equalRanks = scenarioRanks[0] as Map<string, number>;
  const rankRange = (code: string) => {
    const all = [ranks.get(code) as number, ...scenarioRanks.map((r) => r.get(code)).filter((r): r is number => r !== undefined)];
    return { best: Math.min(...all), worst: Math.max(...all) };
  };
  const stability = pearson(scored.map((s) => ranks.get(s.m.code)), scored.map((s) => equalRanks.get(s.m.code)));

  // Correlated metrics would double count the same signal; surface them rather than hide them.
  const correlated: Array<{ a: MetricId; b: MetricId; correlation: number }> = [];
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const a = active[i] as MetricDefinition;
      const b = active[j] as MetricDefinition;
      const r = pearson(percentiles.get(a.id) ?? [], percentiles.get(b.id) ?? []);
      if (r !== undefined && Math.abs(r) >= 0.7) correlated.push({ a: a.id, b: b.id, correlation: Number(r.toFixed(2)) });
    }
  }

  const handled = policy === 'neutral' ? 'the neutral 50th percentile was used for it (see scoreBounds)' : 'its weight was redistributed to its other metrics';
  if (eligible.length < 8) warnings.push(`Only ${eligible.length} airports are eligible, so percentile scores are coarse. Treat the ranking as a rough ordering.`);
  if (correlated.length > 0) warnings.push(useAdjustment ? `Correlated metrics (${correlated.map((c) => `${c.a}/${c.b} ${c.correlation}`).join(', ')}) were down-weighted so the same signal is not counted twice; see correlationAdjustments.` : `Weighted metrics that move together (${correlated.map((c) => `${c.a}/${c.b} ${c.correlation}`).join(', ')}) partly count the same signal; correlation adjustment is off.`);
  if (scored.some((s) => !s.m.faaMatched)) warnings.push(`Some scored airports have no FAA match; their runway metric is missing and ${handled}.`);
  if (scored.some((s) => s.raw.missing.taxiOut !== undefined)) warnings.push(`Taxi-out time is missing for some airports because on-time coverage is weak or absent; ${handled}.`);
  warnings.push('Scores rank airports against each other in this candidate set; they are not absolute and not a measure of profitability.');

  const ranked: RankedAirport[] = scored.slice(0, config.topN ?? scored.length).map((s) => {
    const m = s.m;
    const pillarPoints = { demand: 0, tightness: 0, strain: 0, context: 0 } as Record<Pillar, number>;
    for (const c of s.contributions) pillarPoints[c.pillar] += c.points;
    const flags: string[] = [];
    if (!m.faaMatched) flags.push('no FAA match: runway data unavailable');
    if (!m.operations.available) flags.push('no on-time data');
    else if (!m.operations.reliable) flags.push('weak on-time coverage: delay and taxi-out excluded');
    if (s.raw.weightOnPrior !== undefined && s.raw.weightOnPrior > 0.2) flags.push(`small base: growth shrunk ${(s.raw.weightOnPrior * 100).toFixed(0)}% toward the candidate median`);
    const t = m.traffic;
    const d = m.operations.derived;
    return {
      rank: ranks.get(m.code) as number, code: m.code, name: m.name, city: m.city, state: m.state, score: s.score as number,
      contributions: s.contributions, pillarPoints, scoreBounds: { low: (s.bounds as { low: number }).low, high: (s.bounds as { high: number }).high },
      evidence: {
        passengersLatest12m: t.current.passengers, passengersPrior12m: t.baseline.passengers,
        passengerGrowthPct: num(t.passengers.pct === undefined ? undefined : t.passengers.pct * 100),
        seatGrowthPct: num(t.seats.pct === undefined ? undefined : t.seats.pct * 100),
        loadFactorPct: num(t.loadFactor.current === undefined ? undefined : t.loadFactor.current * 100),
        passengerVsSeatGapPoints: num(t.passengerVsSeatGrowthPoints),
        departuresLatest12m: t.current.departures, commercialRunways: m.runway?.commercialRunways,
        departuresPerRunwayDay: num(m.departuresPerRunwayDay), medianTaxiOutMin: d?.medianTaxiOutMin,
        departureDelayRatePct: num(d?.departureDelayRate15 === undefined ? undefined : d.departureDelayRate15 * 100),
        cancellationRatePct: num(d?.cancellationRate === undefined ? undefined : d.cancellationRate * 100),
        nonstopDestinations: m.network?.destinations,
      },
      coverage: {
        weightCoverage: s.weightCoverage,
        missing: METRIC_DEFINITIONS.filter((def) => weights[def.id] > 0 && s.raw.values[def.id] === undefined).map((def) => ({ metric: def.id, reason: s.raw.missing[def.id] ?? 'missing' })),
        onTimeCoverage: m.operations.coverage.ratio, faaMatched: m.faaMatched,
      },
      rankRange: rankRange(m.code), flags,
    };
  });

  return {
    asOf: first?.traffic.current.to ?? '',
    windowMonths: first?.traffic.windowMonths ?? 12,
    operationalMonths: first?.operations.months ?? [],
    missingDataPolicy: policy,
    periods: periodsOf(first),
    readingGuide: READING_GUIDE,
    correlationAdjustments: [...main.links.entries()].map(([metric, list]) => ({ metric, factor: Number(main.factors[metric].toFixed(3)), correlatedWith: list, explanation: explainAdjustment(metric, main.factors[metric], list) })),
    weights, definitions: METRIC_DEFINITIONS, method: METHOD_NOTES,
    candidateSet: { considered: metrics.length, eligible: eligible.length, scored: scored.length, unscored: unscored.length, excluded: excluded.length },
    ranked, unscored, excluded,
    diagnostics: { highlyCorrelatedMetrics: correlated, rankStabilityVsEqualWeights: stability === undefined ? undefined : Number(stability.toFixed(2)) },
    warnings,
  };
}
