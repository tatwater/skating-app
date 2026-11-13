import { Autocomplete } from '@base-ui/react/autocomplete';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faSpinnerThird } from '@fortawesome/sharp-regular-svg-icons';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

import { Kbd } from './kbd';

/**
 * What a grouped search list shares, whichever surface draws it — the skater's search plate and
 * the console's command palette. Only the parts that are the same on both: the rows are each
 * list's own.
 *
 * - **`FootKey`** — a foot's key hint: one dim cap per key, then what it does. The words are the
 *   caller's, in the caller's case.
 * - **`SearchGroupLabel`** — a group's kicker inside Base UI's Autocomplete. Two looks: `plate`
 *   (the search plate's 30 px row) and `palette` (the palette's padded kicker); either can end in
 *   a count (` · 12`, when the group shows only some) and a hairline run to the edge.
 * - **`SearchStatus`** — the list's live status in place of rows: the spinner while a search with
 *   nothing to show yet is in flight, else whatever the caller says about an empty result. The
 *   caller sizes it; it centers what it holds.
 */

// ── Foot key ─────────────────────────────────────────────────────────────────────────────────

type FootKeyProps = {
  /** The keys, one cap each (`['↑', '↓']`), or one cap for a pair (`['↑↓']`). */
  keys: readonly string[];
  /** What the key does. */
  children: ReactNode;
};

function FootKey({ keys, children }: FootKeyProps) {
  return (
    <span
      data-slot="foot-key"
      className="inline-flex items-center gap-(--space-1_5) whitespace-nowrap"
    >
      {keys.map((k) => (
        <Kbd key={k} variant="dim" aria-hidden="true">
          {k}
        </Kbd>
      ))}
      {children}
    </span>
  );
}

// ── Group label ──────────────────────────────────────────────────────────────────────────────

const GROUP_LABEL_LOOK = {
  /** A popup plate's group: a 30 px row, the kicker at medium weight. */
  plate: {
    row: 'flex h-[1.875rem] items-center px-(--space-4)',
    kicker: 'font-medium',
  },
  /** The palette's group: padded to the rows under it, the kicker at semibold. */
  palette: {
    row: 'flex items-center gap-(--space-2_5) px-gutter pt-(--space-3) pb-(--space-1_5)',
    kicker: 'font-semibold',
  },
} as const;

type SearchGroupLabelProps = Omit<Autocomplete.GroupLabel.Props, 'children'> & {
  /** The kicker. Written capitalized; set in caps. */
  children: ReactNode;
  look?: keyof typeof GROUP_LABEL_LOOK;
  /** How many there are in all, when the group shows only some. */
  count?: number;
  /** A hairline from the kicker to the row's end. */
  rule?: boolean;
};

function SearchGroupLabel({
  look = 'plate',
  count,
  rule = false,
  className,
  children,
  ...props
}: SearchGroupLabelProps) {
  const { row, kicker } = GROUP_LABEL_LOOK[look];
  return (
    <Autocomplete.GroupLabel
      data-slot="search-group-label"
      className={cn(row, className)}
      {...props}
    >
      <span className={cn('text-kick leading-none tracking-kick text-fg3 uppercase', kicker)}>
        {children}
        {count !== undefined && ` · ${count}`}
      </span>
      {rule && <span aria-hidden="true" className="h-px flex-1 bg-line" />}
    </Autocomplete.GroupLabel>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────────────────────

type SearchStatusProps = ComponentProps<'div'> & {
  /** A search is in flight with nothing to show yet: the spinner, named for a reader. */
  loading?: boolean;
};

function SearchStatus({ loading = false, className, children, ...props }: SearchStatusProps) {
  return (
    <div
      role="status"
      data-slot="search-status"
      className={cn('grid place-items-center text-fg3', className)}
      {...props}
    >
      {loading ? (
        <>
          <FontAwesomeIcon icon={faSpinnerThird} className="h-[1.2em] motion-safe:animate-spin" />
          <span className="sr-only">Searching</span>
        </>
      ) : (
        children
      )}
    </div>
  );
}

export {
  FootKey,
  type FootKeyProps,
  SearchGroupLabel,
  type SearchGroupLabelProps,
  SearchStatus,
  type SearchStatusProps,
};
