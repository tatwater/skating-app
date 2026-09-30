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
import { Text, XStack, YStack } from 'tamagui';
import { Input } from '../ThemedInputs';
import { LakeMap } from './LakeMap';
import { SheetChip } from './SheetChip';
import { SheetHint } from './SheetSection';
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

/** A coarse tap's radius (D193 / A05b): "about here", not a survey. */
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
 * The *where* affordance (A10 / D193) under a selected chip: how much of the lake, which bay, which
 * end, a named landmark (D202), or a point tapped on the silhouette — named for the landmark it
 * lands near, or by the skater, which proposes the name. Composes — "patches, north end of Malletts Bay" is an
 * extent, a bay and a sector at once. The chips choose; the lake shows.
 *
 * Nothing here is required: a chip with no `where` is the whole lake, spelled by absence (D193).
 */
export function WherePicker({
  where,
  body,
  onChange,
  instrument = false,
  placing: placingProp = false,
  onPlacing,
}: {
  where: Where | undefined;
  body: SheetBody | null;
  onChange: (where: Where | undefined) => void;
  /** The where cards: the lake with its ring is drawn beside these chips, not under them. */
  instrument?: boolean;
  placing?: boolean;
  onPlacing?: (placing: boolean) => void;
}) {
  const [localPlacing, setLocalPlacing] = useState(false);
  /** The search over the landmarks past the chips — open once asked for. */
  const [finding, setFinding] = useState<string | null>(null);
  const placing = instrument ? placingProp : localPlacing;
  const setPlacing = (next: boolean | ((p: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(placing) : next;
    if (instrument) onPlacing?.(value);
    else setLocalPlacing(value);
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
  const shownLandmarks = [
    ...landmarkChips,
    ...found.filter((f) => !landmarkChips.some((c) => c._id === f._id)),
  ];
  const chosenLandmark = where?.point?.landmarkId;
  // A tapped point no landmark answers to may be named — and the name goes to the moderators as a
  // proposal when the report posts (`name_landmark`).
  const unnamedTap = where?.point !== undefined && where.point.landmarkId === undefined;

  return (
    <YStack gap="$2" accessibilityLabel="Where on the lake">
      <XStack gap="$2" flexWrap="wrap">
        {EXTENTS.map((extent) => (
          <SheetChip
            key={extent}
            compact
            label={EXTENT_LABELS[extent]}
            tier={where?.extent === extent ? 'solid' : undefined}
            onPress={() => set({ extent: where?.extent === extent ? undefined : extent })}
          />
        ))}
      </XStack>
      {body && body.bays.length > 0 ? (
        <XStack gap="$2" flexWrap="wrap">
          {body.bays.map((bay) => (
            <SheetChip
              key={bay.id}
              compact
              label={bay.name}
              tier={where?.subAreaId === bay.id ? 'solid' : undefined}
              onPress={() =>
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
        </XStack>
      ) : null}
      {shownLandmarks.length > 0 || more > 0 ? (
        <XStack gap="$2" flexWrap="wrap">
          {shownLandmarks.map((l) => (
            <SheetChip
              key={l._id}
              compact
              label={l.name}
              tier={chosenLandmark === l._id ? 'solid' : undefined}
              onPress={() =>
                set({
                  point: chosenLandmark === l._id ? undefined : landmarkPoint(l, POINT_RADIUS_M),
                })
              }
            />
          ))}
          {more > 0 && finding === null ? (
            <SheetChip compact label={`${more} more places…`} onPress={() => setFinding('')} />
          ) : null}
        </XStack>
      ) : null}
      {finding !== null ? (
        <Input
          autoFocus
          accessibilityLabel="Find a place on the lake"
          placeholder="Find a place — an island, a point, a beach"
          value={finding}
          onChangeText={setFinding}
        />
      ) : null}
      <XStack gap="$2" flexWrap="wrap">
        {sectors.map((sector) => (
          <SheetChip
            key={sector}
            compact
            label={`${where?.sector === sector ? '◆ ' : ''}${SECTOR_LABELS[sector]}`}
            tier={where?.sector === sector ? 'solid' : undefined}
            onPress={() => set({ sector: where?.sector === sector ? undefined : sector })}
          />
        ))}
        <SheetChip
          compact
          label={
            where?.point && !chosenLandmark
              ? 'Point placed'
              : placing
                ? 'Tap the water…'
                : 'A point on the lake'
          }
          tier={(where?.point && !chosenLandmark) || placing ? 'solid' : undefined}
          onPress={() => {
            if (where?.point && !chosenLandmark) set({ point: undefined });
            else setPlacing((p) => !p);
          }}
        />
      </XStack>
      {where?.point?.landmarkId !== undefined ? (
        <XStack gap="$2" flexWrap="wrap">
          {/* A tap near a landmark takes its name; the skater may mean some other spot by it. */}
          <SheetChip
            compact
            label={`Not ${where.point.name ?? 'that place'} — name this spot`}
            onPress={() => {
              const point = where?.point;
              if (point) set({ point: { coord: point.coord, radiusMeters: point.radiusMeters } });
            }}
          />
        </XStack>
      ) : null}
      {unnamedTap ? (
        <YStack gap="$1">
          <Input
            accessibilityLabel="Name this spot"
            placeholder="Name this spot (optional) — e.g. Bird Poop Rock"
            maxLength={MAX_LANDMARK_NAME_LENGTH}
            value={where?.point?.name ?? ''}
            onChangeText={(name) => {
              const point = where?.point;
              if (!point) return;
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
        </YStack>
      ) : null}
      {!instrument && body?.silhouette && (placing || where?.sector || where?.point) ? (
        <YStack gap="$1.5">
          <LakeMap
            data={body.silhouette}
            sector={where?.sector}
            point={
              where?.point
                ? { ...where.point.coord, radiusMeters: where.point.radiusMeters }
                : undefined
            }
            height={150}
            onTap={
              placing
                ? (coord) => {
                    // Near a known landmark, the tap takes its name (D202).
                    set({ point: pointFromTap(coord, landmarks, POINT_RADIUS_M) });
                    setPlacing(false);
                  }
                : undefined
            }
          />
          {placing ? <SheetHint>Tap the water where you mean.</SheetHint> : null}
        </YStack>
      ) : null}
      {words ? (
        <Text color="$foreground" fontSize={12}>
          {words[0]?.toUpperCase()}
          {words.slice(1)}
        </Text>
      ) : null}
    </YStack>
  );
}
