'use client';

import { Check, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Step } from '@/utils/progress';

/** Live steps of the agent's work, with an elapsed timer, while a message is being answered. */
export function ProgressSteps({ steps, startedAt }: { steps: Step[]; startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const secs = Math.floor((now - startedAt) / 1000);
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-card px-4 py-3 shadow-sm" role="status" aria-live="polite">
      <ul className="space-y-1.5 text-sm">
        {steps.length === 0 ? <li className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />Sending your question</li> : null}
        {steps.map((s) => (
          <li key={s.key} className={`flex items-center gap-2 ${s.state === 'done' ? 'text-muted-foreground' : ''}`}>
            {s.state === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : <Check className="h-3.5 w-3.5 text-success" />}
            {s.label}
          </li>
        ))}
      </ul>
      <p className="tnum mt-2 text-xs text-muted-foreground">{secs}s{secs >= 20 ? ' · the AI model is slow right now; still working' : ''}</p>
    </div>
  );
}
