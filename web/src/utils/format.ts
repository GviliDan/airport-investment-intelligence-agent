export const DASH = '—';

export const int = (n: number | undefined | null): string => (n === undefined || n === null || !Number.isFinite(n) ? DASH : Math.round(n).toLocaleString('en-US'));
export const num = (n: number | undefined | null, d = 1): string => (n === undefined || n === null || !Number.isFinite(n) ? DASH : n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
/** A fraction (0.2415) as a percentage ("24.2%"). */
export const fracPct = (f: number | undefined | null, d = 1): string => (f === undefined || f === null || !Number.isFinite(f) ? DASH : `${(f * 100).toFixed(d)}%`);
/** A value already in percent units (24.15) as "24.2%". */
export const pct = (p: number | undefined | null, d = 1): string => (p === undefined || p === null || !Number.isFinite(p) ? DASH : `${p.toFixed(d)}%`);
export const signed = (n: number | undefined | null, d = 1, unit = ''): string => (n === undefined || n === null || !Number.isFinite(n) ? DASH : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(d)}${unit}`);

/** 1,234,567 -> "1.2M"; 23,400 -> "23K". */
export function compact(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
  return String(Math.round(n));
}

export const monthLabel = (m: string): string => {
  const [y, mm] = m.split('-');
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return y && mm ? `${names[Number(mm) - 1] ?? mm} ${y}` : m;
};

/** "2025-09..2026-08" -> "Sep 2025 to Aug 2026"; other text is returned unchanged. */
export const periodLabel = (p: string): string => {
  const range = /^(\d{4}-\d{2})\.\.(\d{4}-\d{2})$/.exec(p);
  if (range) return `${monthLabel(range[1] as string)} to ${monthLabel(range[2] as string)}`;
  // A list of months such as "2026-06, 2026-07, 2026-08" reads better as a range.
  const months = p.split(',').map((x) => x.trim());
  if (months.length > 1 && months.every((x) => /^\d{4}-\d{2}$/.test(x))) return `${monthLabel(months[0] as string)} to ${monthLabel(months.at(-1) as string)}`;
  return p;
};

const LABELS: Record<string, string> = {
  resolve_airport: 'Looking up the airport',
  find_airports: 'Listing airports in scope',
  get_traffic_metrics: 'Reading passenger and seat data',
  screen_airports: 'Screening airports',
  compare_operations: 'Comparing operations',
  get_route_network: 'Reading the route network',
  search_routes: 'Searching routes',
  get_long_haul_share: 'Measuring long-haul share',
  get_airport_infrastructure: 'Reading runway data',
  analyze_demand_pressure: 'Analyzing demand pressure',
  rank_expansion_opportunities: 'Ranking expansion candidates',
  get_current_faa_disruptions: 'Checking live FAA status',
  get_methodology: 'Reading the methodology',
};
export const toolLabel = (tool: string): string => LABELS[tool] ?? tool.replaceAll('_', ' ');

const TITLES: Record<string, string> = {
  resolve_airport: 'Airport lookup',
  find_airports: 'Airports in scope',
  get_traffic_metrics: 'Passenger and seat trends',
  screen_airports: 'Airport screen',
  compare_operations: 'Operations comparison',
  get_route_network: 'Route network',
  search_routes: 'Routes',
  get_long_haul_share: 'Long-haul share',
  get_airport_infrastructure: 'Infrastructure',
  analyze_demand_pressure: 'Demand pressure indicators',
  rank_expansion_opportunities: 'Expansion screening ranking',
  get_current_faa_disruptions: 'Current FAA disruptions',
  get_methodology: 'Methodology',
};
export const toolTitle = (tool: string): string => TITLES[tool] ?? toolLabel(tool);

/** One-line description of tool arguments for the "what was run" list. */
export function describeArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  return Object.entries(args as Record<string, unknown>)
    .map(([k, v]) => `${k.replaceAll('_', ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('; ');
}
