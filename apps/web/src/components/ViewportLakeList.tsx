import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/sharp-solid-svg-icons';
import { api } from '@skating/convex/api';
import { formatAreaAcres, waterBodyClassLabel } from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useMemo } from 'react';
import { orderViewportLakes, type ViewportLake } from '../lib/viewportLakes';
import { PanelDescription, PanelHeader, PanelTitle } from './DetailPanel';
import { useMapSelection } from './MapSelectionContext';
import { Skeleton } from './ui/skeleton';

/**
 * What the sidebar shows when no lake is open — the water currently in view, as a list.
 *
 * The sidebar is permanent now, so it needs something to say in its resting state, and this is the
 * one thing it can say that the map isn't already saying better. A map answers *where*; it answers
 * *what's here* only if you can read shapes at a glance, which is exactly what a regional zoom over
 * 25,000 bodies defeats. The list is the map's legend: the same bodies, named and ordered.
 *
 * **It costs no reads.** The rows are the ones the map's own `listInViewport` subscription already
 * delivered, handed up through `MapSelectionContext` — see `lib/viewportLakes`. The favorites query
 * below is the same zero-argument subscription `MapView` runs, which the Convex client dedupes to
 * one.
 */
export function ViewportLakeList() {
  const { viewportLakes } = useMapSelection();
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});

  const favoriteKey = favorites?.map((f) => f.waterBodyId).join(',') ?? '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: favoriteKey is the stable content signature.
  const favoriteIds = useMemo(
    () => new Set((favorites ?? []).map((f) => f.waterBodyId)),
    [favoriteKey],
  );

  return <ViewportLakeListView lakes={viewportLakes} favoriteIds={favoriteIds} />;
}

/** The list itself, Convex-free so its states are testable without a deployment. */
export function ViewportLakeListView({
  lakes,
  favoriteIds,
}: {
  /** `null` = the map hasn't answered yet; `[]` = it has, and there's nothing here. */
  lakes: ViewportLake[] | null;
  favoriteIds: ReadonlySet<string>;
}) {
  const { rows, hiddenCount, unnamedCount } = useMemo(
    () => orderViewportLakes(lakes ?? [], favoriteIds),
    [lakes, favoriteIds],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PanelHeader className="pr-4">
        <PanelTitle>Lakes in view</PanelTitle>
        <PanelDescription>
          {lakes === null
            ? 'Pan the map to see what’s here.'
            : 'Pick one to read and post reports.'}
        </PanelDescription>
      </PanelHeader>

      {lakes === null ? (
        // "Haven't looked yet" — the map hasn't loaded, or it's panned off the region entirely,
        // where the query is skipped on purpose rather than run for a known-empty answer. Skeletons
        // rather than an empty state, because an empty state here would read as "no lakes in Vermont".
        <div className="flex flex-col gap-2 px-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : rows.length === 0 ? (
        // Two different empty states, because they need two different answers. With unnamed water in
        // view the list is empty but the *map* isn't, and saying "no water in view" would contradict
        // the shapes on screen — the water is there, it just has no name to list it under. With
        // nothing at all in view it's a zoom problem: below its prominence rung a small pond isn't
        // drawn *or* returned (D49/N1), so "nothing here" on a regional view usually means "not yet".
        <p className="px-4 text-muted-foreground text-sm">
          {unnamedCount > 0
            ? 'No named water in view. The unnamed ponds on the map are still there to tap.'
            : 'No water in view. Pan, or zoom in — smaller ponds only appear as you get closer.'}
        </p>
      ) : (
        <ul className="flex flex-col px-2">
          {rows.map((row) => (
            <li key={row._id}>
              <Link
                to="/water/$id"
                params={{ id: row._id }}
                className="flex items-baseline justify-between gap-3 rounded-md px-2 py-2 hover:bg-surface-muted"
              >
                <span className="flex min-w-0 items-baseline gap-1.5">
                  {row.isFavorite ? (
                    <FontAwesomeIcon
                      icon={faStar}
                      aria-label="Favorite"
                      className="size-3 shrink-0 self-center text-primary"
                    />
                  ) : null}
                  <span
                    className={
                      row.publicAccess?.verdict === 'none'
                        ? 'truncate text-muted-foreground text-sm'
                        : 'truncate text-foreground text-sm'
                    }
                  >
                    {row.name}
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">{rowMeta(row)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {hiddenCount > 0 ? (
        // Never a silent truncation: the list stops at a cap, and the cap says so.
        <p className="px-4 pt-2 text-muted-foreground text-xs">
          + {hiddenCount} more in view — zoom in, or search by name.
        </p>
      ) : null}

      {/* The caption that used to sit under the map, which had nowhere else to go once the map went
          full-bleed. The map's own attribution control carries the basemap credit; this is the one
          line explaining what tapping does. */}
      <p className="mt-auto px-4 pt-4 text-foreground-muted text-xs">
        Tap a lake to read and post reports. Basemap and water data © OpenStreetMap contributors.
      </p>
    </div>
  );
}

/** The right-hand meta on a row: "Lake · 1,182 acres · VT", skipping whatever we don't know. */
function rowMeta(row: {
  type: string;
  surfaceAreaSqM?: number;
  states?: string[];
  publicAccess?: { verdict: string };
}): string {
  const parts = [waterBodyClassLabel(row.type)];
  if (row.surfaceAreaSqM !== undefined) parts.push(formatAreaAcres(row.surfaceAreaSqM));
  if (row.states?.length) parts.push(row.states.join(', '));
  // Leads rather than trails (N6f): it is the one fact here that decides whether the rest matters.
  if (row.publicAccess?.verdict === 'none') return `No public access · ${parts.join(' · ')}`;
  return parts.join(' · ');
}
