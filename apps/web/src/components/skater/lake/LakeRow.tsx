import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import type { BBox, LngLat } from '@skating/core';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { cn } from '@/lib/utils';
import { LakeSilhouette } from './LakeSilhouette';
import type { InViewTrailing } from './lakeModel';

export interface LakeRowModel {
  id: string;
  name: string;
  /** "Pond · 9 acres · 16 ft max". */
  sub: string;
  href: string;
  favorite: boolean;
  inactive: boolean;
  trailing: InViewTrailing;
  silhouette: { rings: LngLat[][]; bbox: BBox } | null;
}

/**
 * One lake in the In view list (board 1.1): its outline, its name (a gold star when it's a
 * favorite), what it is, and its recent reports on the right. The whole row is the link; a
 * clickable row keeps the control radius (Review 4). An inactive body is gray (Review 2).
 */
export function LakeRow({
  row,
  onOpen,
  onHover,
}: {
  row: LakeRowModel;
  /** A plain left click; the row is a real link, so a modified one opens a tab. */
  onOpen: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onHover?: (id: string | null) => void;
}) {
  return (
    <a
      href={row.href}
      onClick={onOpen}
      onMouseEnter={() => onHover?.(row.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(row.id)}
      onBlur={() => onHover?.(null)}
      data-slot="lake-row"
      data-attr="in-view-lake"
      data-inactive={row.inactive ? '' : undefined}
      className={cn(
        'flex min-w-0 items-center gap-(--space-3_5) rounded-control py-(--space-3_5) no-underline outline-none',
        'border-0 border-b border-dotted border-line2 last:border-b-0',
        'transition-colors duration-(--duration-fast) ease-standard lit:bg-lift-03',
        'focus-visible:shadow-focus',
      )}
    >
      {row.silhouette ? (
        <LakeSilhouette
          rings={row.silhouette.rings}
          bbox={row.silhouette.bbox}
          inactive={row.inactive}
        />
      ) : (
        <span aria-hidden="true" className="h-8 w-11 shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
        <span
          className={cn(
            'flex min-w-0 items-center gap-(--space-2) text-row font-medium',
            row.inactive ? 'text-fg2' : 'text-fg',
          )}
        >
          <span className="truncate">{row.name}</span>
          {row.favorite && (
            <FontAwesomeIcon
              icon={faStar}
              aria-label="A favorite"
              data-slot="lake-row-star"
              className="h-[0.7rem] shrink-0 text-star"
            />
          )}
        </span>
        <span className="truncate text-assist text-fg2">{row.sub}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-(--space-1) text-right">
        {row.trailing.kind === 'reports' ? (
          <>
            <span className="text-assist font-medium text-fg1">{row.trailing.count}</span>
            <span className="text-assist text-fg3">{row.trailing.when}</span>
          </>
        ) : (
          <span className="text-assist text-fg3">{row.trailing.text}</span>
        )}
      </span>
    </a>
  );
}
