import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faTriangleExclamation } from '@fortawesome/sharp-light-svg-icons';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { Badge } from '@/components/kit/badge';
import { cn } from '@/lib/utils';

import type { HazardRowModel } from './lakeModel';

/**
 * One known hazard (board 1.2): the red mark, what it is, where and when it was reported and who
 * confirmed it, and — once the report has aged — how sure it still is and what the hazard may have
 * become. **Age is confidence, never safety (D3):** an old marker keeps its red and its caveat;
 * only the wording of how recently anyone looked changes. The row is the link to the hazard's card.
 */
export function HazardRow({
  row,
  href,
  onOpen,
}: {
  row: HazardRowModel;
  href: string;
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <a
      href={href}
      onClick={onOpen}
      data-slot="hazard-row"
      data-attr="lake-hazard"
      data-older={row.older ? '' : undefined}
      className={cn(
        'flex min-w-0 items-start gap-(--space-3) rounded-control p-(--space-3) no-underline outline-none',
        'border border-solid border-line border-l-(length:--stroke-note) border-l-bad',
        'transition-colors duration-(--duration-fast) ease-standard lit:bg-lift-03',
        'focus-visible:shadow-focus',
      )}
    >
      <span
        aria-hidden="true"
        className="flex size-[1.375rem] shrink-0 items-center justify-center rounded-container bg-bad text-bg"
      >
        <FontAwesomeIcon icon={faTriangleExclamation} className="h-[0.75rem]" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span className="flex flex-wrap items-center gap-(--space-1_5)">
          <span className="text-row font-medium text-fg">{row.title}</span>
          {row.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
          {row.caveat !== null && (
            <Badge variant="outline" tone="dim">
              {row.confidence}
            </Badge>
          )}
        </span>
        <span className="text-assist text-fg2 [text-wrap:pretty]">{row.line}</span>
        {row.caveat !== null && (
          <span className="text-assist text-fg2 [text-wrap:pretty]">{row.caveat}</span>
        )}
      </span>
      <FontAwesomeIcon
        icon={faChevronRight}
        aria-hidden="true"
        className="h-[0.7rem] shrink-0 self-center text-fg3"
      />
    </a>
  );
}
