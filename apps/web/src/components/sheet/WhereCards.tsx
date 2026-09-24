import type { Where } from '@skating/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
import { useConsoleMode } from './ConsoleMode';
import { QuestionBlock } from './SheetPanel';
import type { SheetBody } from './useSheetBody';
import { POINT_RADIUS_M, patchWhere, WherePicker } from './WherePicker';

/** One selected chip's where question. */
export interface WhereCard {
  /** `field:key`, stable across renders. */
  id: string;
  label: string;
  where: Where | undefined;
  onChange: (where: Where | undefined) => void;
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
  const { setMode } = useConsoleMode();
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
  }, [open, activeCardId, activeWhere, activeLabel, setMode]);

  if (!open || !active) return null;
  const next = () => {
    const after = cards[(index + 1) % cards.length];
    if (after && cards.length > 1) onActivate(after.id);
    else onClose();
  };

  return (
    <QuestionBlock
      title={`Where is the ${active.label.toLowerCase()}?`}
      onDone={onClose}
      extra={
        <>
          {cards.length > 1 ? (
            <span className="font-mono text-[10px] text-foreground-muted">
              {index + 1} OF {cards.length}
            </span>
          ) : null}
          <button
            type="button"
            onClick={next}
            className="h-[22px] px-2 font-semibold text-[11px] text-foreground-muted uppercase tracking-[0.08em] hover:text-foreground"
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
          className="flex gap-1 border-border border-b"
        >
          {cards.map((card) => {
            const on = card.id === active.id;
            return (
              <button
                key={card.id}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onActivate(card.id)}
                className={cn(
                  '-mb-px border-b-2 px-2.5 pt-1 pb-1.5 text-xs',
                  on
                    ? 'border-primary font-semibold text-foreground'
                    : 'border-transparent text-foreground-muted hover:text-foreground',
                )}
              >
                {card.label}
                {card.where === undefined ? (
                  <span className="ml-1 text-warning">
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
        instrument
        placing={placing}
        onPlacing={setPlacing}
      />
      <p className="text-[11px] text-foreground-muted">
        The ring on the lake is the same list, for the pointer.
        {placing ? ' Click the water where you mean.' : ''}
      </p>
    </QuestionBlock>
  );
}

/** What the instrument does with a click on the water while a where card is open. */
export function whereClickOnWater(
  where: Where | undefined,
  coord: { lat: number; lng: number },
): Where | undefined {
  return patchWhere(where, { point: { coord, radiusMeters: POINT_RADIUS_M } });
}
