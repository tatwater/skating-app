import type { ReactNode } from 'react';

import { MapKey, type MapKeyKind } from '@/components/kit/map-key';
import {
  HazardMark,
  LotMark,
  type MarkState,
  PhotoMark,
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

/**
 * The key's kind for a face: a known feature is listed as a hazard (one word, drawn once). The words
 * are the kit key's own, so the map and its key never name a kind two ways.
 */
function keyKind(mark: MapPointMark): MapKeyKind {
  return mark === 'feature' ? 'hazard' : mark;
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
