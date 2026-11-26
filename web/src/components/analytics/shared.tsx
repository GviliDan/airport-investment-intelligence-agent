import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { CardNote } from '@/components/ui/card';
import type { ToolSuccess } from '@/types';
import { cn } from '@/utils/cn';
import { periodLabel } from '@/utils/format';

/** Horizontally scrollable table wrapper with consistent styling. */
export function DataTable({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="-mx-1 overflow-x-auto px-1">
      <table className={cn('w-full border-collapse text-[13.5px] [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-2 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-2 [&_th]:text-xs [&_th]:font-semibold [&_th]:whitespace-nowrap [&_th]:text-muted-foreground [&_tbody_tr:last-child_td]:border-b-0', className)}>{children}</table>
    </div>
  );
}

/** Right-aligned numeric cell classes. */
export const NUM = 'tnum text-right whitespace-nowrap';

export function AirportName({ a }: { a: { code: string; name?: string | undefined; state?: string | undefined } }) {
  return (
    <span>
      <strong>{a.code}</strong>
      <span className="text-[12.5px] text-muted-foreground"> {a.name ?? ''}{a.state ? `, ${a.state}` : ''}</span>
    </span>
  );
}

export const periodsLine = (o: ToolSuccess): string => Object.values(o.periods).map(periodLabel).join(' · ');

export function PageNote({ o }: { o: ToolSuccess }) {
  return o.page && o.page.total > o.page.returned ? <CardNote>Showing {o.page.returned} of {o.page.total}. Ask for more to see the next rows.</CardNote> : null;
}

/** Live FAA status for one airport: events, "none reported", or "unavailable". Always labelled as current, not historical. */
export function LiveStatus({ code, status }: { code: string; status: { events?: Array<{ airport: string; kind: string; reason?: string; detail?: { Avg?: string }; interpretation?: string }>; unavailable?: string } | undefined }) {
  if (!status) return null;
  if (status.unavailable) return <CardNote className="text-warning">Live FAA status for {code} is unavailable right now.</CardNote>;
  if (!status.events?.length) return <CardNote>FAA live status: no disruptions reported for {code} right now.</CardNote>;
  return (
    <>
      {status.events.map((e, i) => (
        <CardNote key={i}>
          <Badge tone="warn">live</Badge> {e.airport}: {e.kind.replaceAll('-', ' ')}{e.reason ? ` (${e.reason})` : ''}{e.detail?.Avg ? `, average ${e.detail.Avg}` : ''}. {e.interpretation ?? ''}
        </CardNote>
      ))}
    </>
  );
}

export const Kpis = ({ children }: { children: ReactNode }) => <p className="my-2 flex flex-wrap gap-x-6 gap-y-1 text-[13.5px] text-muted-foreground [&_strong]:text-[15px] [&_strong]:text-foreground">{children}</p>;
export const Subhead = ({ children }: { children: ReactNode }) => <h4 className="mb-1.5 mt-4 text-[13px] font-semibold text-muted-foreground">{children}</h4>;
export const Facts = ({ children }: { children: ReactNode }) => <ul className="my-1 list-disc space-y-1 pl-5 text-[13px]">{children}</ul>;

export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="mt-3 text-[13px]">
      <summary className="cursor-pointer text-primary">{summary}</summary>
      <div className="mt-2">{children}</div>
    </details>
  );
}
