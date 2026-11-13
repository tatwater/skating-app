import type { ReactNode } from 'react';

import { HazardMark, LotMark, PhotoMark, PutInMark } from '@/components/kit/map-marks';
import { cn } from '@/lib/utils';

import { PLACE_KEY_LABELS, PlaceMark, type PlaceMarkKind } from './kit-candidates/place-marks';
import type { MapPointMark } from './mapDescriptors';

/**
 * Every point face the console map can draw, at mark size and at key size — the kit's put-in, lot,
 * hazard and photo marks, and the place marks (a kit candidate) for everything else. One table, so
 * the map and its key can never draw a kind two ways.
 */

type MarkState = { dim?: boolean; highlight?: boolean; glyph?: boolean };

const KIT: Partial<Record<MapPointMark, (s: MarkState) => ReactNode>> = {
  putIn: (s) => <PutInMark {...s} />,
  lot: (s) => <LotMark {...s} />,
  hazard: (s) => <HazardMark {...s} />,
  healing: (s) => <HazardMark tone="healing" {...s} />,
  passage: (s) => <HazardMark tone="passage" {...s} />,
  // A known feature draws like any hazard (Review 14 #8).
  feature: (s) => <HazardMark {...s} />,
  photo: (s) => <PhotoMark {...s} />,
};

export function PointFace({ mark, ...state }: MarkState & { mark: MapPointMark }) {
  const kit = KIT[mark];
  if (kit) return <>{kit(state)}</>;
  return <PlaceMark kind={mark as PlaceMarkKind} {...state} />;
}

/** The key's word for each face. A noun for what the mark is — never a word about the ice. */
export const POINT_KEY_LABELS: Record<MapPointMark, string> = {
  ...PLACE_KEY_LABELS,
  putIn: 'Put-in',
  lot: 'Lot',
  hazard: 'Hazard',
  healing: 'Healing hazard',
  passage: 'Ridge crossing',
  feature: 'Hazard',
  photo: 'Photo',
};

/** The key's order, whatever order the scene hands its kinds in: access first, then places. */
const KEY_ORDER: readonly MapPointMark[] = [
  'putIn',
  'lot',
  'island',
  'beach',
  'bridge',
  'dam',
  'waterway',
  'settlement',
  'establishment',
  'point',
  'bay',
  'narrows',
  'marina',
  'lighthouse',
  'other',
  'sample',
  'hazard',
  'feature',
  'healing',
  'passage',
  'photo',
];

/** The kinds a key lists, ordered, with a word drawn once (a feature and a hazard share one). */
export function keyEntries(
  kinds: readonly MapPointMark[],
): { mark: MapPointMark; label: string }[] {
  const seen = new Set<string>();
  const out: { mark: MapPointMark; label: string }[] = [];
  for (const mark of KEY_ORDER) {
    if (!kinds.includes(mark)) continue;
    const label = POINT_KEY_LABELS[mark];
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ mark, label });
  }
  return out;
}

/**
 * The map's key: the kit `MapKey`'s bar (the same slot, classes and foot room), listing every kind
 * the map is drawing, place kinds included. Local until `kit/map-key` takes the place kinds — a
 * seam request; the classes are the kit's, so the swap is a one-line change.
 */
export function BodyMapKey({
  kinds,
  className,
}: {
  kinds: readonly MapPointMark[];
  className?: string;
}) {
  const entries = keyEntries(kinds);
  if (entries.length === 0) return null;
  return (
    <ul
      data-slot="map-key"
      // biome-ignore lint/a11y/noRedundantRoles: `list-none` strips the implied list role in Safari/VoiceOver; saying it back keeps the key a named list there.
      role="list"
      aria-label="Map key"
      className={cn(
        'absolute inset-x-0 bottom-0 z-(--z-map-control) m-0 flex h-7.5 list-none items-center gap-(--space-3) px-(--space-3)',
        'border-0 border-t border-solid border-line bg-map-foot',
        'text-kick leading-none font-medium tracking-rail whitespace-nowrap text-fg2 uppercase',
        'overflow-x-auto [scrollbar-width:none]',
        className,
      )}
    >
      {entries.map(({ mark, label }) => (
        <li
          key={mark}
          data-key={mark}
          className="inline-flex shrink-0 items-center gap-(--space-1_5)"
        >
          <PointFace mark={mark} glyph />
          {label}
        </li>
      ))}
    </ul>
  );
}
