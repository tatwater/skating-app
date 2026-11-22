import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';

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
 * **Quote** — the boards' `.q`: someone's own words, quoted (an ask, the report a drawing came from,
 * 2.3 and 2.5). A hairline rule down the left in the faint ink (lighter than a note's), the words in
 * italics a gap inside it. Who said it is a byline under it (`PersonByline`), never inside.
 *
 * **LockBanner** — the boards' `.lockban`: **it was decided while you looked**. A hairline box in
 * the lit hairline on the panel ground; the line takes the whole row ("Decided by Sarah · 14:42 ·
 * approved, the bay drawn") and the way on sits under it (*History →*, *Back to the queue*). It is
 * announced politely, once — by `RetryNote`'s rule: a live region mounted already holding its words
 * is often not announced, so the region is in the page first and the words are put into it. The
 * banner draws at once (its visible line kept from readers), and a frame later the line's words go
 * into a reader-only slot inside the region — the change a screen reader announces. Its copy stays
 * the operator's: who and when, never blame and never "you". (The lock is decided-only: no one claims an item, so there is no "has this
 * open" banner and no *Take over*.)
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
  /** Its one state, said for a caller that names it; nothing else is accepted. */
  state?: 'decided';
  /** The line: who, and when ("Sarah has this open · 2 min"). */
  children: ReactNode;
  /** The banner's buttons (kit `Button`s, `size="xs"`). */
  actions?: ReactNode;
};

function LockBanner({
  state = 'decided',
  actions,
  children,
  className,
  ...props
}: LockBannerProps) {
  // The words reach the region a frame after it is in the page (the change a reader announces).
  const [said, setSaid] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSaid(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="lock-banner"
      data-state={state}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-(--space-3) gap-y-(--space-2_5)',
        'rounded-container border-(length:--stroke-hair) border-solid border-fg2 bg-panel',
        'px-(--space-3_5) py-(--space-2_5) text-row leading-list text-fg1',
        '[&_strong]:font-medium [&_strong]:text-fg',
        className,
      )}
      {...props}
    >
      {/* Drawn at once; read through the slot below, so a reader hears it once, as an arrival. */}
      <span
        aria-hidden="true"
        data-slot="lock-banner-line"
        className="text-trim min-w-0 basis-full"
      >
        {children}
      </span>
      <span data-slot="lock-banner-said" className="sr-only">
        {said ? children : null}
      </span>
      {actions != null && (
        <span
          data-slot="lock-banner-actions"
          className="flex shrink-0 items-center gap-(--space-2_5)"
        >
          {actions}
        </span>
      )}
    </div>
  );
}

type QuoteProps = ComponentProps<'blockquote'>;

function Quote({ className, ...props }: QuoteProps) {
  return (
    <blockquote
      data-slot="quote"
      className={cn(
        'm-0 min-w-0 border-s-(length:--stroke-hair) border-solid border-fg3 ps-(--space-3) py-(--space-0_5)',
        'text-row leading-body text-fg2 italic',
        className,
      )}
      {...props}
    />
  );
}

export {
  LockBanner,
  type LockBannerProps,
  Note,
  type NoteProps,
  type NoteTone,
  Quote,
  type QuoteProps,
};
