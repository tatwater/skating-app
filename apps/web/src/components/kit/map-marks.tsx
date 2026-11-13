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
      data-highlight={highlight ? '' : undefined}
      width={MARK_BOX}
      height={MARK_BOX}
      viewBox={`${-H} ${-H} ${MARK_BOX} ${MARK_BOX}`}
      className={cn('block overflow-visible', dim && 'opacity-55', className)}
      {...props}
    >
      <rect
        x={-face - 2}
        y={-face - 2}
        width={2 * face + 4}
        height={2 * face + 4}
        className="fill-(--map-ground)"
      />
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

export {
  HazardMark,
  type HazardTone,
  KEY_GLYPH,
  LotMark,
  MARK_BOX,
  type MarkState,
  PhotoMark,
  PutInMark,
};
