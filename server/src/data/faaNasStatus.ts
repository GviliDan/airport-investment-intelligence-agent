import { XMLParser } from 'fast-xml-parser';
import { TtlCache } from './cache.js';
import { ProviderError } from './errors.js';
import { getText, type HttpOptions } from './http.js';
import type { Sourced } from './types.js';

export const NAS_STATUS_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const SOURCE = 'faa-nas-status';

export type NasEventKind = 'ground-delay-program' | 'ground-stop' | 'arrival-departure-delay' | 'airport-closure' | 'other';

/** One current disruption. Times and reasons are as published by the FAA, not interpreted. */
export interface NasEvent {
  readonly airport: string;
  readonly kind: NasEventKind;
  readonly reason?: string;
  readonly detail: Readonly<Record<string, string>>;
  /** Plain-language reading of the notice when the FAA text is a known pattern; absent otherwise. */
  readonly interpretation?: string;
}

export interface NasSnapshot {
  /** FAA's own update timestamp (as published). */
  readonly updatedAt?: string;
  readonly events: readonly NasEvent[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: false, trimValues: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const KIND_BY_NAME: ReadonlyArray<[RegExp, NasEventKind]> = [
  [/ground delay/i, 'ground-delay-program'],
  [/ground stop/i, 'ground-stop'],
  [/arrival\/departure|delay info/i, 'arrival-departure-delay'],
  [/closure/i, 'airport-closure'],
];

/** Pulls every element that has an <ARPT> child out of a Delay_type block, whatever its list wrapper is called. */
function eventsOf(block: Record<string, unknown>): NasEvent[] {
  const name = str(block.Name) ?? '';
  const kind = KIND_BY_NAME.find(([re]) => re.test(name))?.[1] ?? 'other';
  const out: NasEvent[] = [];
  for (const [key, list] of Object.entries(block)) {
    if (key === 'Name' || typeof list !== 'object' || list === null) continue;
    for (const group of Object.values(list as Record<string, unknown>)) {
      for (const item of asArray(group as Record<string, unknown>) as Record<string, unknown>[]) {
        if (typeof item !== 'object' || item === null) continue;
        const airport = str(item.ARPT);
        if (!airport) continue;
        const detail: Record<string, string> = {};
        for (const [k, v] of Object.entries(item)) {
          if (k === 'ARPT' || k === 'Reason') continue;
          if (typeof v === 'string') detail[k] = v;
          else if (typeof v === 'object' && v) {
            const node = v as Record<string, unknown>;
            if (str(node['@_Type'])) detail.type = node['@_Type'] as string;
            for (const [k2, v2] of Object.entries(node)) if (typeof v2 === 'string' && !k2.startsWith('@_')) detail[k2.toLowerCase()] = v2;
          }
        }
        const reason = str(item.Reason);
        const gaOnly = kind === 'airport-closure' && reason !== undefined && /TRANSIENT GA|GA ACFT/i.test(reason);
        out.push({
          airport, kind, ...(reason ? { reason } : {}), detail,
          ...(gaOnly ? { interpretation: 'The notice text restricts general-aviation aircraft; it does not describe a closure to airline service.' } : {}),
        });
      }
    }
  }
  return out;
}

export function parseNasStatus(xml: string): NasSnapshot {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch {
    throw new ProviderError(SOURCE, 'invalid-response', 'response was not valid XML');
  }
  const root = doc.AIRPORT_STATUS_INFORMATION as Record<string, unknown> | undefined;
  if (!root || typeof root !== 'object') throw new ProviderError(SOURCE, 'invalid-response', 'missing AIRPORT_STATUS_INFORMATION');
  const events = asArray(root.Delay_type as Record<string, unknown> | Record<string, unknown>[]).flatMap(eventsOf);
  const updatedAt = str(root.Update_Time);
  return { ...(updatedAt ? { updatedAt } : {}), events };
}

export interface NasStatusOptions extends Omit<HttpOptions, 'source'> {
  readonly url?: string;
  readonly now?: () => Date;
  /** Status changes quickly; keep the cache short. */
  readonly cacheTtlMs?: number;
}

/** Live client for current FAA NAS airport status (no key). Describes now, not history. */
export class FaaNasStatusClient {
  private readonly cache: TtlCache<Sourced<NasSnapshot>>;
  constructor(private readonly opts: NasStatusOptions = {}) {
    this.cache = new TtlCache(opts.cacheTtlMs ?? 60_000);
  }

  current(): Promise<Sourced<NasSnapshot>> {
    return this.cache.get('current', async () => {
      const xml = await getText(this.opts.url ?? NAS_STATUS_URL, { ...this.opts, source: SOURCE });
      const snapshot = parseNasStatus(xml);
      return {
        data: snapshot,
        provenance: {
          source: SOURCE,
          dataset: 'FAA NAS Status - airport status information',
          retrievedAt: (this.opts.now?.() ?? new Date()).toISOString(),
          note: 'Current operational status only; no history. Reasons are quoted from the FAA feed.',
        },
      };
    });
  }

  /** Events for one airport, or an empty list when none are reported (which means "none reported", not "no delays"). */
  async forAirport(code: string): Promise<Sourced<NasEvent[]>> {
    const { data, provenance } = await this.current();
    return { data: data.events.filter((e) => e.airport === code), provenance };
  }
}
