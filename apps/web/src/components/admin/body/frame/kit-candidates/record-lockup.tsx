import { type ComponentProps, type ReactNode, type RefObject, useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate** — a record's lockup at the head of its panel: what kind of thing it is (the
 * kicker) over its name (the display word), and the **scroll-fold** (Review 12 #8): once the panel
 * scrolls, the lockup folds to the name and its kind on one line over a rule that stays, so a
 * scrolled panel keeps its subject's name. The figures under it are the panel's to scroll away.
 *
 * - Unfolded: kicker, then the name, 8 px apart — no rule (the content's own rule follows).
 * - Folded: the name a step smaller, then the kind on its baseline, then the rule.
 * - `useScrollFold` decides from the scroller: it folds past a few pixels and unfolds only back at
 *   the top, so a panel whose folded head frees just enough room can't flap between the two.
 * - The heading is the name (`h1` by default): a reader hears the record, then its kind.
 *
 * Board: 5.4.1 Body | Shape and 5.4.1 Shape | Scrolled; People's person lockup is the same idea.
 */

type RecordLockupProps = Omit<ComponentProps<'div'>, 'children'> & {
  /** What kind of record ("Reservoir"), written capitalized; set in caps. */
  kind: ReactNode;
  /** The record's name; set as the display word. */
  name: ReactNode;
  folded?: boolean;
  level?: 1 | 2;
};

function RecordLockup({
  kind,
  name,
  folded = false,
  level = 1,
  className,
  ...props
}: RecordLockupProps) {
  const Heading = `h${level}` as const;
  return (
    <div
      data-slot="record-lockup"
      data-folded={folded ? '' : undefined}
      className={cn(
        'flex min-w-0',
        folded
          ? 'flex-row items-baseline gap-(--space-3) border-0 border-b border-solid border-line pb-(--space-3)'
          : 'flex-col-reverse gap-(--space-2)',
        className,
      )}
      {...props}
    >
      <Heading
        data-slot="record-lockup-name"
        className={cn(
          'm-0 min-w-0 truncate leading-none font-semibold tracking-disp text-fg uppercase',
          folded ? 'text-h' : 'text-disp',
        )}
      >
        {name}
      </Heading>
      <span
        data-slot="record-lockup-kind"
        className="shrink-0 text-kick leading-none font-medium tracking-kick whitespace-nowrap text-fg3 uppercase"
      >
        {kind}
      </span>
    </div>
  );
}

/** Folds past this many px of scroll; unfolds only back within the first. */
const FOLD_AT = 24;
const UNFOLD_AT = 2;

/** Whether a scroller has scrolled far enough to fold its lockup. Pure, for the hysteresis' test. */
function nextFolded(folded: boolean, scrollTop: number): boolean {
  if (!folded && scrollTop > FOLD_AT) return true;
  if (folded && scrollTop <= UNFOLD_AT) return false;
  return folded;
}

/** Folds the lockup while `scroller` is scrolled. `initial` is a story's still. */
function useScrollFold(scroller: RefObject<HTMLElement | null>, initial = false): boolean {
  const [folded, setFolded] = useState(initial);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onScroll = () => setFolded((f) => nextFolded(f, el.scrollTop));
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scroller]);
  return folded;
}

export { nextFolded, RecordLockup, type RecordLockupProps, useScrollFold };
