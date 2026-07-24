import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '../ui/card';

/** A page title + optional subtitle/actions row shared across the admin pages. */
export function AdminPageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h1 className="font-semibold text-2xl text-foreground">{title}</h1>
        {subtitle ? <p className="text-foreground-muted text-sm">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** The friendly "nothing here" state a healthy queue spends most of its time in. */
export function AdminEmpty({ children }: { children: ReactNode }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-foreground-muted text-sm">
        {children}
      </CardContent>
    </Card>
  );
}

/** A single KPI tile — a big number with a label, used on the dashboard + app-health strip. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger';
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 py-4">
        <span className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          {label}
        </span>
        <span
          className={cn(
            'font-semibold text-2xl tabular-nums',
            tone === 'warning' && 'text-warning',
            tone === 'danger' && 'text-destructive',
            tone === 'default' && 'text-foreground',
          )}
        >
          {value}
        </span>
        {hint ? <span className="text-foreground-muted text-xs">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}

/** Minimal responsive table primitives — the UI kit has no table, so these wrap a plain one. */
export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-border border-b bg-surface-muted px-3 py-2 font-medium text-foreground-muted text-xs',
        className,
      )}
    >
      {children}
    </th>
  );
}
export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cn('border-border/50 border-b px-3 py-2 text-foreground', className)}>
      {children}
    </td>
  );
}
