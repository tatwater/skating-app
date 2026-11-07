/**
 * What every kit story shares: the kicker class a board labels itself with, a state-matrix table,
 * and the small DOM helpers a `play` function leans on. Story-only; nothing in the app imports it.
 */
import { type ReactNode, useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

/**
 * Overlay stories open on a press, never on mount (the kit introduction's rule): a story shows the
 * trigger, its `play` presses it to check the open state, and closes it again before it ends, so
 * the page stays browsable. `openWith` is the press; `closeWithEscape` is the way out.
 */
export async function openWith(
  canvasElement: HTMLElement,
  name: string | RegExp,
  role: 'button' | 'combobox' = 'button',
): Promise<HTMLElement> {
  const trigger = within(canvasElement).getByRole(role, { name });
  await userEvent.click(trigger);
  return trigger;
}

/** Presses Esc and waits until `isOpen` reports the overlay gone. */
export async function closeWithEscape(isOpen: () => Element | null): Promise<void> {
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(isOpen()).toBeNull());
}

/** What an overlay root's `onOpenChange` hands over, as far as a quad needs it. */
type OpenChangeDetails = { reason: string; event?: Event | undefined };

/**
 * A four-up quad's overlay state, for a quad that renders its own trigger. Pressing (or focusing)
 * something in another quad doesn't close this one, so all four can stand open side by side to be
 * compared; Esc, the overlay's own close, and a press anywhere else still do. Pair it with a
 * non-modal root: four focus traps at once would fight.
 */
export function useQuadOpen(frame: HTMLElement | null) {
  const [open, setOpen] = useState(false);
  const onOpenChange = (next: boolean, details: OpenChangeDetails) => {
    // Whatever the reason (a press, focus leaving, a select's canceled open), a close that lands
    // in another quad is ignored. Esc is never ignored.
    if (!next && details.reason !== 'escape-key') {
      const event = details.event;
      const to = event instanceof FocusEvent ? event.relatedTarget : event?.target;
      const other = to instanceof Element ? to.closest('[data-theme-scope]') : null;
      if (other != null && other !== frame?.closest('[data-theme-scope]')) return;
    }
    setOpen(next);
  };
  return { open, onOpenChange };
}

/** The real pointer the story tests install (`src/test/storybook.setup.ts`). */
export type RealPointer = {
  /** Move the real mouse over `el`, so CSS `:hover` matches it. */
  hover: (el: Element) => Promise<void>;
  /** Move it off the page again. */
  park: () => Promise<void>;
};

declare global {
  var __kitRealPointer: RealPointer | undefined;
}

/**
 * The real pointer, for a story that tests CSS `:hover` — `userEvent.hover` dispatches events,
 * which never match it. Only the story tests have one, so such a story is tagged `!dev` (out of
 * the sidebar) and fails, never skips, when it runs without it.
 */
export function realPointer(): RealPointer {
  const pointer = globalThis.__kitRealPointer;
  // Only Storybook's own UI lacks the pointer, and the story tests always install it, so no test
  // can reach the throw; it's there so the UI says why instead of failing on `undefined`.
  /* v8 ignore next 3 */
  if (pointer === undefined) {
    throw new Error('This story drives the real pointer; it runs under the story tests only.');
  }
  return pointer;
}

/**
 * Resolves once every animation and transition running on `el` has finished (a canceled one
 * counts as done), so what's read next is the state's color, not a frame of the way there.
 */
export async function settled(el: Element): Promise<void> {
  await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
}

/**
 * What `read` says once the real pointer is over `target` and `watch`'s transitions have settled —
 * for a story that checks what CSS `:hover` does (and doesn't) change.
 */
export async function underPointer(
  target: Element,
  read: () => string,
  watch: Element = target,
): Promise<string> {
  await realPointer().hover(target);
  await settled(watch);
  return read();
}

/** The kicker a board's row and column labels wear. */
export const KICKER = 'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase';

/** The element a story rendered, or a failed test that says it's missing. */
export function must<T>(el: T | null | undefined): T {
  if (el == null) throw new Error('The story did not render the element under test.');
  return el;
}

/** The root font size in px: what a rem token resolves against. */
export function rootPx(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize);
}

/**
 * A labeled grid of variants (rows) × states (columns), each cell rendered by `cell`. The states a
 * board draws are forced with the pseudo-states addon by `data-state` (see each story's
 * `parameters.pseudo`).
 */
export function StateMatrix<R extends string, S extends string>({
  rows,
  states,
  cell,
}: {
  rows: ReadonlyArray<{ key: R; label: string }>;
  states: ReadonlyArray<{ key: S; label: string }>;
  cell: (row: R, state: S) => ReactNode;
}) {
  return (
    <table className="border-separate border-spacing-x-6 border-spacing-y-4 text-left">
      <thead>
        <tr>
          <th />
          {states.map(({ key, label }) => (
            <th key={key} scope="col" className={KICKER}>
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key: row, label }) => (
          <tr key={row}>
            <th scope="row" className={KICKER}>
              {label}
            </th>
            {states.map(({ key: state }) => (
              <td key={state}>{cell(row, state)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The pseudo-states addon's selectors for the hover / focus / pressed columns of a matrix. */
export const PSEUDO_STATES = {
  pseudo: {
    hover: ['[data-state="hover"]'],
    focusVisible: ['[data-state="focus"]'],
    active: ['[data-state="active"]'],
  },
} as const;
