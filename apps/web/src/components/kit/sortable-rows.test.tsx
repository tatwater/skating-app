import { act, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { useState } from 'react';
import { beforeAll, describe, expect, it } from 'vitest';

import { SortableRows } from './sortable-rows';

/**
 * The lift never outlives its rows: whatever is lifted, moved, dropped, edited (a row under a new
 * id), added, removed or changed from outside, every row in `items` is drawn exactly once, and no
 * order handed to `onReorder` names a row that isn't there. A save in flight keeps every grip.
 */

beforeAll(() => {
  // The kit refocuses a moved grip on the next frame.
  globalThis.requestAnimationFrame ??= (cb: FrameRequestCallback) => setTimeout(cb, 0) as never;
});

type Row = { id: string; label: string };

let reorders: string[][] = [];
let live: { set: (rows: Row[]) => void; rows: () => Row[] } = {
  set: () => {},
  rows: () => [],
};

function Harness({ initial, pending }: { initial: Row[]; pending?: boolean }) {
  const [rows, setRows] = useState(initial);
  live = { set: setRows, rows: () => rows };
  return (
    <SortableRows<Row>
      aria-label="Rows"
      items={rows}
      idOf={(r) => r.id}
      labelOf={(r) => r.label}
      pending={pending}
      onReorder={(ids) => {
        const now = live.rows();
        // Record whether the order is of exactly the rows there are when it is handed over.
        const there = now.map((r) => r.id).sort();
        reorders.push([...ids].sort().join() === there.join() ? ids : ['stale', ...ids]);
        setRows(ids.flatMap((id) => now.filter((r) => r.id === id)));
      }}
      renderRow={(row, { grip }) => (
        <span data-row={row.id}>
          {grip}
          {row.label}
        </span>
      )}
    />
  );
}

const drawn = () =>
  [...document.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.dataset.row);
const grip = (label: string) => screen.getByRole('button', { name: `Move ${label}` });

describe('SortableRows — the lift and its rows', () => {
  it('a row edited under a new id while another is lifted is still drawn (the review’s case)', () => {
    reorders = [];
    render(
      <Harness
        initial={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    fireEvent.keyDown(grip('Alpha'), { key: ' ' });
    // Beta is edited: its words change, and with them a key made from them.
    act(() =>
      live.set([
        { id: 'a', label: 'Alpha' },
        { id: 'b2', label: 'Beta, renamed' },
      ]),
    );
    expect(drawn()).toEqual(['a', 'b2']);
    expect(grip('Alpha')).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps every grip mounted and focusable while a save is pending, and inert', () => {
    reorders = [];
    render(
      <Harness
        pending
        initial={[
          { id: 'a', label: 'Alpha' },
          { id: 'b', label: 'Beta' },
        ]}
      />,
    );
    const g = grip('Alpha');
    g.focus();
    expect(g).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(g, { key: ' ' });
    expect(g).toHaveAttribute('aria-pressed', 'false');
    expect(g).toHaveFocus();
  });

  type Op =
    | { kind: 'lift' | 'drop' | 'edit' | 'remove'; at: number }
    | { kind: 'move'; up: boolean }
    | { kind: 'add' }
    | { kind: 'shuffle'; seed: number };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constantFrom('lift', 'drop', 'edit', 'remove'), at: fc.nat(6) }),
    fc.record({ kind: fc.constant('move'), up: fc.boolean() }),
    fc.record({ kind: fc.constant('add') }),
    fc.record({ kind: fc.constant('shuffle'), seed: fc.nat() }),
  ) as fc.Arbitrary<Op>;

  it('every row drawn exactly once, every reorder only of rows that are there (fast-check)', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 14 }), (ops) => {
        reorders = [];
        let minted = 0;
        const { unmount } = render(
          <Harness
            initial={[
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
              { id: 'c', label: 'C' },
            ]}
          />,
        );
        let liftedLabel: string | null = null;
        for (const o of ops) {
          const rows = live.rows();
          const pick = 'at' in o && rows.length > 0 ? rows[o.at % rows.length] : undefined;
          act(() => {
            if (o.kind === 'lift' && pick) {
              fireEvent.keyDown(grip(pick.label), { key: ' ' });
              liftedLabel = pick.label;
            } else if (
              o.kind === 'move' &&
              liftedLabel &&
              rows.some((r) => r.label === liftedLabel)
            ) {
              fireEvent.keyDown(grip(liftedLabel), { key: o.up ? 'ArrowUp' : 'ArrowDown' });
            } else if (
              o.kind === 'drop' &&
              liftedLabel &&
              rows.some((r) => r.label === liftedLabel)
            ) {
              fireEvent.keyDown(grip(liftedLabel), { key: ' ' });
              liftedLabel = null;
            } else if (o.kind === 'edit' && pick) {
              const id = `e${++minted}`;
              live.set(rows.map((r) => (r === pick ? { id, label: `${r.label}′` } : r)));
              if (liftedLabel === pick.label) liftedLabel = null;
            } else if (o.kind === 'remove' && pick) {
              live.set(rows.filter((r) => r !== pick));
              if (liftedLabel === pick.label) liftedLabel = null;
            } else if (o.kind === 'add') {
              const id = `n${++minted}`;
              live.set([...rows, { id, label: id.toUpperCase() }]);
            } else if (o.kind === 'shuffle') {
              const next = [...rows];
              if (next.length > 1) next.push(next.splice(o.seed % next.length, 1)[0] as Row);
              live.set(next);
            }
          });
          const ids = live.rows().map((r) => r.id);
          // Every row in `items` exactly once, nothing else.
          expect([...drawn()].sort()).toEqual([...ids].sort());
        }
        // Every reorder was of exactly the rows there were: none stale, none missing.
        for (const order of reorders) expect(order[0]).not.toBe('stale');
        unmount();
      }),
      { numRuns: 60 },
    );
  });
});
