import { type ComponentProps, type ReactNode, useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's section title: the boards' inverted slug — a kicker set in caps on a filled chip, a
 * hairline whisker running to the row's end, and what ends the rule.
 *
 * - **Kicker caps on the chip.** The chip is the field's ink inverted (`fg1` fill, `bg` ink), square
 *   (a container), at the kicker step. Its insets are in `em`, so they track the chip's own type
 *   (D233); the left inset is a hair wider than the right because the caps' tracking already trails
 *   the last letter.
 * - **What ends the rule.** A section that lists things ends its rule in its **count** — `0` when
 *   empty, never the bare square. A section with something at the rule's end (a legend, a link)
 *   ends there too. Only a bare rule (a comparison, a choice) keeps the square terminal.
 * - **A heading sits exactly 12 px over its content** (the standing rule, `gap-heading`), measured
 *   from the chip — the slug's visible edge — to the content's. `Section` keeps that true whatever
 *   the content is (D234): text should trim to its letterforms (`text-trim`), and an interactive
 *   child bleeds its own padding (a bare kit `Button` already does). The row never grows past the
 *   chip, so a taller thing at the rule's end can't push the content down.
 */

type SectionSlugProps = Omit<ComponentProps<'div'>, 'title' | 'children'> & {
  /** The section's name, written capitalized ("Asked of this body"); the chip sets it in caps. */
  title: ReactNode;
  /**
   * How many things the section lists. Ends the rule in place of the square — `0` included, so an
   * empty list still says it is one.
   */
  count?: number;
  /** Something at the rule's end — a legend, a link (`Enrichment →`). Ends the rule in place of the square. */
  end?: ReactNode;
  /** The heading level the chip carries. Default `h2`. */
  level?: 2 | 3 | 4;
  /** The heading's id, for a region it labels. */
  headingId?: string;
};

function SectionSlug({
  title,
  count,
  end,
  level = 2,
  headingId,
  className,
  ...props
}: SectionSlugProps) {
  const Heading = `h${level}` as const;
  const terminal = count === undefined && end == null;
  return (
    <div
      data-slot="section-slug"
      className={cn('flex min-w-0 items-center whitespace-nowrap', className)}
      {...props}
    >
      <Heading
        id={headingId}
        data-slot="section-chip"
        className={cn(
          'min-w-0 truncate rounded-container bg-fg1 text-bg',
          'text-kick leading-none font-semibold tracking-kick uppercase',
          'pt-[0.4em] pr-[0.8em] pb-[0.3em] pl-[0.9em]',
        )}
      >
        {title}
      </Heading>
      <span
        aria-hidden="true"
        data-slot="section-rule"
        data-terminal={terminal ? '' : undefined}
        className={cn(
          'relative h-(--stroke-hair) min-w-[1.5rem] flex-1 bg-line2',
          // The square terminal: a 4 px stop centered on the hairline's end.
          'data-terminal:after:absolute data-terminal:after:top-1/2 data-terminal:after:right-0',
          'data-terminal:after:size-(--stroke-now) data-terminal:after:-translate-y-1/2',
          'data-terminal:after:bg-fg2 data-terminal:after:content-[""]',
        )}
      />
      {(count !== undefined || end != null) && (
        // Zero height, centered on the row: whatever ends the rule never makes the row taller
        // than the chip, so the heading gap below is always measured from the chip.
        <span
          data-slot="section-end"
          className="ms-(--space-2_5) flex h-0 shrink-0 items-center gap-(--space-3)"
        >
          {count !== undefined && (
            <span
              data-slot="section-count"
              className="font-(family-name:--family-mono) text-kick leading-none font-medium tracking-micro text-fg2 tabular-nums"
            >
              {count.toLocaleString('en-US')}
            </span>
          )}
          {end}
        </span>
      )}
    </div>
  );
}

type SectionProps = Omit<ComponentProps<'section'>, 'title'> &
  Pick<SectionSlugProps, 'title' | 'count' | 'end' | 'level'>;

/**
 * A titled section: the slug, then its content exactly the heading gap below the chip. The region
 * is named by its heading.
 */
function Section({ title, count, end, level, className, children, ...props }: SectionProps) {
  const id = useId();
  return (
    <section
      data-slot="section"
      aria-labelledby={id}
      className={cn('flex min-w-0 flex-col gap-heading', className)}
      {...props}
    >
      <SectionSlug title={title} count={count} end={end} level={level} headingId={id} />
      {children}
    </section>
  );
}

export { Section, type SectionProps, SectionSlug, type SectionSlugProps };
