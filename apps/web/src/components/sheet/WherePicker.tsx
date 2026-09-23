import {
  COMPASS_SECTORS,
  describeWhere,
  type Sector,
  WHERE_EXTENTS,
  type Where,
  type WhereExtent,
} from '@skating/core';
import { useState } from 'react';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint } from './SheetPanel';
import type { SheetBody } from './useSheetBody';

/** The whole lake is spelled by absence (D193); the row offers the two qualifiers. */
const EXTENTS = WHERE_EXTENTS.filter((e): e is Exclude<WhereExtent, 'whole'> => e !== 'whole');
const EXTENT_LABELS: Record<Exclude<WhereExtent, 'whole'>, string> = {
  mostly: 'Mostly',
  patches: 'In patches',
};

export const SECTOR_LABELS: Record<Sector, string> = {
  N: 'North end',
  NE: 'Northeast',
  E: 'East side',
  SE: 'Southeast',
  S: 'South end',
  SW: 'Southwest',
  W: 'West side',
  NW: 'Northwest',
  middle: 'Middle',
  near_shore: 'Near shore',
  head: 'Back of the bay',
  mouth: 'Mouth of the bay',
};

/** A coarse click's radius (D193 / A05b): "about here", not a survey. */
export const POINT_RADIUS_M = 75;

/** Compose a patch onto a `where`, dropping the keys it clears; `undefined` when nothing is left. */
export function patchWhere(where: Where | undefined, patch: Partial<Where>): Where | undefined {
  const next: Where = { ...where, ...patch };
  for (const key of Object.keys(next) as (keyof Where)[]) {
    if (next[key] === undefined) delete next[key];
  }
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * The *where* affordance (A10 / D193) under a selected chip: how much of the lake, which bay,
 * which end, or a point clicked on the silhouette. Composes — "patches, north end of Malletts
 * Bay" is an extent, a bay and a sector at once. The chips choose; the lake shows.
 *
 * In the console (`instrument`), the lake that shows is the instrument in the center column, put
 * into where-mode by the question block around this picker (`WhereCards`); no map is drawn here.
 * Nothing here is required: a chip with no `where` is the whole lake, spelled by absence (D193).
 */
export function WherePicker({
  where,
  body,
  onChange,
  instrument = false,
  placing = false,
  onPlacing,
}: {
  /** Absent is the whole lake, spelled by absence (D193) — never a required prop. */
  where?: Where;
  body: SheetBody | null;
  onChange: (where: Where | undefined) => void;
  /** The console: the map is elsewhere. */
  instrument?: boolean;
  /** Controlled *a point* placement, when the instrument takes the click. */
  placing?: boolean;
  onPlacing?: (placing: boolean) => void;
}) {
  const [localPlacing, setLocalPlacing] = useState(false);
  const isPlacing = instrument ? placing : localPlacing;
  const setPlacing = (next: boolean) => {
    if (instrument) onPlacing?.(next);
    else setLocalPlacing(next);
  };
  const set = (patch: Partial<Where>) => onChange(patchWhere(where, patch));
  const bayNames = Object.fromEntries((body?.bays ?? []).map((b) => [b.id, b.name]));
  const inBay = where?.subAreaId !== undefined;
  const sectors: readonly Sector[] = inBay
    ? [...COMPASS_SECTORS, 'middle', 'near_shore', 'head', 'mouth']
    : [...COMPASS_SECTORS, 'middle', 'near_shore'];
  const words = where ? describeWhere(where, bayNames) : '';

  return (
    <fieldset aria-label="Where on the lake" className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {EXTENTS.map((extent) => (
          <SheetChip
            key={extent}
            compact
            label={EXTENT_LABELS[extent]}
            {...(where?.extent === extent ? { tier: 'solid' as const } : {})}
            onClick={() => set({ extent: where?.extent === extent ? undefined : extent })}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {sectors.map((sector) => (
          <SheetChip
            key={sector}
            compact
            label={`${where?.sector === sector ? '◆ ' : ''}${SECTOR_LABELS[sector]}`}
            {...(where?.sector === sector ? { tier: 'solid' as const } : {})}
            onClick={() => set({ sector: where?.sector === sector ? undefined : sector })}
          />
        ))}
        {(body?.bays ?? []).map((bay) => (
          <SheetChip
            key={bay.id}
            compact
            label={bay.name}
            {...(where?.subAreaId === bay.id ? { tier: 'solid' as const } : {})}
            onClick={() =>
              set({
                subAreaId: where?.subAreaId === bay.id ? undefined : bay.id,
                // Head and mouth are the bay's words; they go when the bay does.
                sector:
                  where?.subAreaId === bay.id &&
                  (where.sector === 'head' || where.sector === 'mouth')
                    ? undefined
                    : where?.sector,
              })
            }
          />
        ))}
        <SheetChip
          compact
          label={
            where?.point ? 'Point placed' : isPlacing ? 'Click the water…' : 'A point on the lake'
          }
          {...(where?.point || isPlacing ? { tier: 'solid' as const } : {})}
          onClick={() => {
            if (where?.point) set({ point: undefined });
            else setPlacing(!isPlacing);
          }}
        />
      </div>
      {!instrument && body?.silhouette && (isPlacing || where?.sector || where?.point) ? (
        <div className="flex flex-col gap-1.5">
          <LakeMap
            data={body.silhouette}
            {...(where?.sector !== undefined ? { sector: where.sector } : {})}
            {...(where?.point
              ? {
                  point: {
                    ...where.point.coord,
                    ...(where.point.radiusMeters !== undefined
                      ? { radiusMeters: where.point.radiusMeters }
                      : {}),
                  },
                }
              : {})}
            height={200}
            label="The lake. Click the water where you mean."
            {...(isPlacing
              ? {
                  onPick: (coord: { lat: number; lng: number }) => {
                    set({ point: { coord, radiusMeters: POINT_RADIUS_M } });
                    setPlacing(false);
                  },
                }
              : {})}
          />
          {isPlacing ? <SheetHint>Click the water where you mean.</SheetHint> : null}
        </div>
      ) : null}
      {words ? (
        <p className="text-foreground text-xs">
          {words[0]?.toUpperCase()}
          {words.slice(1)}
        </p>
      ) : null}
    </fieldset>
  );
}
