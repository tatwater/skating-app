import type { LandmarkKind } from '@skating/core';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The kit's map marks, on both surfaces: 14–16 px squares, each with a 2 px halo in the map's
 * ground color (`--map-ground`), so it lifts off the basemap and the depth fill alike. Drawn on a
 * box centered on the point, so a parent places the point, not a corner. Every map that draws a
 * point draws one of these, and the map key (`map-key`) draws the same faces small (`glyph`), so a
 * key entry is the mark itself. Pure SVG: no map library, no data.
 */

/** A hazard's face: a warning, one healing over, or a crossing somebody reported. */
type HazardTone = 'danger' | 'healing' | 'passage';

/** The box every mark draws in, centered on its point: room for the selection brackets. */
const MARK_BOX = 34;
const H = MARK_BOX / 2;

/** A key glyph's size, px — the admin key's 12 px. */
const KEY_GLYPH = 12;

const BRACKETS = 'M-16 -9 v-7 h7 M9 -16 h7 v7 M16 9 v7 h-7 M-9 16 h-7 v-7';

type MarkSvgProps = Omit<ComponentProps<'svg'>, 'children' | 'viewBox'>;

interface MarkState {
  /** Recede behind a mark that is chosen — never below half, so it still reads as one (D3). */
  dim?: boolean;
  /**
   * Step back while another mark is hovered (Review 13): `opacity-fade`. A hazard's face never
   * goes below half for it (D3) — it fades as far as `dim` and no further.
   */
  fade?: boolean;
  /** The mark being pointed at: corner brackets around it. */
  highlight?: boolean;
  /** The key's glyph: the face alone at key size — no halo, no state. */
  glyph?: boolean;
}

/** The frame every mark shares: the box, the ground halo, the dim and the brackets. */
function Mark({
  slot,
  kind,
  face,
  dim = false,
  fade = false,
  floor = false,
  halo = true,
  highlight = false,
  glyph = false,
  className,
  children,
  ...props
}: MarkSvgProps &
  MarkState & {
    slot: string;
    kind: string;
    /** Half the colored square's side. */
    face: number;
    /** Never below half, even for a hover's fade (a hazard, D3). */
    floor?: boolean;
    /** The ground halo under the face; a mark drawn as an outline goes without. */
    halo?: boolean;
    children: ReactNode;
  }) {
  if (glyph) {
    return (
      <svg
        aria-hidden="true"
        data-slot={slot}
        data-kind={kind}
        width={KEY_GLYPH}
        height={KEY_GLYPH}
        viewBox={`${-face} ${-face} ${2 * face} ${2 * face}`}
        className={cn('block shrink-0', className)}
        {...props}
      >
        {children}
      </svg>
    );
  }
  return (
    <svg
      aria-hidden="true"
      data-slot={slot}
      data-kind={kind}
      data-dim={dim ? '' : undefined}
      data-fade={fade ? '' : undefined}
      data-highlight={highlight ? '' : undefined}
      width={MARK_BOX}
      height={MARK_BOX}
      viewBox={`${-H} ${-H} ${MARK_BOX} ${MARK_BOX}`}
      className={cn(
        'block overflow-visible transition-opacity duration-(--duration-fast) ease-standard',
        (dim || (fade && floor)) && 'opacity-55',
        fade && !floor && !dim && 'opacity-(--opacity-fade)',
        className,
      )}
      {...props}
    >
      {halo && (
        <rect
          x={-face - 2}
          y={-face - 2}
          width={2 * face + 4}
          height={2 * face + 4}
          className="fill-(--map-ground)"
        />
      )}
      {children}
      {highlight && (
        <path
          data-slot={`${slot}-brackets`}
          d={BRACKETS}
          fill="none"
          strokeWidth={1.2}
          className="stroke-fg"
        />
      )}
    </svg>
  );
}

type SizedMarkProps = MarkSvgProps & MarkState & { big?: boolean };

