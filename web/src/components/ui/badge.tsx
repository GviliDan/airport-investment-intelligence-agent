import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/utils/cn';

const variants = cva('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap', {
  variants: {
    tone: {
      neutral: 'border-border bg-muted text-muted-foreground',
      warn: 'border-warning/50 bg-warning-bg text-warning',
      info: 'border-primary/30 bg-accent text-primary',
      ok: 'border-success/40 text-success',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof variants>) {
  return <span className={cn(variants({ tone }), className)} {...props} />;
}
