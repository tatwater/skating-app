import type { ComponentProps, ReactElement } from 'react';

import { Plate } from './plate';

/**
 * A lanes group dressed apart from the others: the seasonal Pre-Season Pass while it waits on a
 * person. The dress says the group is **applied** to the sidebar — extra, for now — and that it is
 * the thing being worked on. Each dress is one recipe here; there is one today (the founder's pick,
 * 2026-11-24), and another would be an entry beside it.
 *
 * A dress keeps the lanes' one alignment: the group's kicker, names and counts sit on the same
 * 18 px line (`space-4_5`) as every other group's, whatever box the dress adds — the row's own
 * inset gives back what the box's inset and edge take.
 *
 * **`bracketed`** — the kit's `Plate` card in the warn tone, inset `space-2` from the column's
 * edges and its top: a hairline box whose four corners are **amber corner marks**. A card's own
 * ticks (3 px squares) are lost at the sidebar's scale, and its hover bracket (short 3 px arms, set
 * 1 px proud) means "press this" — so the marks are drawn as neither: thin (`stroke-note`) and
 * long (two `stroke-tick`s), laid flush on the box's own corners, so they read as the frame's
 * corners, the way a mount holds a print, never as a lit control. Drawn on the group only;
 * `Plate` is untouched for its other callers.
 */

type LaneDress = 'bracketed';

type LaneDressRecipe = {
  /** The group's element: its ground, its edge, its inset from the column. */
  group: string;
  /** Renders the group as another kit part (the bracketed card is a `Plate`). */
  render?: (props: ComponentProps<'div'>) => ReactElement;
  /** The kicker's ink, and its inset matched to the rows'. */
  kicker: string;
  /** A lane row's inset, so its name and count stay on the column's line. */
  row: string;
  /** The group's foot (its meter and line): the rows' inset. */
  foot: string;
  /** The column's top padding when this group leads it. */
  lead: string;
};

/** Inside a 1 px box inset `space-2`: the 18 px line, less the inset and the border. */
const IN_HAIRLINE_BOX = 'px-[calc(var(--space-4_5)-var(--space-2)-var(--stroke-hair))]';

const LANE_DRESSES: Record<LaneDress, LaneDressRecipe> = {
  bracketed: {
    group: [
      // Inset as far from the column's sides as from its top (`lead`); the same step to the
      // kicker and from the foot, the hairline included.
      'mx-(--space-2) gap-(--space-0_5) px-0 py-[calc(var(--space-3)-var(--stroke-hair))]',
      // The corner marks: thin, long, flush on the hairline's corner (the hover bracket is short,
      // thick and set proud).
      '[--tick:var(--stroke-note)] [--tick-out:var(--stroke-hair)] [--arm:calc(2*var(--stroke-tick))]',
    ].join(' '),
    render: (props) => <Plate variant="card" tone="warn" {...props} />,
    kicker: `${IN_HAIRLINE_BOX} text-fg`,
    row: IN_HAIRLINE_BOX,
    foot: IN_HAIRLINE_BOX,
    lead: 'pt-(--space-2)',
  },
};

export { LANE_DRESSES, type LaneDress, type LaneDressRecipe };
