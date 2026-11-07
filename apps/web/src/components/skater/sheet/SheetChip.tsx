import type { ChipField, ChipTier, ReportSheetState, SheetFieldKey } from '@skating/core';
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/kit/tooltip';
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
 * - *Don't go* (D190) is one more chip here: only the feed colors it (Review 4).
 *
 * Two pixels of radius, one hairline: blocky, as the rest of the sheet. Deliberately not the shadcn
 * `Toggle`: three tiers and an offerable state are more than `pressed` can say.
 */
export function SheetChip({
  label,
  tier,
  onClick,
  compact = false,
  title,
  tip,
  trailing,
  emphasis = false,
  onPoint,
}: {
  label: string;
  /** `undefined` = an unselected, plain option (the row's own vocabulary, nobody suggested it). */
  tier?: ChipTier;
  onClick: () => void;
  compact?: boolean;
  title?: string;
  /** What the chip would need a helper line to explain, as the one tooltip style (Review 3). */
  tip?: string;
  /** A small mark after the label — the `where` a chip carries, drawn by the caller. */
  trailing?: ReactNode;
  /** The chip a where question is open for: ice corner brackets, so the question and its chip read as one. */
  emphasis?: boolean;
  /**
   * Pointing at the chip begins (`true`) and ends (`false`) — a hover, or the keyboard's focus, so a
   * keyboard sees what a mouse sees. A chip that names a pin on the map lights it with this.
   */
  onPoint?: (pointing: boolean) => void;
}) {
  const selected = tier === 'solid' || tier === 'extracted';
  const chip = (
    <button
      type="button"
      onClick={onClick}
      {...(onPoint !== undefined
        ? {
            onPointerEnter: () => onPoint(true),
            onPointerLeave: () => onPoint(false),
            onFocus: () => onPoint(true),
            onBlur: () => onPoint(false),
          }
        : {})}
      aria-pressed={selected}
      {...(title !== undefined ? { title } : {})}
      aria-label={
        tier === 'ghost'
          ? `${label}, suggested`
          : tier === 'extracted'
            ? `${label}, from your writing`
            : label
      }
      data-attr="sheet-chip"
      data-tier={tier}
      className={cn(
        'relative inline-flex cursor-pointer items-center gap-(--space-1_5) rounded-control border border-solid font-(family-name:--family-sans) outline-none',
        'transition-[background-color,color] duration-(--duration-fast) ease-standard focus-visible:shadow-focus',
        compact ? 'h-6.5 px-(--space-2) text-assist' : 'h-7.5 px-(--space-2_5) text-row',
        tier === 'solid' && 'border-fg bg-fg text-bg',
        tier === 'extracted' && 'border-fg2 bg-fg2 text-bg',
        tier === 'ghost' && 'border-dashed border-line2 bg-transparent text-fg2',
        tier === undefined && 'border-line2 bg-transparent text-fg1 hover:bg-lift-08',
        emphasis && 'shadow-[0_0_0_1px_var(--color-acc)]',
      )}
    >
      {tier === 'ghost' ? (
        <span aria-hidden className="text-fg3">
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
  if (tip === undefined) return chip;
  return (
    <Tooltip>
      <TooltipTrigger render={chip} />
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
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
  children,
  trailing,
  emphasisKey,
  bare = false,
}: {
  sheet: ReportSheetState;
  field: K;
  options: readonly V[];
  label: (value: V) => string;
  onSelect: (value: V) => void;
  onDeselect: (key: string) => void;
  /** Rendered after the row — a where affordance, a helper line. */
  children?: ReactNode;
  /** A mark after a selected chip's label, by its key (the `where` it carries). */
  trailing?: (key: string) => ReactNode;
  /** The chip a where question is open for. */
  emphasisKey?: string | null;
  /** The chips alone, no row around them — for a caller that sets two fields in one row. */
  bare?: boolean;
}) {
  const chips = (sheet.fields[field] as ChipField<unknown>).chips;
  const items = options.map((option) => {
    const chip = chips.find((c) => c.key === option);
    const tier = chip?.tier;
    const selected = tier === 'solid' || tier === 'extracted';
    return (
      <SheetChip
        key={option}
        label={label(option)}
        {...(tier !== undefined ? { tier } : {})}
        emphasis={emphasisKey === option}
        {...(selected && trailing ? { trailing: trailing(option) } : {})}
        onClick={() => (selected ? onDeselect(option) : onSelect(option))}
      />
    );
  });
  if (bare) return <>{items}</>;
  return (
    <div className="flex flex-col gap-(--space-2)">
      <div className="flex flex-wrap gap-(--space-1_5)">{items}</div>
      {children}
    </div>
  );
}
