import { Plane } from 'lucide-react';
import { EXAMPLE_QUESTIONS } from '@/constants/examples';

export function Welcome({ onAsk, disabled }: { onAsk: (q: string) => void; disabled: boolean }) {
  return (
    <div className="my-auto flex flex-col gap-4 py-8">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Plane className="h-5 w-5" /></div>
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Screen US airports for modernization and expansion</h2>
        <p className="mt-2 max-w-[62ch] text-muted-foreground">Ask in plain language. Every figure comes from public BTS and FAA data and is calculated by code, not by the AI. Results appear as tables and charts you can check.</p>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {EXAMPLE_QUESTIONS.map((q) => (
          <button key={q} disabled={disabled} onClick={() => onAsk(q)} className="rounded-[var(--radius-card)] border border-border bg-card p-3.5 text-left text-sm shadow-sm transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-60">
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
