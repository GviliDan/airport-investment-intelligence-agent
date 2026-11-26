import { Info } from 'lucide-react';
import { ArtifactView } from '@/components/analytics/ArtifactView';
import { Button } from '@/components/ui/button';
import type { ChatResponse } from '@/types';
import { describeArgs, int, periodLabel, toolTitle } from '@/utils/format';
import { Markdown } from './Markdown';

const GROUNDING_TEXT: Record<ChatResponse['grounding']['status'], string> = {
  verified: 'Every figure in the explanation matched the data results.',
  no_figures: 'The explanation contains no figures to check.',
  corrected: 'A figure in the first draft did not match the data, so the answer was rewritten; the final text matched.',
  redacted: 'Some statements were removed because their figures could not be matched to the data.',
};

const CONTROL_LABEL: Record<string, string> = {
  ignored_parameter: 'Not applied',
  inherited_parameter: 'Kept from earlier',
  scope_restored: 'Scope kept',
  scope_interpreted: 'Scope chosen by the assistant',
};

function Section({ title, items, open }: { title: string; items: string[]; open?: boolean }) {
  const clean = [...new Set(items.map((x) => x.replace(/;?\s*see correlationAdjustments\.?/i, '.')))];
  if (clean.length === 0) return null;
  return (
    <details open={open} className="mt-2 text-[13px]">
      <summary className="cursor-pointer text-primary">{title} ({clean.length})</summary>
      <ul className="mt-1 list-disc space-y-1 pl-5">{clean.map((x) => <li key={x}>{x}</li>)}</ul>
    </details>
  );
}

/** Sources, periods, assumptions and limits for one answer, collapsed by default; "What was run" holds the technical detail. */
function Evidence({ r }: { r: ChatResponse }) {
  const periods = [...new Set(r.periods.flatMap((p) => Object.entries(p.periods).map(([k, v]) => `${toolTitle(p.tool)}: ${k.replace(/([A-Z])/g, ' $1').toLowerCase()} ${periodLabel(v)}`)))];
  const g = r.grounding;
  return (
    <details className="rounded-[var(--radius-card)] border border-border bg-card px-4 py-3 text-[13px] shadow-sm">
      <summary className="cursor-pointer font-medium text-primary">Sources, periods, assumptions and limits</summary>
      <Section title="Data sources" items={r.sources} open />
      <Section title="Periods" items={periods} open />
      <Section title="Limitations" items={r.limitations} />
      <Section title="Assumptions" items={r.assumptions} />
      <Section title="Warnings" items={r.warnings} />
      <h4 className="mt-3 text-xs font-semibold text-muted-foreground">Answer check</h4>
      <p>
        {GROUNDING_TEXT[g.status]} {g.checked > 0 ? `${g.checked} figures checked.` : ''} {g.nudgedToUseTools ? 'The model first answered without using the data tools and was sent back to use them.' : ''}{' '}
        {g.overclaim === 'rewritten' ? 'Strong wording not supported by the data was toned down.' : g.overclaim === 'noted' ? 'The wording may overstate the data; see the note in the answer.' : ''}
      </p>
      <p className="text-muted-foreground">The checker only confirms that numbers and years appear in the data results. It cannot tell whether a number is attached to the right airport, or verify wording, causes or conclusions, so rely on the tables for exact values.</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-primary">What was run</summary>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {r.artifacts.map((a) => (
            <li key={a.id}>
              <strong>{toolTitle(a.tool)}</strong> <span className="text-muted-foreground">{describeArgs(a.args)}</span>
              {a.output.ok ? null : <span className="text-warning"> — {a.output.error.message}</span>}
            </li>
          ))}
        </ul>
        <p className="tnum mt-1 text-muted-foreground">
          {r.usage.model}{r.usage.usedFallback ? ' (fallback used)' : ''} · {(r.usage.durationMs / 1000).toFixed(1)}s · {r.usage.modelAttempts} model calls{r.usage.modelRetries ? ` (${r.usage.modelRetries} failed and were retried)` : ''} · {r.usage.toolCalls} data tool calls{r.usage.totalTokens ? ` · ${int(r.usage.totalTokens)} tokens` : ''}
        </p>
      </details>
    </details>
  );
}

/** Notes about what the system did with the model's choices: arguments ignored or kept, and scopes chosen for the user. */
function Controls({ r }: { r: ChatResponse }) {
  if (r.controls.length === 0) return null;
  return (
    <div className="rounded-lg border border-warning/40 bg-warning-bg px-3 py-2 text-[13px]" role="note">
      <p className="mb-1 flex items-center gap-1.5 font-medium text-warning"><Info className="h-3.5 w-3.5" />How your question was applied</p>
      <ul className="space-y-0.5">
        {r.controls.map((c, i) => <li key={i}><span className="font-medium">{CONTROL_LABEL[c.kind] ?? c.kind}:</span> {c.message}</li>)}
      </ul>
    </div>
  );
}

export function AssistantMessage({ r, onAsk, isLatest }: { r: ChatResponse; onAsk: (text: string) => void; isLatest: boolean }) {
  const chip = (key: string, label: string, ask: string) => (
    <Button key={key} variant="outline" size="sm" className="h-7 rounded-full px-3" disabled={!isLatest} onClick={() => onAsk(ask)}>{label}</Button>
  );
  return (
    <div className="space-y-3">
      <div className="rounded-[var(--radius-card)] rounded-tl-sm border border-border bg-card px-4 py-3 shadow-sm">
        <Markdown text={r.answer} />
        {r.interpretations.map((i) => (
          <div key={`${i.tool}-${i.input}`} className="mt-3">
            <p className="mb-1.5 text-[13.5px] text-muted-foreground">I took “{i.input}” to mean <strong className="text-foreground">{i.used.code}</strong>{i.used.name ? ` (${i.used.name})` : ''}. Not the right one?</p>
            <div className="flex flex-wrap gap-1.5">
              {i.alternatives.slice(0, 5).map((a) => chip(a.code, `${a.code}${a.name ? ` · ${a.name}` : ''}`, `I meant ${a.code}${a.name ? ` (${a.name})` : ''} when I said "${i.input}". Please redo my last question with ${a.code}.`))}
            </div>
          </div>
        ))}
        {r.needsClarification
          ? r.ambiguities.map((a) => (
              <div key={a.input} className="mt-3">
                <p className="mb-1.5 text-[13.5px] text-muted-foreground">Which one do you mean by “{a.input}”?</p>
                <div className="flex flex-wrap gap-1.5">
                  {a.options.slice(0, 8).map((o) => chip(o.code, `${o.code}${o.name ? ` · ${o.name}` : ''}${o.state ? `, ${o.state}` : ''}${a.suggested === o.code ? ' · busiest' : ''}`, `For "${a.input}" I mean ${o.code}${o.name ? ` (${o.name})` : ''}.`))}
                </div>
              </div>
            ))
          : null}
      </div>
      <Controls r={r} />
      {r.artifacts.map((a) => <ArtifactView key={a.id} artifact={a} />)}
      {r.history.truncated ? <p className="text-xs text-muted-foreground">Older messages were dropped from the assistant's memory to keep this conversation short.</p> : null}
      {r.artifacts.length > 0 || r.sources.length > 0 ? <Evidence r={r} /> : null}
    </div>
  );
}
