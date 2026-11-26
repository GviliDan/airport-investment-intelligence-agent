import type { ReactNode } from 'react';
import type { ToolSuccess } from '@/types';
import { LongHaulCard, OperationsCard, PressureCard } from './InsightCards';
import { RankingCard } from './RankingCard';
import { AirportsCard, DisruptionsCard, InfrastructureCard, MethodologyCard, NetworkCard, ResolveCard, RoutesCard, ScreenCard, TrafficCard } from './TableCards';

/** Which card draws which tool's result. A new tool needs one entry here and one card. */
export const InsightCardsMap: Record<string, (p: { o: ToolSuccess }) => ReactNode> = {
  rank_expansion_opportunities: RankingCard,
  screen_airports: ScreenCard,
  find_airports: AirportsCard,
  resolve_airport: ResolveCard,
  get_traffic_metrics: TrafficCard,
  compare_operations: OperationsCard,
  get_route_network: NetworkCard,
  search_routes: RoutesCard,
  get_long_haul_share: LongHaulCard,
  get_airport_infrastructure: InfrastructureCard,
  analyze_demand_pressure: PressureCard,
  get_current_faa_disruptions: DisruptionsCard,
  get_methodology: MethodologyCard,
};
