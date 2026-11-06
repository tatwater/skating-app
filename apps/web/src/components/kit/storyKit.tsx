/**
 * What every kit story shares: the kicker class a board labels itself with, a state-matrix table,
 * and the small DOM helpers a `play` function leans on. Story-only; nothing in the app imports it.
 */
import type { ReactNode } from 'react';

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
