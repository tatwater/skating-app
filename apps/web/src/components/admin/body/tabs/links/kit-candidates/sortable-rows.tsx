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
 * A kit candidate: **rows that reorder by a grip** — Body › Links' *Added by staff* (board 5.4.9)
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
  className,
  'aria-label': ariaLabel,
}: SortableRowsProps<T>) {
  const committed = items.map(idOf);
  const byId = new Map(items.map((item) => [idOf(item), item]));
  // The preview order while a row is lifted; `null` at rest.
  const [draft, setDraft] = useState<string[] | null>(null);
  const [lifted, setLifted] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const gripRefs = useRef(new Map<string, HTMLButtonElement>());
  const order = draft ?? committed;
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
    if (!sameOrder(finalOrder, committed)) onReorder(finalOrder);
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
      if (!sameOrder(next, committed)) onReorder(next);
    }
  };

  // ── The pointer ─────────────────────────────────────────────────────────────────────────────
  const drag = useRef<{ id: string; pointerId: number } | null>(null);
  const onPointerDown = (id: string) => (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = { id, pointerId: event.pointerId };
    lift(id);
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== event.pointerId) return;
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
