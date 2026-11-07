import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's notes and the lock banner.
 *
 * **Note** — the boards' `.note`: a 2 px rule down the left (`stroke-note`), **no fill, no box**,
 * the text a gap inside it. Three tones, by meaning only:
 * - `default` — gray: something worth knowing.
 * - `warn` — amber: it **waits on a person** (a gap someone has to fill, a call someone has to make).
 * - `bad` — red: it won't recover without a person. **Never red at rest**: nothing turns a note red
 *   but its meaning, so a note is gray unless the caller says otherwise.
 *
 * The text is trimmed to its letterforms, so the rule runs exactly `space-1_5` past the caps above
 * and the baseline below, and the gap inside the rule (`space-3`) is rule to ink. Emphasis
 * (`<strong>`) is the lit ink at medium weight.
 *
 * **LockBanner** — the boards' `.lockban`, the colleague lock over a record: a hairline box on the
 * panel ground, the line on the left, its actions on the right.
 * - `held` — someone else has it open ("Sarah has this open · 2 min"), with *Take over*.
 * - `decided` — **it was decided while you looked**: the hairline brightens, the line takes the
 *   whole row ("Decided by Sarah · 14:42 · approved, the bay drawn") and the way on sits under it
 *   (*History →*, *Back to the queue*). It is announced politely (`role="status"`), once. The
 *   border's change rides the motion tokens, so under reduced motion it simply switches.
 * Its copy stays the operator's: who and when, never blame and never "you".
 */

type NoteTone = 'default' | 'warn' | 'bad';

const RULE: Record<NoteTone, string> = {
  default: 'border-fg3',
  warn: 'border-warn',
  bad: 'border-bad',
};

type NoteProps = ComponentProps<'div'> & { tone?: NoteTone };

function Note({ tone = 'default', className, ...props }: NoteProps) {
  return (
    <div
      role="note"
      data-slot="note"
      data-tone={tone}
      // `text-trim` stays outside `cn`: tailwind-merge reads it as a text color and would drop it
      // in favor of `text-fg2`.
      className={`text-trim ${cn(
        'min-w-0 border-s-(length:--stroke-note) border-solid ps-(--space-3) py-(--space-1_5)',
        'text-row leading-body text-fg2',
        '[&_strong]:font-medium [&_strong]:text-fg',
        RULE[tone],
        className,
      )}`}
      {...props}
    />
  );
}

type LockBannerProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** `held`: a colleague has it open. `decided`: it was decided while it was open here. */
  state: 'held' | 'decided';
  /** The line: who, and when ("Sarah has this open · 2 min"). */
  children: ReactNode;
  /** The banner's buttons (kit `Button`s, `size="xs"`). */
  actions?: ReactNode;
};

function LockBanner({ state, actions, children, className, ...props }: LockBannerProps) {
  const decided = state === 'decided';
  return (
    <div
      role={decided ? 'status' : undefined}
      data-slot="lock-banner"
      data-state={state}
      className={cn(
        'flex min-w-0 items-center gap-x-(--space-3) gap-y-(--space-2_5)',
        'rounded-container border-(length:--stroke-hair) border-solid border-line2 bg-panel',
        'px-(--space-3_5) py-(--space-2_5) text-row leading-list text-fg1',
        'transition-[border-color] duration-(--duration-base) ease-standard',
        '[&_strong]:font-medium [&_strong]:text-fg',
        decided && 'flex-wrap border-fg2',
        className,
      )}
      {...props}
    >
      <span
        data-slot="lock-banner-line"
        className={`text-trim min-w-0 ${decided ? 'basis-full' : 'flex-1'}`}
      >
        {children}
      </span>
      {actions != null && (
        <span
          data-slot="lock-banner-actions"
          className={cn('flex shrink-0 items-center gap-(--space-2_5)', !decided && 'ms-auto')}
        >
          {actions}
        </span>
      )}
    </div>
  );
}

export { LockBanner, type LockBannerProps, Note, type NoteProps, type NoteTone };