/** A put-in: an ice square with a dot — 14 px, 16 px when it is the one being talked about. */
function PutInMark({ big = false, ...props }: SizedMarkProps) {
  const r = big ? 8 : 7;
  return (
    <Mark slot="put-in-mark" kind="put-in" face={r} {...props}>
      <rect x={-r} y={-r} width={2 * r} height={2 * r} className="fill-acc" />
      <circle r={r * 0.36} className="fill-bg" />
    </Mark>
  );
}

/**
 * A parking lot: a gray square with a P cut in the ground — the admin key's lot. Gray, not ice: the
 * map's color is rationed to the water you get on at, the hazards, and selection (Review 2).
 */
function LotMark({ big = false, ...props }: SizedMarkProps) {
  const r = big ? 8 : 7;
  return (
    <Mark slot="lot-mark" kind="lot" face={r} {...props}>
      <rect x={-r} y={-r} width={2 * r} height={2 * r} className="fill-fg2" />
      <path
        d="M-2.9 -4 H0.6 A2.3 2.3 0 0 1 0.6 0.6 H-1.3 V4 H-2.9 Z M-1.3 -2.5 H0.6 A0.8 0.8 0 0 1 0.6 -0.9 H-1.3 Z"
        fillRule="evenodd"
        transform={big ? `scale(${r / 7})` : undefined}
        className="fill-bg"
      />
    </Mark>
  );
}

/** A photo placed on the water: a light square with a lens ring — the mock's photo square. */
function PhotoMark({ big = false, ...props }: SizedMarkProps) {
  const r = big ? 7 : 6;
  return (
    <Mark slot="photo-mark" kind="photo" face={r} {...props}>
      <rect x={-r} y={-r} width={2 * r} height={2 * r} className="fill-fg1" />
      <circle r={r * 0.42} fill="none" strokeWidth={1.4} className="stroke-bg" />
    </Mark>
  );
}

const TONE_FILL: Record<HazardTone, string> = {
  danger: 'fill-bad',
  healing: 'fill-warn',
  passage: 'fill-acc',
};

/**
 * A hazard: a 16 px square with a triangle (a suggested crossing gets two bars instead — it is a
 * route somebody reported, not a warning). `selected` — the hazard an inset card is open on — adds
 * the brackets, as `highlight` does; `dim` recedes it behind a hazard that is chosen.
 */
function HazardMark({
  tone = 'danger',
  selected = false,
  highlight = false,
  ...props
}: MarkSvgProps & MarkState & { tone?: HazardTone; selected?: boolean }) {
  return (
    <Mark
      slot="hazard-mark"
      kind="hazard"
      face={8}
      floor
      data-tone={tone}
      highlight={selected || highlight}
      {...props}
    >
      <rect x={-8} y={-8} width={16} height={16} className={TONE_FILL[tone]} />
      {tone === 'passage' ? (
        <path d="M-4.5 -2.5 H4.5 V-1 H-4.5 Z M-4.5 1 H4.5 V2.5 H-4.5 Z" className="fill-bg" />
      ) : (
        <path d="M0 -4.5 L4.5 3.5 H-4.5 Z" className="fill-bg" />
      )}
    </Mark>
  );
}

// ── Places ───────────────────────────────────────────────────────────────────────────────────

/**
 * A named place on a body (a landmark of each kind), a weather sample point, or a skater's
 * proposal, in the same frame as the marks above: the boards' `v4` plates (map.js `SYM.plates`),
 * grown to a put-in's 14 px face so a landmark sits beside a put-in at one weight. Color is
 * rationed as the other marks ration it: gray for land and things on it, the dim ice for water you
 * can name (a river, a bay, a narrows), amber for a beach as the boards draw it. Nothing here is
 * red: a landmark is never a hazard.
 *
 * - **One word per kind** (Review 13 #3): a settlement is a *Town*, a waterway a *River*, an
 *   establishment a *Camp* — {@link PLACE_KEY_LABELS}, which the map key reads.
 * - **A proposal is drawn as proposed**: a dashed frame and a question mark where a landmark has a
 *   filled plate, since a skater's proposal has no kind until a moderator gives it one.
 * - **A sample point** is an outline with a dot, and goes without the halo.
 */
