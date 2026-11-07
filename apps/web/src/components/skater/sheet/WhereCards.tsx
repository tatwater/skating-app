import { pointFromTap, type SheetLandmark, type Where } from '@skating/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { useConsoleMode } from './ConsoleMode';
import { QuestionBlock, SheetHint } from './SheetPanel';
import type { SheetBody } from './useSheetBody';
import { POINT_RADIUS_M, patchWhere, WherePicker } from './WherePicker';

/** One selected chip's where question. */
export interface WhereCard {
  /** `field:key`, stable across renders. */
  id: string;
  label: string;
  /** The card's question when "Where is the {label}?" does not read — a sighting is a state (D210). */
  question?: string;
  where: Where | undefined;
  onChange: (where: Where | undefined) => void;
  /** Say it of one more place — returns the new card's id (core `whereCardsFor`). */
  onAnotherPlace?: () => string;
}

/**
 * The where cards (A10-6, founder call 2026-09-23): one card per selected ice or surface chip,
 * as a **carousel with its peers visible** — a row of card tabs above the open card, a dot on any
 * card that has no answer yet, *Skip* and *Done*. Any order (D187 is not a wizard); the row shows
 * what is still unanswered. While the block is open the console is in where-mode: the instrument
 * draws the ring and takes the click for the open card, and everything else dims.
 *
 * The stack the founder also offered (answer the top card to reach the next) is a layout change
 * on this same component; the carousel keeps "answer in any order".
 */
export function WhereCards({
  cards,
  body,
  open,
  onClose,
  activeId,
  onActivate,
}: {
  cards: readonly WhereCard[];
  body: SheetBody | null;
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onActivate: (id: string) => void;
}) {
  const { setMode, instrument } = useConsoleMode();
  const [placing, setPlacing] = useState(false);
  const active = useMemo(
    () => cards.find((c) => c.id === activeId) ?? cards[0] ?? null,
    [cards, activeId],
  );
  const index = active ? cards.findIndex((c) => c.id === active.id) : -1;

  // The mode follows the open card: the instrument's ring lights this card's sector and a click
  // on it answers this card. Placing a point is the one click that lands inside the lake.
  //
  // The mode is armed on the card's *identity and answer*, never on its callbacks: the parent
  // rebuilds the cards — new `onChange` closures — on every render, and the console re-renders
  // on every mode change, so arming on the closure would arm again on the render the arming
  // caused, without end. The closures ride a ref the mode reads through (as `AccessPanel` does).
  const activeCardId = active?.id;
  const activeWhere = active?.where;
  const activeLabel = active?.label;
  const handlers = useRef({ onChange: active?.onChange, onClose });
  handlers.current = { onChange: active?.onChange, onClose };
  useEffect(() => {
    // No instrument (a phone): the picker draws its own lake below and takes the tap there.
    if (!instrument) return;
    if (!open || activeCardId === undefined || activeLabel === undefined) {
      setMode(null);
      return;
    }
    setMode({
      kind: 'where',
      label: activeLabel,
      where: activeWhere,
      onChange: (next) => {
        handlers.current.onChange?.(next);
        setPlacing(false);
      },
      onExit: () => handlers.current.onClose(),
    });
    return () => setMode(null);
  }, [open, activeCardId, activeWhere, activeLabel, instrument, setMode]);

  if (!open || !active) return null;
  const next = () => {
    const after = cards[(index + 1) % cards.length];
    if (after && cards.length > 1) onActivate(after.id);
    else onClose();
  };

  return (
    <QuestionBlock
      title={active.question ?? `Where is the ${active.label.toLowerCase()}?`}
      onDone={onClose}
      extra={
        <>
          {cards.length > 1 ? (
            <span className="font-(family-name:--family-mono) text-mono-sm text-fg2">
              {index + 1} of {cards.length}
            </span>
          ) : null}
          <button
            type="button"
            data-attr="where-skip"
            onClick={next}
            className="h-btn-xs cursor-pointer rounded-control border border-solid border-line2 bg-transparent px-(--space-2_5) text-kick font-semibold tracking-head text-fg1 uppercase outline-none hover:text-fg focus-visible:shadow-focus"
          >
            Skip
          </button>
        </>
      }
    >
      {cards.length > 1 ? (
        <div
          role="tablist"
          aria-label="The chips with a where to answer"
          className="flex gap-(--space-1) border-0 border-b border-solid border-line"
        >
          {cards.map((card) => {
            const on = card.id === active.id;
            return (
              <button
                key={card.id}
                type="button"
                role="tab"
                aria-selected={on}
                data-attr="where-card-tab"
                onClick={() => onActivate(card.id)}
                className={cn(
                  '-mb-px cursor-pointer border-0 border-b-2 border-solid bg-transparent px-(--space-2_5) pt-(--space-1) pb-(--space-1_5) text-assist outline-none focus-visible:shadow-focus',
                  on
                    ? 'border-fg font-semibold text-fg'
                    : 'border-transparent text-fg2 hover:text-fg',
                )}
              >
                {card.label}
                {card.where === undefined ? (
                  <span className="ml-(--space-1) text-warn">
                    <span aria-hidden>·</span>
                    <span className="sr-only">no answer yet</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      <WherePicker
        key={active.id}
        {...(active.where !== undefined ? { where: active.where } : {})}
        body={body}
        onChange={active.onChange}
        {...(instrument ? { instrument: true, placing, onPlacing: setPlacing } : {})}
      />
      {instrument && placing ? <SheetHint>Click the water where you mean.</SheetHint> : null}
      {active.onAnotherPlace && active.where !== undefined ? (
        <button
          type="button"
          onClick={() => {
            const id = active.onAnotherPlace?.();
            if (id) onActivate(id);
          }}
          data-attr="where-another-place"
          className="h-btn-xs cursor-pointer self-start rounded-control border border-dashed border-line2 bg-transparent px-(--space-2_5) text-kick font-semibold tracking-head text-fg2 uppercase outline-none hover:text-fg focus-visible:shadow-focus"
        >
          + Another place
        </button>
      ) : null}
    </QuestionBlock>
  );
}

/**
 * What the instrument does with a click on the water while a where card is open: a point, named
 * for the landmark it landed near when there is one (D202).
 */
export function whereClickOnWater(
  where: Where | undefined,
  coord: { lat: number; lng: number },
  landmarks: readonly SheetLandmark[] = [],
): Where | undefined {
  return patchWhere(where, { point: pointFromTap(coord, landmarks, POINT_RADIUS_M) });
}
