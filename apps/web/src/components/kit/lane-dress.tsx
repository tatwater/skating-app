import type { ComponentProps, ReactElement } from 'react';

import { Plate } from './plate';

/**
 * A lanes group dressed apart from the others: the seasonal Pre-Season Pass, which appears each July
 * and goes once every item in it is decided. The dress says it is **applied** to the sidebar — extra,
 * temporary — and that it waits on a person. One recipe per dress, each whole in its entry here
 * (and, for `inverted`, the `inv-*` tokens in `@skating/design`), so the dress the founder picks
 * stays and the others delete as a unit.
 *
 * Every dress keeps the lanes' one alignment: a dressed group's kicker, names and counts sit on the
 * same 18 px line (`space-4_5`) as every other group's, whatever box or rule the dress adds — the
 * row's own inset gives back what the box's inset and edge take.
 *
 * - **`inverted`** — the group on the inverted ground (`inv-bg`), inset `space-2` from the
 *   column's edges, square. Inside it every lane state is the other mode's own: the plate rebinds the
 *   inks, washes and accents to their `inv-*` values, so the hover wash, the chosen plate and its
 *   2 px bar, the focus ring, dim and the amber and red counts all carry over with their contrast.
 * - **`bracketed`** — the kit's `Plate` card in the warn tone: a hairline box, amber corner ticks.
 * - **`taped`** — an amber die line round the group: a long dash (`stroke-tick` on, `stroke-now`
 *   off), drawn, not a CSS `dashed` border — the console's short dash already means "nothing to
 *   draw" (a disabled layer) and "dim" (the outline badge), and this one must not read as either.
 * - **`edge`** — no box: a 2 px amber rule (`stroke-note`) down the column's own left edge, the
 *   amber tint behind the group, the kicker in amber. The rows step in `space-2` from the rule, so
 *   the chosen lane's own 2 px bar never touches it.
 */

type LaneDress = 'inverted' | 'bracketed' | 'taped' | 'edge';

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

/** A boxed dress sits as far under the column's top as it sits in from the column's sides. */
const BOXED_LEAD = 'pt-(--space-2)';
const BOXED = 'mx-(--space-2) py-(--space-3)';
/** A boxed dress with a 1 px edge: the same step to its kicker and from its foot, edge included. */
const HAIRLINE_BOXED = 'mx-(--space-2) py-[calc(var(--space-3)-var(--stroke-hair))]';
/** Inside a box inset `space-2`: the 18 px line, less the inset. */
const IN_BOX = 'px-[calc(var(--space-4_5)-var(--space-2))]';
/** Inside a 1 px box inset `space-2`: the 18 px line, less the inset and the border. */
const IN_HAIRLINE_BOX = 'px-[calc(var(--space-4_5)-var(--space-2)-var(--stroke-hair))]';
/** Past the edge's rule and its gutter: the 18 px line, less both. */
const PAST_EDGE = 'ps-[calc(var(--space-4_5)-var(--space-2)-var(--stroke-note))]';

const LANE_DRESSES: Record<LaneDress, LaneDressRecipe> = {
  inverted: {
    group: [
      BOXED,
      'bg-inv-bg',
      // A patch of the other mode: every utility inside reads these.
      '[--bg:var(--inv-bg)] [--fg:var(--inv-fg)] [--fg1:var(--inv-fg1)] [--fg2:var(--inv-fg2)]',
      '[--fg3:var(--inv-fg3)] [--line:var(--inv-line)] [--warn:var(--inv-warn)] [--bad:var(--inv-bad)]',
      '[--lift-05:var(--inv-lift-05)] [--lift-08:var(--inv-lift-08)]',
      // The chosen lane's bar resolves its ink where the token is declared, so it is re-declared.
      '[--box-shadow-select-rule:inset_var(--stroke-note)_0_0_0_var(--inv-fg)]',
    ].join(' '),
    // The kicker in the plate's amber: the plate says applied, its name says it waits on a person.
    kicker: `${IN_BOX} text-warn`,
    row: IN_BOX,
    foot: IN_BOX,
    lead: BOXED_LEAD,
  },
  bracketed: {
    // The ticks drawn open, as brackets: at rest a 3 px tick is lost at the sidebar's scale. Amber,
    // never the lit ink, so the brackets don't read as a hover.
    group: `${HAIRLINE_BOXED} gap-(--space-0_5) px-0 [--arm:calc(var(--tick)+var(--stroke-tick))]`,
    render: (props) => <Plate variant="card" tone="warn" {...props} />,
    kicker: `${IN_HAIRLINE_BOX} text-fg`,
    row: IN_HAIRLINE_BOX,
    foot: IN_HAIRLINE_BOX,
    lead: BOXED_LEAD,
  },
  taped: {
    group: [
      HAIRLINE_BOXED,
      // The die line: four dashed edges, each a repeating run of amber along a 1 px strip, painted
      // in a clear 1 px border, so a row's wash never covers it.
      'border-(length:--stroke-hair) border-solid border-transparent [background-origin:border-box] [background-clip:border-box]',
      'bg-no-repeat [background-image:var(--dash-x),var(--dash-x),var(--dash-y),var(--dash-y)]',
      '[--dash-x:repeating-linear-gradient(90deg,var(--warn)_0_var(--stroke-tick),transparent_var(--stroke-tick)_calc(var(--stroke-tick)+var(--stroke-now)))]',
      '[--dash-y:repeating-linear-gradient(180deg,var(--warn)_0_var(--stroke-tick),transparent_var(--stroke-tick)_calc(var(--stroke-tick)+var(--stroke-now)))]',
      '[background-position:left_top,left_bottom,left_top,right_top]',
      '[background-size:100%_var(--stroke-hair),100%_var(--stroke-hair),var(--stroke-hair)_100%,var(--stroke-hair)_100%]',
    ].join(' '),
    kicker: `${IN_HAIRLINE_BOX} text-fg`,
    row: IN_HAIRLINE_BOX,
    foot: IN_HAIRLINE_BOX,
    lead: BOXED_LEAD,
  },
  edge: {
    // The rule on the column's own edge, the tint to its other edge; the rows step in from the rule.
    group: [
      'border-0 border-s-(length:--stroke-note) border-solid border-warn bg-warn-tint',
      'ps-(--space-2) pt-(--space-3_5) pb-(--space-3)',
    ].join(' '),
    kicker: `${PAST_EDGE} text-warn`,
    row: PAST_EDGE,
    foot: PAST_EDGE,
    lead: 'pt-0',
  },
};

export { LANE_DRESSES, type LaneDress, type LaneDressRecipe };
