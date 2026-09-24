import type { ChipField, ChipTier, ReportSheetState, SheetFieldKey } from '@skating/core';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The sheet's chip on web (A10-5, re-skinned A10-6 / D206), in the three tiers mobile draws
 * (A10-3 / D188). The tier is whose words the value came from, and the drawing says so without a
 * legend — and without a color, because color on this sheet is rationed by meaning (D206):
 *
 * - **solid** — the author clicked it: **inverted ink**, the foreground as fill, the background as
 *   text. Black and white carry the form.
 * - **extracted** — read from the author's own writing (A10-4): the *same inversion, weaker* — the
 *   muted foreground as fill — with a ✎. Pre-selected, so it draws as a selection, but visibly
 *   less than a click (founder call 2026-09-23: a less-strong selected, never a different style).
 * - **ghost** — someone else implied it: a dashed outline and a leading `+`, muted. Reads as an
 *   offer, never as a fill; a click makes it solid.
 * - **danger** — *don't go* (D190), the one chip that wears red, solid only.
 *
 * Two pixels of radius, one hairline: blocky, as the rest of the sheet. Deliberately not the shadcn
 * `Toggle`: three tiers, a danger treatment and an offerable state are more than `pressed` can say.
 */
export function SheetChip({
  label,
  tier,
  onClick,
  danger = false,
  compact = false,
  title,
  trailing,
  emphasis = false,
}: {
  label: string;
  /** `undefined` = an unselected, plain option (the row's own vocabulary, nobody suggested it). */
  tier?: ChipTier;
  onClick: () => void;
  /** The warning treatment — *don't go* (D190). Solid only. */
  danger?: boolean;
  compact?: boolean;
  title?: string;
  /** A small mark after the label — the `where` a chip carries, drawn by the caller. */
  trailing?: ReactNode;
  /** The chip a where question is open for: ice corner brackets, so the question and its chip read as one. */
  emphasis?: boolean;
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
        'relative inline-flex items-center gap-1.5 rounded-[2px] border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'h-6 px-2 text-xs' : 'h-7 px-2.5 text-[13px]',
        selected ? 'font-semibold' : 'font-medium',
        tier === 'solid' && !danger && 'border-foreground bg-foreground text-background',
        tier === 'solid' && danger && 'border-danger bg-danger text-danger-foreground',
        tier === 'extracted' && 'border-foreground-muted bg-foreground-muted text-background',
        tier === 'ghost' && 'border-border-strong border-dashed text-foreground-muted',
        tier === undefined && !danger && 'border-border text-foreground hover:bg-surface-muted',
        tier === undefined && danger && 'border-danger text-danger hover:bg-danger/10',
        emphasis && 'sheet-brackets',
      )}
    >
      {tier === 'ghost' ? (
        <span aria-hidden className="text-foreground-muted">
          +
        </span>
      ) : null}
      {label}
      {trailing}
      {tier === 'extracted' ? (
        <span aria-hidden className="text-[0.625rem] opacity-70">
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
  trailing,
  emphasisKey,
}: {
  sheet: ReportSheetState;
  field: K;
  options: readonly V[];
  label: (value: V) => string;
  onSelect: (value: V) => void;
  onDeselect: (key: string) => void;
  /** Which option wears the warning treatment. */
  danger?: V;
  /** Rendered after the row — a where affordance, a helper line. */
  children?: ReactNode;
  /** A mark after a selected chip's label, by its key (the `where` it carries). */
  trailing?: (key: string) => ReactNode;
  /** The chip a where question is open for. */
  emphasisKey?: string | null;
}) {
  const chips = (sheet.fields[field] as ChipField<unknown>).chips;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
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
              emphasis={emphasisKey === option}
              {...(selected && trailing ? { trailing: trailing(option) } : {})}
              onClick={() => (selected ? onDeselect(option) : onSelect(option))}
            />
          );
        })}
      </div>
      {children}
    </div>
  );
}
