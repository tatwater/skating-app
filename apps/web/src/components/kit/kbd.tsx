import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's keyboard hint: shadcn's Kbd, re-skinned to the chiclet keycap the boards draw.
 *
 * - **Rounded like a key** (`rounded-key`, 3 px on both surfaces): the one container that rounds.
 * - **Mono caps** at the kicker step, tracked `key`; the cap is the surface's `size-key` tall, so
 *   it is denser on the console and never makes the button it sits in taller.
 * - **Three looks.** `lit` — the light cap the console's buttons and status bar wear; `dim` — the
 *   recessed cap (a status-bar key that isn't the point); `go` — ice, the transient go-mode, with
 *   the key already pressed in the sequence (`spent`) grayed before the one that finishes it.
 * - **Disabled is inert, not hidden** (a layer with nothing to draw keeps its key): no fill, a
 *   hairline, the disabled ink.
 *
 * A control that wears a key should name it with `aria-keyshortcuts`; the cap is then decoration
 * (`aria-hidden`), so the control's name stays its label.
 */
const kbdVariants = cva(
  [
    'inline-flex h-key min-w-key shrink-0 items-center justify-center gap-[0.3em] px-[0.5em]',
    'rounded-key font-(family-name:--family-mono) text-kick leading-none font-medium tracking-key uppercase',
    'whitespace-nowrap select-none',
    'transition-[background-color,color,box-shadow] duration-(--duration-fast) ease-standard',
  ],
  {
    variants: {
      variant: {
        /** The light cap: a button's key, a status-bar key. The default. */
        lit: 'bg-fg2 text-panel',
        /** The recessed cap. */
        dim: 'bg-line2 text-fg1',
        /** Go-mode: ice, glowing. A transient mode is the one place ice marks a control. */
        go: 'bg-acc text-bg shadow-glow-ice',
      },
    },
    defaultVariants: { variant: 'lit' },
  },
);

/** Inert: kept in place, but nothing listens for it. Wins over the variant's fill. */
const DISABLED = 'bg-transparent text-fg-disabled shadow-none inset-ring inset-ring-line';

type KbdProps = ComponentProps<'kbd'> &
  VariantProps<typeof kbdVariants> & {
    /** Nothing listens for this key right now; the cap stays, faded. */
    disabled?: boolean;
    /** `go` only: the key already pressed in the sequence ("G"), grayed before the finishing key. */
    spent?: ReactNode;
  };

function Kbd({
  className,
  variant = 'lit',
  disabled = false,
  spent,
  children,
  ...props
}: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      data-variant={variant}
      data-disabled={disabled ? '' : undefined}
      className={cn(kbdVariants({ variant }), disabled && DISABLED, className)}
      {...props}
    >
      {variant === 'go' && spent != null && (
        <span data-slot="kbd-spent" className="opacity-(--opacity-disabled)">
          {spent}
        </span>
      )}
      {children}
    </kbd>
  );
}

/** Keys pressed together or in turn ("⌘ K", "⇧ ⏎"): separate caps, a hair apart. */
function KbdGroup({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-(--space-0_5)', className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup, type KbdProps, kbdVariants };
