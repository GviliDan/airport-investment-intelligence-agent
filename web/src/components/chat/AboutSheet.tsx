import type { ReactNode } from 'react';
import { Sheet } from '@/components/ui/sheet';
import type { Meta } from '@/types';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="mt-5 first:mt-0">
    <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
    {children}
  </section>
);
const List = ({ items }: { items: ReactNode[] }) => <ul className="list-disc space-y-1.5 pl-5 text-[13px]">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;

/** Data periods, known limitations (including those of the model and the answer checks) and the scoring method. */
export function AboutSheet({ meta, open, onOpenChange }: { meta: Meta | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const d = meta?.data;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="About the data and method">
      <Section title="Data">
        {d ? (
          <List
            items={[
              ...Object.entries(d.datasets).map(([k, v]) => <><strong>{k.replaceAll('-', ' ')}</strong>: {v.source}{v.period ? ` (${v.period.start} to ${v.period.end})` : ''}</>),
              `Operations and routes cover ${d.alignedOperationalMonths.join(', ')}. FAA facility data effective ${d.faaEffectiveDate ?? 'unknown'}. Built ${d.builtAt.slice(0, 10)}.`,
              'Passenger totals are queried live from the BTS API; the bundled snapshot is used only if that API fails (the result says so). Current FAA disruptions are live.',
            ]}
          />
        ) : <p className="text-sm text-muted-foreground">Data details are unavailable (the server did not answer).</p>}
      </Section>
      <Section title="Known limitations"><List items={meta?.knownLimitations ?? []} /></Section>
      <Section title="How the opportunity score works">
        <List items={meta?.methodology?.method ?? []} />
        <details className="mt-2 text-[13px]">
          <summary className="cursor-pointer text-primary">Metric definitions and default weights</summary>
          <div className="mt-2"><List items={(meta?.methodology?.metrics ?? []).map((m) => <><strong>{m.label}</strong> (weight {m.defaultWeight}): {m.why} <span className="text-muted-foreground">Formula: {m.formula}. {m.caveat}</span></>)} /></div>
        </details>
        <div className="mt-2"><List items={meta?.methodology?.readingGuide ?? []} /></div>
      </Section>
      {meta ? <p className="mt-5 text-xs text-muted-foreground">Model: {meta.config.model}{meta.config.fallbackModel ? `, fallback ${meta.config.fallbackModel}` : ''}. {meta.config.liveTraffic ? 'Live traffic data on.' : 'Offline: bundled data only.'}</p> : null}
    </Sheet>
  );
}
