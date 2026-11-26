import type { BtsSocrataClient, MonthlyTraffic } from './btsSocrata.js';
import { ProviderError } from './errors.js';
import type { Month, Provenance, Sourced } from './types.js';

export type TrafficMode = 'live' | 'snapshot' | 'snapshot-fallback';

export interface TrafficResult extends Sourced<MonthlyTraffic[]> {
  /** How the rows were obtained. `snapshot-fallback` means the live API failed and the committed snapshot was used instead. */
  readonly mode: TrafficMode;
  /** Why the live call was not used, when it was not. */
  readonly liveError?: string;
}

export interface TrafficProviderOptions {
  readonly live: Pick<BtsSocrataClient, 'monthlyTraffic'>;
  /** Rows from the committed snapshot (data/processed/traffic-monthly.csv.gz). */
  readonly snapshot: readonly MonthlyTraffic[];
  /** Set false to read only the snapshot (offline use and tests); default is live first. */
  readonly useLive?: boolean;
  readonly snapshotGeneratedAt?: string;
}

/**
 * Monthly traffic for a set of airports. The BTS Socrata API is the primary source at runtime. The committed snapshot is
 * used only when the API fails, and the result says so, so a fallback is never mistaken for fresh data.
 */
export class TrafficProvider {
  constructor(private readonly opts: TrafficProviderOptions) {}

  /** `airports` undefined means every airport (one request; used when a list would be too long for a URL). */
  async monthly(airports: readonly string[] | undefined, from: Month, to: Month): Promise<TrafficResult> {
    if (this.opts.useLive !== false) {
      try {
        const live = await this.opts.live.monthlyTraffic({ ...(airports ? { airports } : {}), from, to });
        return { ...live, mode: 'live' };
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        return this.fromSnapshot(airports, from, to, 'snapshot-fallback', err.message);
      }
    }
    return this.fromSnapshot(airports, from, to, 'snapshot');
  }

  private fromSnapshot(airports: readonly string[] | undefined, from: Month, to: Month, mode: TrafficMode, liveError?: string): TrafficResult {
    const wanted = airports ? new Set(airports) : undefined;
    const data = this.opts.snapshot.filter((r) => (wanted ? wanted.has(r.airport) : true) && r.month >= from && r.month <= to);
    const provenance: Provenance = {
      source: 'bts-socrata-snapshot',
      dataset: 'BTS T-100 Segment Summary By Origin Airport (committed snapshot of data.bts.gov r495-tyji)',
      retrievedAt: this.opts.snapshotGeneratedAt ?? 'unknown',
      period: { start: from, end: to },
      note: mode === 'snapshot-fallback' ? `Live BTS API unavailable (${liveError}); using the committed snapshot.` : 'Committed snapshot; live API not used.',
    };
    return { data, provenance, mode, ...(liveError ? { liveError } : {}) };
  }
}
