import type { LandmarkKind } from '@skating/core';
import type { ComponentProps, ReactNode } from 'react';

import { KEY_GLYPH, MARK_BOX } from '@/components/kit/map-marks';
import { cn } from '@/lib/utils';

/**
 * **Kit candidate** — the marks for the named places on a body (a landmark of each kind) and a
 * weather sample point, in the kit's map-mark frame: a square face on a 2 px halo of the map's
 * ground, centered on its point in the kit's `MARK_BOX`, the corner brackets when it is the one
 * being pointed at, and the face alone at key size (`glyph`) so the map key draws the mark itself.
 *
 * The faces are the boards' `v4` plates (map.js `SYM.plates`), grown to the kit's 14 px face so a
 * landmark sits beside a put-in at one weight. **One word per kind** (Review 13 #3): a settlement is
 * a *Town*, a waterway a *River*, an establishment a *Camp* — {@link PLACE_KEY_LABELS}. Color is
 * rationed as the kit's marks ration it: gray for land and things on it, the dim ice for a river
 * (water you can name), amber for a beach as the boards draw it.
 *
 * To promote: fold `PlaceMark` into `kit/map-marks` beside `PutInMark`, and widen
 * `kit/map-key`'s kinds with {@link PLACE_KEY_LABELS}' entries.
 */

export type PlaceMarkKind = LandmarkKind | 'sample';

/** The face's half side at rest, in the plates' units (11 px squares). */
const PLATE = 5.5;
/** The kit's mark face, half side: a put-in's 7. */
const FACE = 7;
const BRACKETS = 'M-16 -9 v-7 h7 M9 -16 h7 v7 M16 9 v7 h-7 M-9 16 h-7 v-7';

/** Each kind's face, drawn in the plates' 11 px box centered on 0. */
const FACES: Record<PlaceMarkKind, () => ReactNode> = {
  island: () => (
    <>
      <Square className="fill-line2" />
      <circle
        r={2.6}
        fill="none"
        strokeWidth={1}
        strokeDasharray="1.2 1.2"
        className="stroke-fg1"
      />
    </>
  ),
  beach: () => (
    <>
      <Square className="fill-warn" />
      <path d="M-3 2 h6 M-2 -1 h4" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  bridge: () => (
    <>
      <Square className="fill-fg1" />
      <path d="M-3.5 -1.5 h7 M-3.5 1.5 h7" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  dam: () => (
    <>
      <Square className="fill-fg1" />
      <rect x={-3.5} y={-1.5} width={7} height={3} className="fill-bg" />
    </>
  ),
  waterway: () => (
    <>
      <Square className="fill-acc-dim" />
      <path
        d="M-3.5 0 q1.75 -2.5 3.5 0 t3.5 0"
        fill="none"
        strokeWidth={1.3}
        className="stroke-bg"
      />
    </>
  ),
  settlement: () => (
    <>
      <Square className="fill-fg3" />
      <rect x={-2} y={-2} width={4} height={4} className="fill-bg" />
    </>
  ),
  establishment: () => (
    <>
      <Square className="fill-fg3" />
      <path d="M0 -3 l3 5 h-6 z" className="fill-bg" />
    </>
  ),
  point: () => (
    <>
      <Square className="fill-fg2" />
      <path d="M-3 2 l3 -4.5 l3 4.5" fill="none" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  bay: () => (
    <>
      <Square className="fill-acc-dim" />
      <path d="M-3.5 -2 q3.5 6 7 0" fill="none" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  narrows: () => (
    <>
      <Square className="fill-fg2" />
      <path
        d="M-2.5 -3.5 q2 3.5 0 7 M2.5 -3.5 q-2 3.5 0 7"
        fill="none"
        strokeWidth={1.2}
        className="stroke-bg"
      />
    </>
  ),
  marina: () => (
    <>
      <Square className="fill-fg2" />
      <path d="M0 -3.5 v6 M-3 0.5 q3 4 6 0" fill="none" strokeWidth={1.2} className="stroke-bg" />
    </>
  ),
  lighthouse: () => (
    <>
      <Square className="fill-fg2" />
      <path d="M-1.5 3.5 l0.7 -6 h1.6 l0.7 6 z" className="fill-bg" />
    </>
  ),
  other: () => (
    <>
      <Square className="fill-fg3" />
      <circle r={1.8} className="fill-bg" />
    </>
  ),
  sample: () => (
    <>
      <rect
        x={-3.5}
        y={-3.5}
        width={7}
        height={7}
        fill="none"
        strokeWidth={1.2}
        className="stroke-fg2"
      />
      <circle r={1.2} className="fill-fg2" />
    </>
  ),
};

/** The map key's word for each kind — one word, a noun for what the mark *is*. */
const PLACE_KEY_LABELS: Record<PlaceMarkKind, string> = {
  island: 'Island',
  point: 'Point',
  beach: 'Beach',
  bay: 'Bay',
  narrows: 'Narrows',
  waterway: 'River',
  bridge: 'Bridge',
  marina: 'Marina',
  lighthouse: 'Lighthouse',
  dam: 'Dam',
  settlement: 'Town',
  establishment: 'Camp',
  other: 'Place',
  sample: 'Sample point',
};

function Square({ className }: { className: string }) {
  return <rect x={-PLATE} y={-PLATE} width={2 * PLATE} height={2 * PLATE} className={className} />;
}

type PlaceMarkProps = Omit<ComponentProps<'svg'>, 'children' | 'viewBox'> & {
  kind: PlaceMarkKind;
  /** Recede behind a chosen mark (a hover elsewhere): never below half. */
  dim?: boolean;
  /** The mark being pointed at, or the lit one: corner brackets around it. */
  highlight?: boolean;
  /** The face alone at key size: no halo, no state. */
  glyph?: boolean;
};

function PlaceMark({
  kind,
  dim = false,
  highlight = false,
  glyph = false,
  className,
  ...props
}: PlaceMarkProps) {
  const face = <g transform={`scale(${FACE / PLATE})`}>{FACES[kind]()}</g>;
  if (glyph) {
    return (
      <svg
        aria-hidden="true"
        data-slot="place-mark"
        data-kind={kind}
        width={KEY_GLYPH}
        height={KEY_GLYPH}
        viewBox={`${-FACE} ${-FACE} ${2 * FACE} ${2 * FACE}`}
        className={cn('block shrink-0', className)}
        {...props}
      >
        {face}
      </svg>
    );
  }
  const half = MARK_BOX / 2;
  return (
    <svg
      aria-hidden="true"
      data-slot="place-mark"
      data-kind={kind}
      data-dim={dim ? '' : undefined}
      data-highlight={highlight ? '' : undefined}
      width={MARK_BOX}
      height={MARK_BOX}
      viewBox={`${-half} ${-half} ${MARK_BOX} ${MARK_BOX}`}
      className={cn(
        'block overflow-visible transition-opacity duration-(--duration-fast) ease-standard',
        dim && 'opacity-38',
        className,
      )}
      {...props}
    >
      {kind !== 'sample' && (
        <rect
          x={-FACE - 2}
          y={-FACE - 2}
          width={2 * FACE + 4}
          height={2 * FACE + 4}
          className="fill-(--map-ground)"
        />
      )}
      {face}
      {highlight && (
        <path
          data-slot="place-mark-brackets"
          d={BRACKETS}
          fill="none"
          strokeWidth={1.2}
          className="stroke-fg"
        />
      )}
    </svg>
  );
}

export { PLACE_KEY_LABELS, PlaceMark, type PlaceMarkProps };
