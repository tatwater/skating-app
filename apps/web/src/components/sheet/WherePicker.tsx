import {
  COMPASS_SECTORS,
  describeWhere,
  landmarkPoint,
  landmarksForSheet,
  MAX_LANDMARK_NAME_LENGTH,
  pointFromTap,
  type Sector,
  searchLandmarks,
  WHERE_EXTENTS,
  type Where,
  type WhereExtent,
} from '@skating/core';
import { useState } from 'react';
import { Input } from '../ui/input';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint } from './SheetPanel';
import type { SheetBody } from './useSheetBody';

/** The whole lake is spelled by absence (D193); the row offers the qualifiers, most to least. */
const EXTENTS = WHERE_EXTENTS.filter((e): e is Exclude<WhereExtent, 'whole'> => e !== 'whole');
const EXTENT_LABELS: Record<Exclude<WhereExtent, 'whole'>, string> = {
  mostly: 'Mostly',
  large_areas: 'Large areas',
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
 * which end, a named landmark (D202), or a point clicked on the silhouette — named for the landmark
 * it lands near, or by the skater, which proposes the name. Composes — "patches, north end of Malletts
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
  /** The search over the landmarks past the chips — open once asked for. */
  const [finding, setFinding] = useState<string | null>(null);
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
  // The body's landmarks (D202): the most prominent as chips, scoped to the chosen bay; the rest
  // behind a search. A landmark is a point with its name — choosing one is choosing that point.
  const landmarks = body?.landmarks ?? [];
  const { chips: landmarkChips, more } = landmarksForSheet(landmarks, {
    ...(where?.subAreaId !== undefined ? { subAreaId: where.subAreaId } : {}),
  });
  const found = finding ? searchLandmarks(landmarks, finding) : [];
  const chosenLandmark = where?.point?.landmarkId;
  const pickLandmark = (l: (typeof landmarks)[number]) =>
    set({ point: chosenLandmark === l._id ? undefined : landmarkPoint(l, POINT_RADIUS_M) });
  // A tapped point no landmark answers to may be named — and the name goes to the moderators as a
  // proposal when the report posts (`name_landmark`).
  const unnamedTap = where?.point !== undefined && where.point.landmarkId === undefined;

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
        {[
          ...landmarkChips,
          ...found.filter((f) => !landmarkChips.some((c) => c._id === f._id)),
        ].map((l) => (
          <SheetChip
            key={l._id}
            compact
            label={l.name}
            {...(chosenLandmark === l._id ? { tier: 'solid' as const } : {})}
            onClick={() => pickLandmark(l)}
          />
        ))}
        {more > 0 && finding === null ? (
          <SheetChip compact label={`${more} more places…`} onClick={() => setFinding('')} />
        ) : null}
        <SheetChip
          compact
          label={
            where?.point && !chosenLandmark
              ? 'Point placed'
              : isPlacing
                ? 'Click the water…'
                : 'A point on the lake'
          }
          {...((where?.point && !chosenLandmark) || isPlacing ? { tier: 'solid' as const } : {})}
          onClick={() => {
            if (where?.point && !chosenLandmark) set({ point: undefined });
            else setPlacing(!isPlacing);
          }}
        />
      </div>
      {finding !== null ? (
        <Input
          autoFocus
          aria-label="Find a place on the lake"
          placeholder="Find a place — an island, a point, a beach"
          value={finding}
          onChange={(e) => setFinding(e.target.value)}
        />
      ) : null}
      {unnamedTap ? (
        <div className="flex flex-col gap-1">
          <Input
            aria-label="Name this spot"
            placeholder="Name this spot (optional) — e.g. Bird Poop Rock"
            maxLength={MAX_LANDMARK_NAME_LENGTH}
            value={where?.point?.name ?? ''}
            onChange={(e) => {
              const point = where?.point;
              if (!point) return;
              const name = e.target.value;
              set({
                point: {
                  coord: point.coord,
                  radiusMeters: point.radiusMeters,
                  ...(name ? { name } : {}),
                },
              });
            }}
          />
          {where?.point?.name?.trim() ? (
            <SheetHint>
              We’ll suggest “{where.point.name.trim()}” to the moderators as a place on this lake.
            </SheetHint>
          ) : null}
        </div>
      ) : null}
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
                    // Near a known landmark, the tap takes its name (D202).
                    set({ point: pointFromTap(coord, landmarks, POINT_RADIUS_M) });
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
