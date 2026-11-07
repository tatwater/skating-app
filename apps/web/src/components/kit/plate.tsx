import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's plates: the boards' `.card` and `.pl` — a square container marked at its four corners.
 *
 * - **Square** (`radius.container`), as every container is.
 * - **Corner ticks.** A `card` is a hairline box (`line`) with four 3 px ticks (`stroke-run`) set
 *   just over its corners — 1 px proud of the border, 1 px inside it — in the list-body gray. A
 *   `plate` is a filled panel (no border) with smaller 2 px ticks (`stroke-note`) in the rule gray,
 *   the map's floating plates. A tone (`warn`, `bad`) colors the ticks only, by meaning.
 * - **Chosen is a 1 px border, never a thick top edge**: the current or picked card's hairline and
 *   ticks turn the lit ink (`fg`), and nothing changes its size.
 * - **An interactive plate gets the hover bracket**: on hover or keyboard focus (one look for both,
 *   the `lit:` variant) each tick reaches along its two edges into an open corner bracket
 *   (`stroke-tick` arms) in the lit ink. The reach rides the motion tokens, so under reduced motion
 *   it simply appears. It is a button for assistive tech and the keyboard (Enter and Space).
 * - **Content is inset by the padding, and the padding is the junction**: content sits `space-3_5`
 *   × `space-4` inside a card's border (`space-2_5` × `space-3` in a plate), and children stack on
 *   the plate's own gap.
 *
 * The ticks are drawn on `::after` (no extra DOM): eight painted arms, two per corner, that overlap
 * into a square at rest and draw apart into a bracket when lit.
 */

/**
 * Eight arms, two per corner, all in the tick ink (`--ink`): at each corner a horizontal arm
 * (`--arm` long, `--tick` thick) and a vertical one. Written out literally so Tailwind sees them.
 */
const TICKS = [
  "after:pointer-events-none after:absolute after:content-['']",
  'after:inset-[calc(-1*var(--tick-out))] after:bg-no-repeat',
  'after:[--ink:linear-gradient(var(--tick-color),var(--tick-color))]',
  'after:[background-image:var(--ink),var(--ink),var(--ink),var(--ink),var(--ink),var(--ink),var(--ink),var(--ink)]',
  'after:[background-position:left_top,left_top,right_top,right_top,left_bottom,left_bottom,right_bottom,right_bottom]',
  'after:[background-size:var(--arm)_var(--tick),var(--tick)_var(--arm),var(--arm)_var(--tick),var(--tick)_var(--arm),var(--arm)_var(--tick),var(--tick)_var(--arm),var(--arm)_var(--tick),var(--tick)_var(--arm)]',
  'after:transition-[background-size] after:duration-(--duration-fast) after:ease-standard',
  // At rest an arm is as long as the tick is thick: the two overlap into one square.
  '[--arm:var(--tick)]',
];

const plateVariants = cva(
  [
    'relative flex min-w-0 flex-col rounded-container text-left',
    'transition-[border-color,background-color] duration-(--duration-fast) ease-standard',
    ...TICKS,
  ],
  {
    variants: {
      variant: {
        /** The hairline box with 3 px ticks: a card on the field. The default. */
        card: [
          'border-(length:--stroke-hair) border-solid border-line',
          'gap-(--space-2_5) px-(--space-4) py-(--space-3_5)',
          '[--tick:var(--stroke-run)] [--tick-out:calc(var(--stroke-run)-var(--stroke-hair))]',
          '[--tick-color:var(--fg2)]',
        ],
        /** The filled panel with 2 px ticks: a plate over a map or a chart. */
        plate: [
          'bg-panel',
          'gap-(--space-1) px-(--space-3) py-(--space-2_5)',
          '[--tick:var(--stroke-note)] [--tick-out:var(--stroke-hair)]',
          '[--tick-color:var(--line2)]',
        ],
      },
      tone: {
        default: '',
        warn: '[--tick-color:var(--warn)]',
        bad: '[--tick-color:var(--bad)]',
      },
    },
    defaultVariants: { variant: 'card', tone: 'default' },
  },
);

/** Chosen: the hairline and the ticks in the lit ink. Wins over a tone. */
const CHOSEN = 'border-fg [--tick-color:var(--fg)]';

/** Interactive: a pointer, the focus ring, and the bracket when lit. */
const INTERACTIVE = [
  'cursor-pointer outline-none focus-visible:shadow-focus',
  'lit:[--arm:calc(var(--tick)+var(--stroke-tick))] lit:[--tick-color:var(--fg)]',
  'pressed:bg-lift-05',
];

type PlateProps = ComponentProps<'div'> & {
  variant?: 'card' | 'plate';
  /** Ticks by meaning: `warn` waits on a person, `bad` won't recover without one. */
  tone?: 'default' | 'warn' | 'bad';
  /** The current or picked card: a 1 px lit border. Never a thick edge. */
  chosen?: boolean;
  /**
   * Pressing the plate does something (it opens what it shows, or picks it): it becomes a button
   * and gets the hover bracket. Give it an accessible name if its content doesn't make one.
   */
  interactive?: boolean;
};

function Plate({
  variant = 'card',
  tone = 'default',
  chosen = false,
  interactive = false,
  className,
  ...props
}: PlateProps) {
  const data = {
    'data-slot': 'plate',
    'data-variant': variant,
    'data-tone': tone,
    'data-chosen': chosen ? '' : undefined,
    'data-interactive': interactive ? '' : undefined,
  };
  const classes = cn(
    plateVariants({ variant, tone }),
    chosen && CHOSEN,
    interactive && INTERACTIVE,
    className,
  );
  if (!interactive) return <div {...data} className={classes} {...props} />;
  return (
    <ButtonPrimitive
      nativeButton={false}
      render={<div />}
      {...data}
      className={classes}
      // A plate's props are a div's; Base UI renders that div with a button's role and keys.
      {...(props as ButtonPrimitive.Props)}
    />
  );
}

export { Plate, type PlateProps, plateVariants };
