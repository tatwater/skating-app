import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightFromSquare, faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The kit's Button: shadcn's Base UI button, re-skinned to the console's register. The proving atom
 * for every pattern the kit copies:
 *
 * - **Tokens only.** Every color, size, radius, type step and duration is a semantic token
 *   (`@skating/design`); no primitive, no raw color. Insets are in `em` so they track the label's
 *   own type step (D233).
 * - **Density is the surface's.** There is no compact size: `h-btn`, `text-kick` and the hit pad
 *   resolve per `data-surface`, so the same Button is denser on admin than on skater.
 * - **The control radius** (`rounded-control`): pressable things take the surface's control radius —
 *   rounded on skater, square on the console. Containers are square everywhere.
 * - **No red at rest.** `danger` rests like any outlined action; red appears only once it is
 *   `armed` (a confirm step), and an armed button that waits for something (a reason) is `armed`
 *   *and* `disabled` — its label dims to `bad-dim`.
 * - **No underlined link.** `link` is the outlined navigation chip that ends in "→" (or the new-tab
 *   glyph with `external`).
 * - **One hover/focus look.** Every action lights to the filled face with its corner dots — the
 *   primary's resting look — via the `lit:` variant (`styles/kit.css`), on the motion tokens.
 * - **Optical spacing (D234).** `bare` with a label *bleeds* (its padding is given back as negative
 *   margin, so its text lines up with bare text); `bare` icon buttons use an *expanded hit target*
 *   (the box is the glyph's square; the pointer area grows by the same token pair).
 * - **Loading reserves its size.** The label stays in place at zero opacity under the spinner, so
 *   nothing shifts and the accessible name survives.
 */
/** The variants with a face or a rule — everything but `bare`. */
const FACED: Array<'outline' | 'primary' | 'danger' | 'link'> = [
  'outline',
  'primary',
  'danger',
  'link',
];

const buttonVariants = cva(
  [
    'group/button relative inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap select-none outline-none',
    'rounded-control font-(family-name:--family-sans)',
    'transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
    'pressed:duration-(--duration-instant) focus-visible:shadow-focus',
    'data-disabled:cursor-default aria-busy:cursor-progress',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        /** An outlined action — how every button in a bar rests. The default. */
        outline: [
          'corner-dots inset-ring inset-ring-line2 text-fg1',
          'lit:bg-raise lit:text-fg lit:inset-ring-transparent lit:[--dot-opacity:1] lit:[--dot-glow:var(--glow)]',
          'pressed:bg-lift-12',
          'data-disabled:text-fg-disabled data-disabled:inset-ring-line',
        ],
        /** The one default action: the filled face with its corner dots, at rest. */
        primary: [
          'corner-dots bg-raise text-fg [--dot-opacity:1]',
          'lit:[--dot-glow:var(--glow)]',
          'pressed:bg-lift-12',
          'data-disabled:text-fg-disabled data-disabled:[--dot-opacity:0]',
        ],
        /**
         * A destructive action. Rests like `outline` — never red until `armed`; an armed one that
         * is also `disabled` waits (its label dims to `bad-dim`, and it can't be pressed).
         */
        danger: [
          'corner-dots inset-ring inset-ring-line2 text-fg1',
          'lit:bg-raise lit:text-fg lit:inset-ring-transparent lit:[--dot-opacity:1] lit:[--dot-glow:var(--glow)]',
          'pressed:bg-lift-12',
          'data-disabled:text-fg-disabled data-disabled:inset-ring-line',
          'data-armed:bg-raise data-armed:text-bad data-armed:inset-ring-transparent',
          'data-armed:[--dot-color:var(--bad)] data-armed:[--dot-opacity:1]',
          'data-armed:lit:text-bad data-armed:lit:[--dot-glow:var(--bad-glow)]',
          'data-armed:data-disabled:text-bad-dim data-armed:data-disabled:[--dot-color:var(--bad-dim)]',
        ],
        /** Navigation to another view: the outlined chip ending in "→". */
        link: [
          'inset-ring inset-ring-line2 text-fg font-medium tracking-label',
          'lit:bg-lift-08',
          'pressed:bg-lift-12',
          'data-disabled:text-fg-disabled data-disabled:inset-ring-line',
        ],
        /**
         * No face and no rule at rest — a clickable row label or an icon in a list. Row type, not
         * kicker type. Bleeds (label) or grows its hit target (icon), so it never inflates a gap.
         */
        bare: [
          'text-fg2 text-row leading-none font-regular tracking-normal normal-case',
          'lit:bg-lift-08 lit:text-fg',
          'pressed:bg-lift-12',
          'data-disabled:text-fg-disabled',
        ],
      },
      // Heights and the icon gap only. Insets belong to the variant: a faced button pads in `em`,
      // a bare one takes the bleed's hit pad — two sources of padding would fight.
      size: {
        default: 'h-btn gap-[0.8em]',
        sm: 'h-btn-sm gap-[0.7em]',
        xs: 'h-btn-xs gap-[0.6em]',
        /** In a row: the chip that fits a 22 px row (Home's "Inbox →"), 18 on the console. */
        row: 'h-btn-row gap-[0.6em]',
        icon: 'size-btn text-row leading-none',
        'icon-sm': 'size-btn-sm text-row leading-none',
        'icon-xs': 'size-btn-xs text-assist leading-none',
      },
    },
    compoundVariants: [
      // The kicker label every faced button carries (`--text-kick`, semibold caps, tracked).
      // `leading-none` follows the size: tailwind-merge drops a leading set before a font size.
      {
        variant: FACED,
        size: ['default', 'sm', 'xs', 'row'],
        className: 'text-kick leading-none font-semibold uppercase',
      },
      { variant: ['outline', 'primary', 'danger'], className: 'tracking-head' },
      // Faced insets, in `em` so they track the label's own type step (D233).
      { variant: FACED, size: 'default', className: 'px-[1.4em]' },
      { variant: FACED, size: 'sm', className: 'px-[1em]' },
      { variant: FACED, size: ['xs', 'row'], className: 'px-[0.8em]' },
      // A bare label bleeds: the box is content + the hit pad, given back as negative margin.
      {
        variant: 'bare',
        size: ['default', 'sm', 'xs', 'row'],
        className: 'bleed h-auto justify-start gap-[0.5em]',
      },
      // A bare icon keeps its square and grows its pointer area instead.
      { variant: 'bare', size: ['icon', 'icon-sm', 'icon-xs'], className: 'hit' },
    ],
    defaultVariants: {
      variant: 'outline',
      size: 'default',
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** `danger` only: the confirm step — red label and dots. With `disabled`, it waits. */
    armed?: boolean;
    /** Busy: a spinner over the label, which keeps its place so nothing shifts. Not pressable. */
    loading?: boolean;
    /** `link` only: the destination opens in a new tab — the new-tab glyph replaces the arrow. */
    external?: boolean;
  };

function Button({
  className,
  variant = 'outline',
  size = 'default',
  armed = false,
  loading = false,
  external = false,
  disabled,
  focusableWhenDisabled,
  children,
  ...props
}: ButtonProps) {
  const isLink = variant === 'link';
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-armed={variant === 'danger' && armed ? '' : undefined}
      aria-busy={loading || undefined}
      // A button that starts loading keeps focus: busy is "disabled, but still focusable".
      disabled={disabled || loading}
      focusableWhenDisabled={focusableWhenDisabled ?? loading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      <span
        data-slot="label"
        className={cn(
          'inline-flex items-center gap-[inherit] transition-opacity duration-(--duration-fast) ease-standard',
          loading && 'opacity-0',
        )}
      >
        {children}
        {isLink && !external && (
          // The arrow sits 3px tighter to the edge (the mocks' arrow pad): an optical nudge.
          <span aria-hidden="true" className="-mr-[3px]">
            →
          </span>
        )}
        {isLink && external && (
          <>
            <FontAwesomeIcon icon={faArrowUpRightFromSquare} className="h-[0.9em]" />
            <span className="sr-only">(opens in a new tab)</span>
          </>
        )}
      </span>
      {loading && (
        <span
          data-slot="spinner"
          aria-hidden="true"
          // Its own ink: a busy button is disabled for input, not inactive, so it doesn't dim.
          className="absolute inset-0 grid place-items-center text-fg2 in-data-armed:text-bad"
        >
          <FontAwesomeIcon icon={faSpinnerThird} className="h-[1.2em] motion-safe:animate-spin" />
        </span>
      )}
    </ButtonPrimitive>
  );
}

export { Button, type ButtonProps, buttonVariants };
