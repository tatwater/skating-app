import type { ChipField, ChipTier, ReportSheetState, SheetFieldKey } from '@skating/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The sheet's chip on web (A10-5), in the three tiers mobile draws (A10-3 / D188). The tier is
 * whose words the value came from, and the drawing says so without a legend:
 *
 * - **solid** — the author clicked it: filled, primary.
 * - **ghost** — someone else implied it: a dashed outline and a leading `+`, muted. Reads as an
 *   offer, never as a fill; a click makes it solid.
 * - **extracted** — read from the author's own writing (A10-4): the primary outline and a small
 *   ✎ mark. Pre-selected, so it draws as a selection, but hollow, so the author sees which chips
 *   they typed rather than clicked.
 *
 * Deliberately not the shadcn `Toggle`: a chip is not a two-state control. Three tiers, a danger
 * treatment and an unselected-but-offerable state are more than a toggle's `pressed` can say, and
 * the two surfaces have to draw the same thing.
 */
export function SheetChip({
  label,
  tier,
  onClick,
  danger = false,
  compact = false,
  title,
}: {
  label: string;
  /** `undefined` = an unselected, plain option (the row's own vocabulary, nobody suggested it). */
  tier?: ChipTier;
  onClick: () => void;
  /** The warning treatment — *don't go* (D190). Solid only. */
  danger?: boolean;
  compact?: boolean;
  title?: string;
}) {
  const selected = tier === 'solid' || tier === 'extracted';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      {...(title !== undefined ? { title } : {})}
      aria-label={
        tier === 'ghost'
          ? `${label}, suggested`
          : tier === 'extracted'
            ? `${label}, from your writing`
            : label
      }
      className={cn(
        'inline-flex items-center gap-1 rounded-full border transition-colors',
        compact ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        selected ? 'font-semibold' : 'font-normal',
        tier === 'solid' && !danger && 'border-primary bg-primary text-primary-foreground',
        tier === 'solid' && danger && 'border-danger bg-danger text-danger-foreground',
        tier === 'extracted' && 'border-primary text-foreground',
        tier === 'ghost' && 'border-border-strong border-dashed text-foreground-muted',
        tier === undefined && 'border-border text-foreground hover:bg-surface-muted',
      )}
    >
      {tier === 'ghost' ? <span aria-hidden>+</span> : null}
      {label}
      {tier === 'extracted' ? (
        <span aria-hidden className="text-[0.625rem] text-primary">
          ✎
        </span>
      ) : null}
    </button>
  );
}

/**
 * A row of chips over one reducer field: the field's own vocabulary as plain options, with the
 * reducer's chips (ghosts, extractions, the author's clicks) drawn in their tiers on top. Clicking
 * a selected chip deselects it; clicking anything else selects it. The order is the vocabulary's,
 * never a suggestion's — nothing reorders (D187).
 */
export function ChipRow<K extends SheetFieldKey, V extends string>({
  sheet,
  field,
  options,
  label,
  onSelect,
  onDeselect,
  danger,
  children,
}: {
  sheet: ReportSheetState;
  field: K;
  options: readonly V[];
  label: (value: V) => string;
  onSelect: (value: V) => void;
  onDeselect: (key: string) => void;
  /** Which option wears the warning treatment when solid. */
  danger?: V;
  /** Rendered after the row — a where affordance, a helper line. */
  children?: ReactNode;
}) {
  const chips = (sheet.fields[field] as ChipField<unknown>).chips;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const chip = chips.find((c) => c.key === option);
          const tier = chip?.tier;
          const selected = tier === 'solid' || tier === 'extracted';
          return (
            <SheetChip
              key={option}
              label={label(option)}
              {...(tier !== undefined ? { tier } : {})}
              danger={danger === option}
              onClick={() => (selected ? onDeselect(option) : onSelect(option))}
            />
          );
        })}
      </div>
      {children}
    </div>
  );
}
