import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One section of the sheet, as a console panel (A10-5 §10.1): the FUI header row that is the
 * section's name, its one-line summary once it is filled, and the collapse toggle; the body
 * underneath while it is open.
 *
 * Same rules as the phone's `SheetSection` (A10-3), because they are the sheet's rules and not a
 * surface's: the header never moves and never reorders — the fixed order is the point — and
 * collapsing is the author's click, never something the sheet does under their cursor. A section
 * opened from an edit starts collapsed to its summary (the reducer holds that), so a review reads
 * as a list of what was said; a fresh sheet starts open.
 *
 * `gap` marks a section the minimum set still wants (D189) after a *Post* attempt — a quiet mark
 * beside the name, not a red field.
 */
export function SheetPanel({
  label,
  summary,
  collapsed,
  onToggle,
  gap = false,
  children,
}: {
  label: string;
  /** Empty when the section has nothing yet; the header then reads the name alone. */
  summary: string;
  collapsed: boolean;
  onToggle: () => void;
  gap?: boolean;
  children: ReactNode;
}) {
  const filled = summary.length > 0;
  return (
    <section className="border-border border-t">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-2 py-3 text-left hover:opacity-80"
      >
        <span
          className={cn(
            'font-mono text-xs uppercase tracking-widest',
            gap ? 'text-warning' : 'text-foreground-muted',
          )}
        >
          {label}
        </span>
        {gap ? <span className="text-warning text-xs">· needed</span> : null}
        <span className="flex-1" />
        {filled && collapsed ? (
          <span className="truncate text-foreground text-sm">{summary}</span>
        ) : null}
        <span aria-hidden className="text-foreground-muted text-xs">
          {collapsed ? '⌄' : '⌃'}
        </span>
      </button>
      {collapsed ? null : <div className="flex flex-col gap-2.5 pb-4">{children}</div>}
    </section>
  );
}

/** A quiet helper line under a row — a suggestion's source, a note on what the row means. */
export function SheetHint({ children }: { children: ReactNode }) {
  return <p className="text-foreground-muted text-xs leading-4">{children}</p>;
}

/** A small label above a sub-row inside a section ("Coverage", "Drifts"). */
export function SubLabel({ children }: { children: ReactNode }) {
  return <p className="font-semibold text-foreground text-sm">{children}</p>;
}
