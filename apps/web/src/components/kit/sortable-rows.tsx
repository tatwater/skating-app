import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from 'react';

import { cn } from '@/lib/utils';

/**
 * **Rows that reorder by a grip** — Body › Links' *Added by staff* (board 5.4.9)
 * is its first use. No library: pointer events for the drag, and a keyboard path on the grip that
 * follows the console's keys (Round 3: the grip is a control inside its pane; arrows move within).
 *
 * - **The grip** is a button at the row's start (six dots). Press and drag it: the row follows the
 *   pointer between its neighbors, and lets go where it is dropped.
 * - **The keyboard**: with the grip focused, Space lifts the row, ↑↓ move it, Space drops it and
 *   Esc puts it back where it was. ⌥↑ / ⌥↓ move it one place in a single stroke.
 * - **Every move is said**: a polite live region announces the lift, each move, the drop and a
 *   cancel ("Moved to 2 of 3"), naming the row by `labelOf`.
 * - **Nothing is written until the drop**: the order a move draws is a preview; `onReorder` gets
 *   the new order of ids once, on the drop, and only if it changed.
 * - A lifted row rises a step (the lift wash) and its grip lights; every other row stays put.
 * - **The lift never outlives its rows**: when the set of rows changes under it (one is edited
 *   under a new id, added, removed) or the grips are turned off, the lift is put down and the
 *   preview dropped, so a row is never hidden behind an id the preview still holds. Every row in
 *   `items` is drawn exactly once, whatever the preview says.
 * - **`pending`** (a save on its way) keeps every grip mounted and focusable, `aria-disabled`, and
 *   inert — the grip under the keyboard is never taken away from it.
 *
 * Tokens only; the rows' content is the caller's (`renderRow`).
 */

export type SortableRowsProps<T> = {
  items: readonly T[];
  idOf: (item: T) => string;
  /** What a reader hears the row called ("Mascoma Lake Association"). */
  labelOf: (item: T) => string;
  /** The new order of ids, on a drop that changed it. */
  onReorder: (ids: string[]) => void;
  /** The row's content; `grip` is the handle, to place at the row's start. */
  renderRow: (item: T, state: { grip: ReactNode; lifted: boolean }) => ReactNode;
  /** The list's name, for a reader. */
  'aria-label': string;
  /** Turn the grips off (a viewer who can't reorder): no handle is drawn. */
  disabled?: boolean;
  /** A reorder is being saved: the grips stay, focusable and `aria-disabled`, and do nothing. */
  pending?: boolean;
  className?: string;
};

/** `ids` with the one at `from` moved to `to`. Pure; out-of-range indices clamp. */
export function moveId(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  const at = Math.max(0, Math.min(next.length, to));
  next.splice(at, 0, moved as string);
  return next;
}

/** Where a pointer at `y` would drop a row, from the other rows' midpoints (top to bottom). */
export function dropIndex(y: number, midpoints: readonly number[]): number {
  let i = 0;
  while (i < midpoints.length && y > (midpoints[i] as number)) i++;
  return i;
}

