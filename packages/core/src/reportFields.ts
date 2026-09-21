/**
 * The A10 report fields that grew a shape (D193–D195): located chips, the snow object, and the
 * accessors every reader goes through.
 *
 * ## Located chips
 *
 * `iceTypes` and `surfaceTags` were `string[]`; they are now `{ type, where?, note? }[]`, so
 * "black ice, north end" is one chip and not a chip plus a sentence. Every reader that only wants
 * the keys — the feed filters, D50 corroboration, the `black_ice` recommendation, the contradiction
 * settle, the card chips — goes through `iceTypeKeys` / `surfaceTagKeys` rather than mapping the
 * array itself, so the shape can move again without a twelve-file sweep, and so a reader that
 * *should* care about `where` (an aggregate saying "black ice" when the author said "black ice in
 * patches at the north end" — A10 §12.2) is findable by grepping for the accessor it bypasses.
 *
 * The accessors accept the **pre-widening** string form too. The mobile app on a phone that has not
 * updated still sends `string[]`, the offline queue may hold a draft written before the update, and
 * the validator normalizes both — but a reader over a row mid-backfill must not throw either.
 */

import type { IceType, SnowCoverage, SnowDrift, SnowImpediment, SurfaceTag } from './types';
import type { Where } from './where';

export interface LocatedChip<T extends string> {
  type: T;
  where?: Where;
  /** A few words the chip could not say — "only near the inlet" — author-editable, per chip. */
  note?: string;
}

export type LocatedIceType = LocatedChip<IceType>;
export type LocatedSurfaceTag = LocatedChip<SurfaceTag>;

/** A chip as a client may send it: the bare key (older clients, the quick-tap path) or the object. */
export type ChipInput<T extends string> = T | LocatedChip<T>;

/** The keys of a chip list, whichever shape it arrived in. Order preserved, duplicates kept. */
export function chipKeys<T extends string>(chips: readonly ChipInput<T>[] | undefined): T[] {
  if (!chips) return [];
  return chips.map((chip) => (typeof chip === 'string' ? chip : chip.type));
}

export function iceTypeKeys(chips: readonly ChipInput<IceType>[] | undefined): IceType[] {
  return chipKeys(chips);
}

export function surfaceTagKeys(chips: readonly ChipInput<SurfaceTag>[] | undefined): SurfaceTag[] {
  return chipKeys(chips);
}

/** Lift a bare key to the located shape; an object passes through untouched. */
export function toLocatedChip<T extends string>(chip: ChipInput<T>): LocatedChip<T> {
  return typeof chip === 'string' ? { type: chip } : chip;
}

/**
 * Snow as three facets and a depth (D194). Every field optional: a skater who says "lanes of black
 * ice through it" has said `coverage: 'lanes'` and nothing else, and that is a complete answer.
 *
 * `depthCm` replaces the old top-level `snowCoverCm` (backfilled here during the widen → narrow
 * sequence). Metric stored, imperial in (D25). A "dusting" chip writes `SNOW_DUSTING_CM`.
 */
export interface Snow {
  coverage?: SnowCoverage;
  impediment?: SnowImpediment;
  drifts?: SnowDrift;
  depthCm?: number;
  /** Someone has plowed a lane — a path exists whatever the coverage says. */
  plowedPath?: boolean;
}

/** The depth a "dusting" chip stores — under a centimeter, and honestly not a measurement. */
export const SNOW_DUSTING_CM = 0.5;

/** Does this snow object carry any information? `{}` is dropped by the validator, like an empty thickness section. */
export function snowIsEmpty(snow: Snow): boolean {
  return (
    snow.coverage === undefined &&
    snow.impediment === undefined &&
    snow.drifts === undefined &&
    snow.depthCm === undefined &&
    snow.plowedPath === undefined
  );
}
