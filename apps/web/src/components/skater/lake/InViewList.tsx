import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { isActiveRow, type PartialStandingInput, silhouetteRings } from '@skating/core';
import { useRouter } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { type MouseEvent as ReactMouseEvent, useMemo } from 'react';

import { Skeleton, SkeletonText } from '@/components/kit/skeleton';
import { orderViewportLakes, type ViewportLake } from '@/lib/viewportLakes';
import { useSkaterMapStore } from '@/stores/skaterMapStore';

import { isPlainLeftClick } from '../chrome';
import { LakeRow, type LakeRowModel } from './LakeRow';
import { LakeSidebar, SidebarBody } from './LakeSidebar';
import { inViewSubLine, inViewTrailing, lakesCountLine } from './lakeModel';
import { markWaterBodyOpenSource } from './openSource';

/**
 * Nothing chosen (board 1.1): the lakes in the map's view, in the sidebar. The rows are the ones
 * the map is already drawing (`viewportLakes` in the map store) — no second viewport read — and
 * `null` means the map hasn't answered yet, which is the loading frame.
 */
export interface InViewModel {
  /** `null` while the map is still reading. */
  rows: LakeRowModel[] | null;
  /** Named bodies past the list's cap — said, never silently dropped. */
  hiddenCount: number;
}

export function InViewListView({
  model,
  onOpen,
  onHover,
}: {
  model: InViewModel;
  onOpen: (row: LakeRowModel, event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onHover?: (id: string | null) => void;
}) {
  const { rows, hiddenCount } = model;
  const loading = rows === null;
  return (
    <LakeSidebar
      label="Lakes in view"
      busy={loading}
      header={
        <div
          data-slot="in-view-head"
          className="flex flex-col gap-(--space-1_5) border-0 border-b border-solid border-line px-gutter pt-(--space-5_5) pb-(--space-4_5)"
        >
          <span className="text-kick font-medium tracking-kick text-fg3 uppercase">In view</span>
          {loading ? (
            <Skeleton className="mt-(--space-1) h-[1.625rem] w-32" />
          ) : (
            <h1 className="m-0 mt-(--space-1) text-disp-lg leading-none font-semibold tracking-disp text-fg uppercase">
              {lakesCountLine(rows.length + hiddenCount)}
            </h1>
          )}
          <p className="m-0 text-assist text-fg2">
            Pick one to read its reports, or explore to see more.
          </p>
        </div>
      }
      body={
        <SidebarBody className="pt-(--space-2_5)">
          {loading ? (
            <div aria-hidden="true" className="flex flex-col">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="flex items-center gap-(--space-3_5) border-0 border-b border-dotted border-line2 py-(--space-3_5) last:border-b-0"
                >
                  <Skeleton className="h-8 w-11" />
                  <SkeletonText className="flex-1 text-row" lines={2} />
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="m-0 text-row text-fg2 [text-wrap:pretty]">
              No listed lakes in view. Zoom out or pan to find one, or click unlisted water on the
              map to ask for it.
            </p>
          ) : (
            <nav aria-label="Lakes in view" className="ph-no-capture flex flex-col">
              {rows.map((row) => (
                <LakeRow
                  key={row.id}
                  row={row}
                  onOpen={(event) => onOpen(row, event)}
                  {...(onHover ? { onHover } : {})}
                />
              ))}
              {hiddenCount > 0 && (
                <p className="m-0 pt-(--space-3) text-assist text-fg3">
                  {hiddenCount.toLocaleString('en-US')} more in view — zoom in to list them.
                </p>
              )}
            </nav>
          )}
        </SidebarBody>
      }
    />
  );
}

/** A viewport row as the map hands it up: the stored body, so its outline and depth ride along. */
type InViewBody = ViewportLake &
  PartialStandingInput & {
    maxDepthM?: number;
    polygon?: Parameters<typeof silhouetteRings>[0];
  };

/** Outlines are simplified once per body, not on every render of the list. */
const outlineCache = new WeakMap<object, LakeRowModel['silhouette']>();

function outlineOf(body: InViewBody): LakeRowModel['silhouette'] {
  const polygon = body.polygon;
  if (!polygon || (polygon.type !== 'Polygon' && polygon.type !== 'MultiPolygon')) return null;
  const hit = outlineCache.get(polygon);
  if (hit !== undefined) return hit;
  const outline = silhouetteRings(polygon);
  const value = outline.rings.length > 0 ? outline : null;
  outlineCache.set(polygon, value);
  return value;
}

/** The rows, in the list's order, from the map's bodies, the favorites and the recent cards. */
export function buildInViewModel(
  bodies: readonly InViewBody[] | null,
  favoriteIds: ReadonlySet<string>,
  cards: readonly { waterBodyId: string; skateEndTime: number }[],
  now: number,
): InViewModel {
  if (bodies === null) return { rows: null, hiddenCount: 0 };
  const ordered = orderViewportLakes(bodies, favoriteIds);
  const byId = new Map(bodies.map((b) => [b._id, b]));
  const rows = ordered.rows.map((row): LakeRowModel => {
    const body = byId.get(row._id) as InViewBody;
    const inactive = !isActiveRow(body);
    return {
      id: row._id,
      name: row.name,
      sub: inViewSubLine(body),
      href: `/water/${row._id}`,
      favorite: row.isFavorite,
      inactive,
      trailing: inViewTrailing(
        cards.filter((c) => c.waterBodyId === row._id).map((c) => c.skateEndTime),
        { now, inactive },
      ),
      silhouette: outlineOf(body),
    };
  });
  return { rows, hiddenCount: ordered.hiddenCount };
}

/** The In view list, connected: the map store's rows, the favorites, the recent cards. */
export function InViewList() {
  const router = useRouter();
  const bodies = useSkaterMapStore((s) => s.viewportLakes) as readonly InViewBody[] | null;
  const setHovered = useSkaterMapStore((s) => s.setHoveredBodyId);
  // The same subscription the map holds for its stars, so the client shares it.
  const favorites = useQuery(api.waterBodyFavorites.listForUser, {});
  const favoriteKey = (favorites ?? []).map((f) => f.waterBodyId).join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on content, not identity.
  const favoriteIds = useMemo(
    () => new Set<string>((favorites ?? []).map((f) => f.waterBodyId)),
    [favoriteKey],
  );
  const ids = useMemo(
    () => (bodies === null ? [] : orderViewportLakes(bodies, favoriteIds).rows.map((r) => r._id)),
    [bodies, favoriteIds],
  );
  const cards = useQuery(
    api.reports.recentCardsForBodies,
    ids.length > 0 ? { waterBodyIds: ids as Id<'waterBodies'>[] } : 'skip',
  );
  const model = useMemo(
    () => buildInViewModel(bodies, favoriteIds, cards ?? [], Date.now()),
    [bodies, favoriteIds, cards],
  );
  return (
    <InViewListView
      model={model}
      onHover={setHovered}
      onOpen={(row, event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        markWaterBodyOpenSource('list', row.href);
        setHovered(null);
        router.history.push(row.href);
      }}
    />
  );
}
