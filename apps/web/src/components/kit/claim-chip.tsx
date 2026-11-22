import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * **The claim chip** — the boards' `.pill.lo` (2.1's claims, its drawer's rows): a
 * report's own words in a hairline box, **as the skater wrote them** — sentence case, not the badge's
 * caps — at the badge's height. Gray at rest; `bad` (red) marks the one claim a safety flag is about,
 * never a grade of the claim. A chip is a container, so it is square on both surfaces.
 *
 * Not the kit `Badge`: a badge is a state set in caps; a claim is the skater's own phrase, and caps
 * would turn "3.5″ measured" into a label of ours.
 */
type ClaimChipProps = Omit<ComponentProps<'span'>, 'children'> & {
  /** The claim, as the report states it. */
  children: string;
  tone?: 'default' | 'bad';
};

function ClaimChip({ tone = 'default', className, ...props }: ClaimChipProps) {
  return (
    <span
      data-slot="claim-chip"
      data-tone={tone}
      className={cn(
        'inline-flex h-badge w-fit shrink-0 items-center rounded-container border border-solid px-[0.55em] whitespace-nowrap',
        // The boards' 11 px sans at medium weight: the type scale has 11 px only as mono's step
        // (`--type-mono-sm`), borrowed here for its size — reported as a missing chip step.
        'font-(family-name:--family-sans) text-[length:var(--type-mono-sm)] leading-none font-medium tracking-value',
        tone === 'bad' ? 'border-bad text-bad' : 'border-line2 text-fg2',
        className,
      )}
      {...props}
    />
  );
}

export { ClaimChip, type ClaimChipProps };
