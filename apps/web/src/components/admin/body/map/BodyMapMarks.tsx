import type { ReactNode } from 'react';

import { MAP_KEY_ORDER, MapKey, type MapKeyKind } from '@/components/kit/map-key';
import {
  HazardMark,
  LotMark,
  type MarkState,
  PhotoMark,
  PLACE_KEY_LABELS,
  PlaceMark,
  type PlaceMarkKind,
  PutInMark,
} from '@/components/kit/map-marks';

import type { MapPointMark } from './mapDescriptors';

/**
 * Every point face the console map can draw, from the kit's marks (`kit/map-marks`: the put-in,
 * lot, hazard and photo faces, and the place plates for every landmark kind, a sample point and a
 * proposal), and the kit's key (`kit/map-key`) for the bar along the foot. One table, so the map
 * and its key can never draw a kind two ways.
 */

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

/** The key's kind for a face: a known feature is listed as a hazard (one word, drawn once). */
function keyKind(mark: MapPointMark): MapKeyKind {
  return mark === 'feature' ? 'hazard' : mark;
}

/** The kinds a key lists, in the kit key's order, each word once. */
export function keyEntries(kinds: readonly MapPointMark[]): { mark: MapKeyKind; label: string }[] {
  const wanted = new Set(kinds.map(keyKind));
  return MAP_KEY_ORDER.filter((k) => wanted.has(k)).map((mark) => ({
    mark,
    label: (POINT_KEY_LABELS as Record<string, string>)[mark] ?? mark,
  }));
}

/** The map's key: the kit's bar on the console's foot ground, listing every kind the map draws. */
export function BodyMapKey({
  kinds,
  className,
}: {
  kinds: readonly MapPointMark[];
  className?: string;
}) {
  return <MapKey kinds={[...new Set(kinds.map(keyKind))]} className={className ?? 'bg-map-foot'} />;
}
