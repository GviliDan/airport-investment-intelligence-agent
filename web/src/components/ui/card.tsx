import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('overflow-hidden rounded-[var(--radius-card)] border border-border bg-card p-4 shadow-sm', className)} {...props} />;
}

export function CardHeader({ title, subtitle, badge }: { title: string; subtitle?: ReactNode; badge?: ReactNode }) {
  return (
    <header className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-tight">{title}</h3>
        {subtitle ? <p className="mt-0.5 text-[12.5px] text-muted-foreground">{subtitle}</p> : null}
      </div>
      {badge}
    </header>
  );
}

export const CardNote = ({ children, className }: { children: ReactNode; className?: string }) => <p className={cn('mt-3 text-[12.5px] leading-relaxed text-muted-foreground', className)}>{children}</p>;