const sameOrder = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export function SortableRows<T>({
  items,
  idOf,
  labelOf,
  onReorder,
  renderRow,
  disabled = false,
  pending,
  className,
  'aria-label': ariaLabel,
}: SortableRowsProps<T>) {
  const committed = items.map(idOf);
  const byId = new Map(items.map((item) => [idOf(item), item]));
  // The preview order while a row is lifted; `null` at rest.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // The lift is put down when the rows it describes change under it, or the grips go off: during
  // the render that sees it, so no frame draws a preview of rows that aren't there.
  const keys = [...committed].sort().join('\u0000');
  const [liftedOver, setLiftedOver] = useState(keys);
  if ((draft !== null || lifted !== null) && (keys !== liftedOver || disabled)) {
    setDraft(null);
    setLifted(null);
    // A reader who lifted the row hears that it was put down, not silence.
    if (lifted !== null) {
      const item = byId.get(lifted);
      setMessage(`${item === undefined ? 'The lifted row' : labelOf(item)} was put down.`);
    }
  }
  if (liftedOver !== keys) setLiftedOver(keys);
  // **A drop holds its order while it is saved** (when the caller says so, through `pending`): the
  // rows stay where they were dropped until the new order arrives, so nothing jumps back for the
  // round trip and the grip under the keyboard isn't moved out from under it. A save that ends
  // without the rows moving (it failed) puts them back.
  const saving = pending === true;
  const joined = committed.join('\u0000');
  const [held, setHeld] = useState<{ order: string[]; from: string; saw: boolean } | null>(null);
  if (held !== null) {
    // The grips going off (an edit opened mid-save) doesn't end the save: the drop holds until the
    // rows move or the save ends, so they never snap back for the round trip.
    if (joined !== held.from) setHeld(null);
    else if (saving && !held.saw) setHeld({ ...held, saw: true });
    else if (!saving && held.saw) setHeld(null);
  }
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  // Every row in `items` exactly once: the preview's order for the rows it holds, any it doesn't
  // after them (a belt to the reset above's braces).
  const shown = draft ?? held?.order ?? null;
  const order =
    shown === null
      ? committed
      : [...shown.filter((id) => byId.has(id)), ...committed.filter((id) => !shown.includes(id))];
  const n = order.length;
  const nameOf = (id: string) => {
    const item = byId.get(id);
    return item === undefined ? '' : labelOf(item);
  };

  const refocus = useCallback((id: string) => {
    // The row re-renders in its new place; keep the grip under the keyboard.
    requestAnimationFrame(() => gripRefs.current.get(id)?.focus());
  }, []);

  const lift = (id: string) => {
    setLifted(id);
    setDraft(committed);
    setMessage(
      `Lifted ${nameOf(id)}, ${committed.indexOf(id) + 1} of ${n}. Up and down to move, Space to drop, Escape to cancel.`,
    );
  };
  const drop = (id: string, finalOrder: string[]) => {
    setLifted(null);
    setDraft(null);
    setMessage(`Dropped ${nameOf(id)} at ${finalOrder.indexOf(id) + 1} of ${n}.`);
    if (sameOrder(finalOrder, committed)) return;
    if (pending !== undefined) setHeld({ order: finalOrder, from: joined, saw: false });
    onReorder(finalOrder);
  };
  const cancel = (id: string) => {
    setLifted(null);
    setDraft(null);
    setMessage(`Canceled. ${nameOf(id)} is back at ${committed.indexOf(id) + 1} of ${n}.`);
    refocus(id);
  };
  const step = (id: string, by: -1 | 1, current: string[]) => {
    const from = current.indexOf(id);
    const to = from + by;
    if (to < 0 || to >= current.length) return current;
    const next = moveId(current, from, to);
    setMessage(`Moved ${nameOf(id)} to ${to + 1} of ${n}.`);
    refocus(id);
    return next;
  };

  const onGripKey = (id: string) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (saving) {
      // A save is on its way: the grip keeps focus and takes its keys, and does nothing with them.
      if ([' ', 'Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
      return;
    }
    const up = event.key === 'ArrowUp';
    const down = event.key === 'ArrowDown';
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      if (lifted === id) drop(id, order);
      else lift(id);
      return;
    }
    if (event.key === 'Escape' && lifted === id) {
      event.preventDefault();
      event.stopPropagation();
      cancel(id);
      return;
    }
    if (!up && !down) return;
    event.preventDefault();
    if (lifted === id) {
      setDraft(step(id, up ? -1 : 1, order));
    } else if (event.altKey) {
      // ⌥↑↓: one place, lifted and dropped in one stroke.
      const next = step(id, up ? -1 : 1, committed);
      if (sameOrder(next, committed)) return;
      if (pending !== undefined) setHeld({ order: next, from: joined, saw: false });
      onReorder(next);
    }
  };

  // ── The pointer ─────────────────────────────────────────────────────────────────────────────
  const drag = useRef<{ id: string; pointerId: number } | null>(null);
  const onPointerDown = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || saving) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id, pointerId: event.pointerId };
    lift(id);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    // A lift put down under the pointer (its rows changed, the grips went off) ends the drag too:
    // the pointer never rebuilds a preview with nothing lifted, nor hovers rows into a new order.
    if (lifted !== d.id) {
      drag.current = null;
      return;
    }
    const current = draft ?? committed;
    const others = current.filter((id) => id !== d.id);
    const midpoints = others.map((id) => {
      const r = rowRefs.current.get(id)?.getBoundingClientRect();
      return r === undefined ? 0 : r.top + r.height / 2;
    });
    const to = dropIndex(event.clientY, midpoints);
    const next = moveId(current, current.indexOf(d.id), to);
    if (!sameOrder(next, current)) {
      setDraft(next);
      setMessage(`Moved ${nameOf(d.id)} to ${to + 1} of ${n}.`);
    }
  };
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
    drag.current = null;
    // Its lift was put down mid-drag: nothing is dropped.
    if (lifted !== d.id) return;
    if (event.type === 'pointercancel') cancel(d.id);
    else drop(d.id, draft ?? committed);
  };

  return (
    <div data-slot="sortable-rows" className={cn('flex flex-col', className)}>
      <ul aria-label={ariaLabel} className="m-0 flex list-none flex-col p-0">
        {order.map((id) => {
          const item = byId.get(id);
          if (item === undefined) return null;
          const isLifted = lifted === id;
          const grip = disabled ? null : (
            <button
              type="button"
              ref={(el) => {
                if (el) gripRefs.current.set(id, el);
                else gripRefs.current.delete(id);
              }}
              data-slot="sortable-grip"
              aria-label={`Move ${labelOf(item)}`}
              aria-pressed={isLifted}
              aria-disabled={saving || undefined}
              onKeyDown={onGripKey(id)}
              onPointerDown={onPointerDown(id)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerEnd}
              onPointerCancel={onPointerEnd}
              className={cn(
                'hit inline-flex size-(--type-row) shrink-0 cursor-grab touch-none items-center justify-center',
                'rounded-control text-fg3 outline-none',
                'transition-[color,box-shadow] duration-(--duration-fast) ease-standard',
                'lit:text-fg1 focus-visible:shadow-focus aria-pressed:cursor-grabbing aria-pressed:text-fg',
              )}
            >
              <GripDots />
            </button>
          );
          return (
            <li
              key={id}
              ref={(el) => {
                if (el) rowRefs.current.set(id, el);
                else rowRefs.current.delete(id);
              }}
              data-slot="sortable-row"
              data-lifted={isLifted ? '' : undefined}
              className="transition-[background-color] duration-(--duration-fast) ease-standard data-lifted:bg-lift-08"
            >
              {renderRow(item, { grip, lifted: isLifted })}
            </li>
          );
        })}
      </ul>
      <span data-slot="sortable-status" aria-live="polite" className="sr-only">
        {message}
      </span>
    </div>
  );
}

/** Six dots, two columns of three: the grip's drawing (board 5.4.9's `GRIP`). */
function GripDots() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 8 14"
      className="h-[0.875em] w-[0.5em] fill-current"
      data-slot="grip-dots"
    >
      <circle cx="2" cy="2" r="1" />
      <circle cx="6" cy="2" r="1" />
      <circle cx="2" cy="7" r="1" />
      <circle cx="6" cy="7" r="1" />
      <circle cx="2" cy="12" r="1" />
      <circle cx="6" cy="12" r="1" />
    </svg>
  );
}
