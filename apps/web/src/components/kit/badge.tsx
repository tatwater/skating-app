import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';
import { Children, type ComponentProps, Fragment, isValidElement, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's Badge: shadcn's Base UI badge, re-skinned to the boards' state marks. A badge is a
 * container, so it is **square on both surfaces** — never shadcn's pill.
 *
 * - **`solid`** — a state: mono caps on a filled square (`size-badge` tall). The primary state is
 *   the bright fill; a fading state (Stale) is `dim`; amber, red and ice by meaning only.
 * - **`outline`** — a claim beside a value: sans caps in a hairline box (`size-pill` tall). `lit`
 *   is the current value (Now); the default gray is the suggested one; `dim` is dashed.
 * - **`live`** — a running state: no box; its LED glows and breathes (still under reduced motion).
 *   Its `off` tone is the state that stopped being live (*Not live*): the LED goes hollow — no fill,
 *   a hairline ring in the faint ink, no halo, no breath — and the words step back to that ink.
 *   `off` is the live badge's only: a solid or outlined badge has no hollow state.
 *
 * **One state per badge.** Two states are two badges side by side, never a bullet inside one, so
 * a `Badge` takes text only. Green has no tone: success is the quiet state. Badge copy is written
 * capitalized ("Stale", "Read-only") — the caps are the badge's type, not the copy's.
 */
const badgeVariants = cva(
  [
    'inline-flex w-fit shrink-0 items-center whitespace-nowrap rounded-container',
    'text-kick leading-none uppercase',
  ],
  {
    variants: {
      variant: {
        solid: 'h-badge px-[0.8em] font-(family-name:--family-mono) font-semibold tracking-key',
        outline: [
          'h-pill px-[0.6em] font-(family-name:--family-sans) font-semibold tracking-label',
          'border border-solid',
        ],
        live: [
          'h-badge gap-[0.7em] font-(family-name:--family-sans) font-semibold tracking-label text-fg',
          'before:size-[0.6em] before:shrink-0 before:bg-(--led) before:content-[""] before:led',
        ],
      },
      tone: {
        default: '',
        dim: '',
        lit: '',
        warn: '',
        bad: '',
        acc: '',
        off: '',
      },
    },
    compoundVariants: [
      // Solid: the fill is the meaning; the ink is the field's, so it passes on every fill.
      { variant: 'solid', tone: 'default', className: 'bg-fg1 text-bg' },
      { variant: 'solid', tone: 'lit', className: 'bg-fg text-bg' },
      { variant: 'solid', tone: 'dim', className: 'bg-line2 text-fg1' },
      { variant: 'solid', tone: 'warn', className: 'bg-warn text-bg' },
      { variant: 'solid', tone: 'bad', className: 'bg-bad text-bg' },
      { variant: 'solid', tone: 'acc', className: 'bg-acc text-bg' },
      // Outline: the hairline and the ink share the meaning.
      { variant: 'outline', tone: 'default', className: 'border-line2 text-fg2' },
      { variant: 'outline', tone: 'lit', className: 'border-fg2 text-fg' },
      { variant: 'outline', tone: 'dim', className: 'border-dashed border-line2 text-fg3' },
      { variant: 'outline', tone: 'warn', className: 'border-warn text-warn' },
      { variant: 'outline', tone: 'bad', className: 'border-bad text-bad' },
      { variant: 'outline', tone: 'acc', className: 'border-acc-dim text-acc' },
      // Live: the LED takes the tone; its glow follows.
      {
        variant: 'live',
        tone: ['default', 'lit'],
        className: '[--led:var(--fg)] [--led-glow:var(--glow)]',
      },
      // A dim LED is idle: no halo, no breath.
      {
        variant: 'live',
        tone: 'dim',
        className: '[--led:var(--fg3)] text-fg2 before:animate-none before:shadow-none',
      },
      // Hollow: not live. The ring is a drawing value (a hairline), in the faint ink.
      {
        variant: 'live',
        tone: 'off',
        className: [
          'text-fg3 [--led:transparent]',
          'before:animate-none before:shadow-[inset_0_0_0_var(--stroke-hair)_var(--fg3)]',
        ],
      },
      {
        variant: 'live',
        tone: 'warn',
        className: '[--led:var(--warn)] [--led-glow:var(--warn-glow)]',
      },
      {
        variant: 'live',
        tone: 'bad',
        className: '[--led:var(--bad)] [--led-glow:var(--bad-glow)]',
      },
      {
        variant: 'live',
        tone: 'acc',
        className: '[--led:var(--acc)] [--led-glow:var(--acc-glow)]',
      },
    ],
    defaultVariants: { variant: 'solid', tone: 'default' },
  },
);

type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

type BadgeProps = Omit<useRender.ComponentProps<'span'>, 'children'> & {
  /** One state, as text. */
  children?: string | number;
} & (
    | { variant?: 'solid' | 'outline' | null; tone?: Exclude<BadgeTone, 'off'> | null }
    /** `off` is the live badge's hollow state (*Not live*). */
    | { variant: 'live'; tone?: BadgeTone | null }
  );

function Badge({ className, variant = 'solid', tone = 'default', render, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      { className: cn(badgeVariants({ variant, tone }), className) },
      props as ComponentProps<'span'>,
    ),
    render,
    state: { slot: 'badge', variant, tone },
  });
}

/**
 * A catalog tag (`NHD`, `OSM`, `GNIS`): mono caps in the quiet ink, no box. It vouches for the
 * value it follows.
 */
function Tag({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      data-slot="tag"
      className={cn(
        'inline-flex items-center whitespace-nowrap font-(family-name:--family-mono) text-kick leading-none font-regular tracking-key text-fg3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

/** A run of tags, joined by a tight dot (`NHD · OSM`) — decoration, so a reader hears a list. */
function TagRun({ className, children, ...props }: ComponentProps<'span'>) {
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <span data-slot="tag-run" className={cn('inline-flex items-center', className)} {...props}>
      {items.map((child, i) => (
        // `Children.toArray` keys every child.
        <Fragment key={String(child.key)}>
          {i > 0 && <TagDot />}
          {child}
        </Fragment>
      ))}
    </span>
  );
}

function TagDot(): ReactNode {
  return (
    <span
      aria-hidden="true"
      data-slot="tag-dot"
      className="mx-[0.3em] font-(family-name:--family-mono) text-kick leading-none text-line2"
    >
      ·
    </span>
  );
}

export { Badge, type BadgeProps, type BadgeTone, badgeVariants, Tag, TagRun };
