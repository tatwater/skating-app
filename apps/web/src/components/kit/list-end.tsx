import { type ComponentProps, useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's list-end tab: the marker every list ends in ("All 7"), and what an empty list says
 * ("Nothing open"). Custom — not shadcn's Empty: an empty list still says what it is, in the same
 * mark a full one ends with.
 *
 * - **The rule drops into a tab under its label**: a hairline runs edge to edge in `line` (the pane
 *   borders' gray), steps down a 45° shoulder on each side of the label to a floor under it, and
 *   back up. The section rule's square terminals (`stroke-run`, in `line2`) sit at the two outer
 *   bends.
 * - **Measured to its label.** The label (a kicker in `fg3`) lays out first; the drawing is fitted
 *   to it — the shoulders start `space-3` clear of the text, the rule runs a hair under the label's
 *   top, the floor `space-0_5` under its foot (about two pixels of floor show), and the tab is as
 *   deep as that makes it, so every shoulder is 45°. Every length is a token, so the tab grows
 *   with the user's font size (D233) and re-fits when the list or the label changes width.
 * - **Under a last row it sits `space-0_5` down**; an empty list's tab sits the same `space-0_5`
 *   under the bar above it. A list that follows (the decided list) owns its own gap.
 * - The drawing is hidden from readers; the label is the text.
 */

/** The fitted drawing, in px relative to the tab's box. */
type Fit = {
  width: number;
  height: number;
  /** The rule's y, a half-pixel in so a hairline paints one row. */
  rule: number;
  /** The floor's y. */
  floor: number;
  /** The floor's two ends, under the label's padded box. */
  left: number;
  right: number;
  hair: number;
  terminal: number;
};

/** A length token as px. The stroke tokens are px by class (D233), so this is a parse, not a resolve. */
function tokenPx(el: Element, name: string): number {
  return parseFloat(getComputedStyle(el).getPropertyValue(name));
}

function fitTab(root: HTMLElement, label: HTMLElement): Fit {
  const box = root.getBoundingClientRect();
  const text = label.getBoundingClientRect();
  const hair = tokenPx(root, '--stroke-hair');
  const terminal = tokenPx(root, '--stroke-run');
  return {
    width: box.width,
    height: box.height,
    rule: Math.round(text.top - box.top + hair) + hair / 2,
    floor: Math.round(text.bottom - box.top) + hair / 2,
    left: text.left - box.left,
    right: text.right - box.left,
    hair,
    terminal,
  };
}

/** The path: edge, shoulder down, floor, shoulder up, edge. */
function tabPath({ width, rule, floor, left, right }: Fit): string {
  const depth = floor - rule;
  return `M0 ${rule}H${left - depth}L${left} ${floor}H${right}L${right + depth} ${rule}H${width}`;
}

type ListEndProps = ComponentProps<'div'>;

function ListEnd({ className, children, ...props }: ListEndProps) {
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [drawn, setDrawn] = useState<Fit | null>(null);

  useLayoutEffect(() => {
    const el = root.current;
    const text = label.current;
    // (Both are rendered with the effect; the guard is for the type.)
    /* v8 ignore next */
    if (el === null || text === null) return;
    const measure = () => setDrawn(fitTab(el, text));
    measure();
    // The list's width, the label's text, the user's font size and a late web font all move it.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    observer.observe(text);
    let live = true;
    void document.fonts.ready.then(() => {
      // Unmounted before the font landed: an unmount race, not a case worth a test.
      /* v8 ignore next */
      if (live) measure();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={root}
      data-slot="list-end"
      className={cn('relative mt-(--space-0_5) flex w-full justify-center', className)}
      {...props}
    >
      {drawn !== null && (
        <svg
          data-slot="list-end-tab"
          aria-hidden="true"
          width={drawn.width}
          height={drawn.height}
          viewBox={`0 0 ${drawn.width} ${drawn.height}`}
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          <path
            d={tabPath(drawn)}
            className="fill-none stroke-line"
            style={{ strokeWidth: drawn.hair }}
          />
          {[drawn.left - (drawn.floor - drawn.rule), drawn.right + (drawn.floor - drawn.rule)].map(
            (x) => (
              <rect
                key={x}
                data-slot="list-end-terminal"
                x={x - drawn.terminal / 2}
                y={drawn.rule - drawn.terminal / 2}
                width={drawn.terminal}
                height={drawn.terminal}
                className="fill-line2"
              />
            ),
          )}
        </svg>
      )}
      <span
        ref={label}
        data-slot="list-end-label"
        className={cn(
          // The padded box is the floor: `space-3` clear of the text each side, `space-0_5` of floor
          // under it. The left pad adds the kicker's tracking back, which trails the last letter.
          'relative box-content flex h-(--space-3) items-center whitespace-nowrap',
          'mt-(--space-2) mb-(--space-1) pb-(--space-0_5)',
          'pr-(--space-3) pl-[calc(var(--space-3)+var(--track-kick))]',
          'text-kick leading-none font-semibold tracking-kick text-fg3 uppercase',
        )}
      >
        {children}
      </span>
    </div>
  );
}

export { ListEnd, type ListEndProps };
