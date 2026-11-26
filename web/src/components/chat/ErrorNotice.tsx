import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ApiError } from '@/types';
import { describeError } from '@/utils/errors';

/** A typed failure (model overload, quota, timeout, network...) in plain words, with Retry where it can help. */
export function ErrorNotice({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const v = describeError(error);
  return (
    <div className="flex gap-3 rounded-[var(--radius-card)] border border-destructive/50 bg-destructive-bg p-4" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      <div className="space-y-1.5 text-sm">
        <p className="font-semibold text-destructive">{v.title}</p>
        <p>{v.detail}</p>
        <p className="text-muted-foreground">{v.hint}</p>
        {v.retryable && onRetry ? <Button variant="outline" size="sm" onClick={onRetry} className="mt-1">Retry</Button> : null}
      </div>
    </div>
  );
}
