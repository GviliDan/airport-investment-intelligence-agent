import type { ToolOutput } from '../tools/index.js';

const MAX_ARGS_CHARS = 420;
const sig = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? String(Number(n.toPrecision(4))) : String(n));

interface Row { code?: string; airport?: string; rank?: number; score?: number }

/**
 * One line describing a tool call for the conversation memory: what was asked (arguments) and what came back in outline.
 * Earlier tool outputs are not replayed in full; the model re-calls a tool when it needs exact figures again, so the numbers
 * it quotes always come from a fresh, current result.
 */
export function digestCall(tool: string, args: unknown, output: ToolOutput): string {
  const a = JSON.stringify(args ?? {});
  const head = `${tool}(${a.length > MAX_ARGS_CHARS ? `${a.slice(0, MAX_ARGS_CHARS)}...` : a})`;
  if (!output.ok) {
    const c = output.error.candidates?.flatMap((x) => x.options.map((o) => o.code)).join(', ');
    return `${head} -> ERROR ${output.error.code}: ${output.error.message}${c ? ` Options: ${c}.` : ''}`;
  }
  const d = output.data as Record<string, unknown>;
  const list = (rows: unknown, take = 12): string => (Array.isArray(rows) ? rows.slice(0, take).map((r: Row) => r.code ?? r.airport ?? '?').join(', ') : '');
  switch (tool) {
    case 'rank_expansion_opportunities': {
      const rk = d.ranking as { ranked: Array<{ rank: number; code: string; score: number }>; weights: Record<string, number>; missingDataPolicy: string; correlationAdjustments: unknown[]; candidateSet: { eligible: number } };
      const top = rk.ranked.slice(0, 10).map((r) => `${r.rank}.${r.code} ${sig(r.score)}`).join('; ');
      return `${head} -> scope "${d.scope}", ${rk.candidateSet.eligible} candidates, weights ${JSON.stringify(rk.weights)}, missing-data ${rk.missingDataPolicy}; ranked: ${top}`;
    }
    case 'screen_airports':
      return `${head} -> scope "${d.scope}", rows: ${list(d.rows, 15)}${output.page ? ` (total ${output.page.total})` : ''}`;
    case 'find_airports':
      return `${head} -> scope "${d.scope}", airports: ${list(d.airports, 20)}${output.page ? ` (total ${output.page.total})` : ''}`;
    case 'resolve_airport': {
      const r = d as { status: string; airport?: { code: string }; candidates?: Array<{ code: string }>; suggested?: string };
      return `${head} -> ${r.status}${r.airport ? ` ${r.airport.code}` : ''}${r.candidates ? `: ${r.candidates.map((c) => c.code).join(', ')}` : ''}${r.suggested ? ` (busiest: ${r.suggested})` : ''}`;
    }
    case 'get_long_haul_share': {
      const r = d as { origin: string; thresholdMiles: number; share?: number; classes: string[]; totalDepartures: number };
      return `${head} -> ${r.origin} threshold ${r.thresholdMiles} mi, classes ${r.classes.join('')}, share ${r.share === undefined ? 'n/a' : sig(r.share)} of ${r.totalDepartures} departures`;
    }
    case 'compare_operations':
    case 'get_traffic_metrics':
    case 'get_airport_infrastructure': {
      const rows = (d.airports as Array<{ code?: string; airport?: string }>) ?? [];
      return `${head} -> airports ${rows.map((r) => r.code ?? r.airport).join(', ')}`;
    }
    case 'analyze_demand_pressure':
      return `${head} -> ${String(d.airport)}; standouts: ${((d.standouts as string[]) ?? []).join(', ') || 'none'}; unmet demand not measurable`;
    case 'search_routes':
      return `${head} -> ${Array.isArray(d.routes) ? d.routes.length : 0} routes${output.page ? ` of ${output.page.total}` : ''}`;
    default:
      return `${head} -> ok`;
  }
}
