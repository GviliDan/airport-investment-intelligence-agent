/** Score metrics in a fixed order, so a metric keeps its colour in every chart and legend. */
export const METRIC_ORDER = ['scale', 'momentum', 'loadFactor', 'capacityGap', 'runwayLoad', 'taxiOut', 'departureDelay'] as const;
export type MetricId = (typeof METRIC_ORDER)[number];

export const METRIC_SHORT: Record<string, string> = {
  scale: 'Scale',
  momentum: 'Growth',
  loadFactor: 'Load factor',
  capacityGap: 'Demand vs seats',
  runwayLoad: 'Runway use',
  taxiOut: 'Taxi-out',
  departureDelay: 'Delays',
};

/** CSS variable holding the chart colour for a metric (defined for light and dark in globals.css). */
export const metricColor = (id: string): string => `var(--chart-${Math.max(0, METRIC_ORDER.indexOf(id as MetricId)) + 1})`;