type PlaceMarkKind = LandmarkKind | 'sample' | 'proposal';

/** The plates' half side (11 px squares), scaled up to the kit's face. */
const PLATE = 5.5;
/** A put-in's face, half side. */
const PLACE_FACE = 7;

function Plate({ className }: { className: string }) {
  return <rect x={-PLATE} y={-PLATE} width={2 * PLATE} height={2 * PLATE} className={className} />;
}

/** Each kind's face, drawn in the plates' 11 px box centered on 0. */
const PLACE_FACES: Record<PlaceMarkKind, () => ReactNode> = {
  island: () => (
    <>
      <Plate className="fill-line2" />
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
      <Plate className="fill-warn" />
      <path d="M-3 2 h6 M-2 -1 h4" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  bridge: () => (
    <>
      <Plate className="fill-fg1" />
      <path d="M-3.5 -1.5 h7 M-3.5 1.5 h7" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  dam: () => (
    <>
      <Plate className="fill-fg1" />
      <rect x={-3.5} y={-1.5} width={7} height={3} className="fill-bg" />
    </>
  ),
  waterway: () => (
    <>
      <Plate className="fill-acc-dim" />
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
      <Plate className="fill-fg3" />
      <rect x={-2} y={-2} width={4} height={4} className="fill-bg" />
    </>
  ),
  establishment: () => (
    <>
      <Plate className="fill-fg3" />
      <path d="M0 -3 l3 5 h-6 z" className="fill-bg" />
    </>
  ),
  point: () => (
    <>
      <Plate className="fill-fg2" />
      <path d="M-3 2 l3 -4.5 l3 4.5" fill="none" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  bay: () => (
    <>
      <Plate className="fill-acc-dim" />
      <path d="M-3.5 -2 q3.5 6 7 0" fill="none" strokeWidth={1.3} className="stroke-bg" />
    </>
  ),
  narrows: () => (
    <>
      <Plate className="fill-acc-dim" />
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
      <Plate className="fill-fg2" />
      <path d="M0 -3.5 v6 M-3 0.5 q3 4 6 0" fill="none" strokeWidth={1.2} className="stroke-bg" />
    </>
  ),
  lighthouse: () => (
    <>
      <Plate className="fill-fg2" />
      <path d="M-1.5 3.5 l0.7 -6 h1.6 l0.7 6 z" className="fill-bg" />
    </>
  ),
  other: () => (
    <>
      <Plate className="fill-fg3" />
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
  proposal: () => (
    <>
      <rect
        x={-5}
        y={-5}
        width={10}
        height={10}
        strokeDasharray="1.6 1.2"
        className="fill-map-plate stroke-fg"
      />
      {/* The question mark, drawn — a glyph would bring its text into the key's words. */}
      <path
        data-slot="proposal-query"
        d="M-1.6 -1.3 q0 -1.9 1.6 -1.9 t1.6 1.7 q0 1.1 -1.6 1.5 v0.9"
        fill="none"
        strokeWidth={1.2}
        className="stroke-fg"
      />
      <circle cy={2.6} r={0.65} className="fill-fg" />
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
  proposal: 'Proposal',
};

type PlaceMarkProps = MarkSvgProps & MarkState & { kind: PlaceMarkKind };

function PlaceMark({ kind, ...props }: PlaceMarkProps) {
  return (
    <Mark slot="place-mark" kind={kind} face={PLACE_FACE} halo={kind !== 'sample'} {...props}>
      <g transform={`scale(${PLACE_FACE / PLATE})`}>{PLACE_FACES[kind]()}</g>
    </Mark>
  );
}

export {
  HazardMark,
  type HazardTone,
  KEY_GLYPH,
  LotMark,
  MARK_BOX,
  type MarkState,
  PhotoMark,
  PLACE_KEY_LABELS,
  PlaceMark,
  type PlaceMarkKind,
  type PlaceMarkProps,
  PutInMark,
};
