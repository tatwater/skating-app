/**
 * The Bodies table's virtual rows, as table rows. A real table can't place a row at an offset of
 * its own, so the rows not rendered are spacer rows of their height. **Every gap gets its spacer**:
 * a row pinned into the range (the cursor's, which keeps `aria-activedescendant` naming an element
 * and focus in place) sits apart from the visible run, and the rows between them must still take
 * their room — or the visible rows slide up into it and the scroll height shrinks.
 */

/** The virtualizer's visible run, and the rows pinned into it. */
export type VisibleRange = { startIndex: number; endIndex: number };

/** The indices to render: the visible run (overscan included) and every pinned row, in order. */
export function withPinned(range: VisibleRange, pinned: readonly number[]): number[] {
  const out = new Set<number>();
  for (let i = range.startIndex; i <= range.endIndex; i++) out.add(i);
  for (const p of pinned) if (p >= 0) out.add(p);
  return [...out].sort((a, b) => a - b);
}

/** What the virtualizer hands for each rendered row. */
export type PlacedRow = { index: number; start: number; end: number };

/** A rendered row, or a spacer standing in for the rows between two rendered ones. */
export type LaidOut<T extends PlacedRow> =
  | { kind: 'row'; item: T }
  | { kind: 'pad'; key: string; height: number };

/**
 * The table body in order: a spacer before the first rendered row, between every two rendered rows
 * that aren't neighbors, and after the last, so each rendered row sits at its own offset and the
 * whole is the virtualizer's total height.
 */
export function spacedRows<T extends PlacedRow>(items: readonly T[], total: number): LaidOut<T>[] {
  const out: LaidOut<T>[] = [];
  let at = 0;
  for (const item of items) {
    const gap = item.start - at;
    if (gap > 0) out.push({ kind: 'pad', key: `pad-before-${item.index}`, height: gap });
    out.push({ kind: 'row', item });
    at = Math.max(at, item.end);
  }
  if (total - at > 0) out.push({ kind: 'pad', key: 'pad-end', height: total - at });
  return out;
}
