import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One section of the sheet, as a console panel (A10-5 §10.1, re-skinned A10-6 / D206): the header
 * row is a status square, the section's name as an instrument label, its one-line summary once it
 * is filled, and the collapse caret; the body underneath while it is open.
 *
 * **The square is the section's state**, legend-free: hollow = nothing yet, filled = has data,
 * amber = the minimum set still wants it (D189) after a *Post* attempt. An open panel sits on the
 * raised surface with bracket corners — *this is the one being edited* — and a collapsed one is a
 * flat row. Same rules as the phone's `SheetSection`, because they are the sheet's rules and not a
 * surface's: the header never moves and never reorders, and collapsing is the author's click.
 */
export function SheetPanel({
  label,
  summary,
  collapsed,
  onToggle,
  gap = false,
  children,
  id,
}: {
  label: string;
  /** Empty when the section has nothing yet; the header then reads the name alone. */
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  gap?: boolean;
  children: ReactNode;
  id?: string;
}) {
  const filled = summary.length > 0;
  return (
    <section
      {...(id !== undefined ? { id } : {})}
      className={cn('border-border border-b', !collapsed && 'sheet-brackets bg-surface-muted/60')}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex h-[34px] w-full items-center gap-2.5 px-3.5 text-left hover:bg-surface-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StatusSquare state={gap ? 'needed' : filled ? 'filled' : 'empty'} />
        <Eyebrow className={gap ? 'text-warning' : undefined}>{label}</Eyebrow>
        {gap ? <Eyebrow className="text-warning">· needed</Eyebrow> : null}
        <span className="flex-1" />
        {filled && collapsed ? (
          <span className="max-w-[55%] truncate text-foreground text-xs">{summary}</span>
        ) : null}
        <span aria-hidden className="text-[10px] text-foreground-muted">
          {collapsed ? '▼' : '▲'}
        </span>
      </button>
      {collapsed ? null : (
        <div className="flex flex-col gap-2.5 px-3.5 pt-0.5 pb-3.5">{children}</div>
      )}
    </section>
  );
}

/** The section's name as the instrument label it is: mono, caps, tracked. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-[10.5px] text-foreground-muted uppercase tracking-[0.14em]',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A section's state, as a 7-px square. Hollow, filled, or amber for needed (D189). */
export function StatusSquare({ state }: { state: 'empty' | 'filled' | 'needed' | 'ice' }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-[7px] shrink-0 border',
        state === 'empty' && 'border-border-strong',
        state === 'filled' && 'border-foreground bg-foreground',
        state === 'needed' && 'border-warning bg-warning shadow-[0_0_6px_var(--warning)]',
        state === 'ice' && 'border-primary bg-primary shadow-[0_0_6px_var(--ring)]',
      )}
    />
  );
}

/** A quiet helper line under a row — a suggestion's source, a note on what the row means. */
export function SheetHint({ children }: { children: ReactNode }) {
  return <p className="text-foreground-muted text-xs leading-4">{children}</p>;
}

/** A small label above a sub-row inside a section ("Surface", "Drifts"). */
export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <p className="pt-1 font-mono text-[10px] text-foreground-muted uppercase tracking-[0.1em]">
      {children}
    </p>
  );
}

/**
 * A question block inside a panel — the where question, the put-in question — the one thing on
 * the console that borders in ice, because opening it is what puts the instrument into a mode
 * (`ConsoleMode`). Its head names the question and carries *Done*.
 */
export function QuestionBlock({
  title,
  onDone,
  extra,
  children,
}: {
  title: string;
  onDone: () => void;
  /** Between the title and *Done* — a count, a skip. */
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[2px] border border-primary bg-background p-2.5">
      <div className="flex items-center gap-2.5">
        <Eyebrow className="text-primary">{title}</Eyebrow>
        <span className="flex-1" />
        {extra}
        <button
          type="button"
          onClick={onDone}
          className="h-[22px] rounded-[2px] border border-foreground bg-foreground px-2 font-semibold text-[11px] text-background uppercase tracking-[0.08em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Done
        </button>
      </div>
      {children}
    </div>
  );
}
