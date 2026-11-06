import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cva } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * The kit's Switch: shadcn's Base UI switch, re-skinned to the console's pill toggle (the layer
 * rack's `.layers > span i`). With people's circles, a switch's track is the standing exception
 * to square corners (`rounded-toggle`).
 *
 * - **Sized by the kicker step**: the track is 2 × 1 kickers (20 × 10 on the console, a touch
 *   larger on skater), the knob 0.6 of one — density follows the surface with no size prop.
 * - **On** brightens the rim, lifts the track and lights the knob with its glow.
 * - **Disabled is dashed with no knob**, never faded (a layer with nothing to draw); its key stays.
 * - **Optical spacing.** A bare `Switch` keeps its box to the track and grows its pointer area
 *   (`hit`). A `SwitchRow` is the whole control — switch, label and key in one press target: on
 *   a plate (the layer rack), or bare and bled (a log's Follow).
 */

/**
 * The track — drawn from the root's state, so it serves both the bare switch and a row. Its rim
 * reads `--rim`, which the root sets (`ROOT`): a custom property can follow the root's own
 * `lit:` state, where a `group-` variant can't compound with it.
 */
const TRACK = [
  'relative inline-flex shrink-0 items-center',
  'h-(--type-kick) w-[calc(var(--type-kick)*2)] rounded-toggle border border-solid border-(--rim)',
  'transition-[border-color,background-color] duration-(--duration-fast) ease-standard',
  'group-data-checked/switch:bg-lift-12 group-data-disabled/switch:border-dashed',
];

/**
 * The knob: one hairline in from the rim at rest; on, it travels to one hairline in from the far
 * rim — the track's padding box (2 kickers − 2 rims) less the knob and both insets.
 */
const THUMB = [
  'absolute top-1/2 left-px size-[calc(var(--type-kick)*0.6)] -translate-y-1/2 rounded-full bg-fg3',
  'transition-[translate,background-color,box-shadow] duration-(--duration-fast) ease-standard',
  'data-checked:translate-x-[calc(var(--type-kick)*1.4-4px)] data-checked:bg-fg data-checked:shadow-glow-w',
  'data-disabled:opacity-0',
];

function Track() {
  return (
    <span data-slot="switch-track" className={cn(TRACK)}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={cn(THUMB)} />
    </span>
  );
}

/** Rest, lit (hover or keyboard focus, while off), on and disabled rims — one property. */
const ROOT = [
  'group/switch cursor-pointer outline-none data-disabled:cursor-default',
  '[--rim:var(--fg3)] lit:not-data-checked:[--rim:var(--fg2)]',
  'data-checked:[--rim:var(--fg)] data-disabled:[--rim:var(--line2)]',
];

/** A bare switch: the box is the track; the pointer area grows by the hit pad. Needs a name. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(ROOT, 'hit inline-flex rounded-toggle focus-visible:shadow-focus', className)}
      {...props}
    >
      <Track />
    </SwitchPrimitive.Root>
  );
}

const rowVariants = cva(
  [
    ROOT,
    'items-center gap-[0.9em] whitespace-nowrap select-none',
    'text-kick leading-none font-medium tracking-label uppercase',
    'transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
    'focus-visible:shadow-focus data-disabled:text-fg-disabled',
  ],
  {
    variants: {
      variant: {
        /** The layer rack: a plate per row; an on row lifts one even band over it. */
        plate: [
          'flex h-btn-sm px-[0.75em] rounded-control bg-plate text-fg3',
          'lit:not-data-checked:text-fg1 data-checked:text-fg',
          'data-checked:bg-[linear-gradient(var(--lift-08),var(--lift-08))]',
        ],
        /** Bare (a log's Follow): no plate and no key; it bleeds, so its text lines up with text. */
        bare: 'bleed inline-flex rounded-control font-semibold text-fg2 lit:bg-lift-08 lit:text-fg data-checked:text-fg',
      },
    },
    defaultVariants: { variant: 'plate' },
  },
);

type SwitchRowProps = Omit<SwitchPrimitive.Root.Props, 'children'> & {
  /** The row's name ("Bathy", "Follow"). Written capitalized; the row sets it in caps. */
  label: ReactNode;
  /** The key that toggles it, shown as a cap at the row's end. A disabled row keeps it, faded. */
  kbd?: string;
  variant?: 'plate' | 'bare';
};

/** Switch + label + key as one control: the whole row is the press target. */
function SwitchRow({
  label,
  kbd,
  variant = 'plate',
  className,
  disabled,
  ...props
}: SwitchRowProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch-row"
      data-variant={variant}
      aria-keyshortcuts={kbd}
      disabled={disabled}
      className={cn(rowVariants({ variant }), className)}
      {...props}
    >
      <Track />
      <span data-slot="switch-label">{label}</span>
      {kbd !== undefined && (
        <Kbd aria-hidden disabled={disabled} className="ml-auto">
          {kbd}
        </Kbd>
      )}
    </SwitchPrimitive.Root>
  );
}

export { Switch, SwitchRow, type SwitchRowProps };
