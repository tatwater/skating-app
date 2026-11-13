import type { LandmarkKind } from '@skating/core';
import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * **Kit candidate** (beside `map-marks`). A landmark's mark: an 11 px plate filled by its kind,
 * with the kind's glyph cut in the ground color — the boards' `SYM.v4` landmark plates
 * (`body-tab-places-v5.js`, `map.js`). A list of landmarks leads each row with its mark so the
 * list reads as the map's key; the map draws the same face larger.
 *
 * - **Fill by meaning, rationed.** Water named as a place (a river, a bay, a narrows) takes the
 *   dim ice — the one place color goes, since it is geography; a beach is amber as the boards draw
 *   it; land and structures are grays. Nothing here is red: a landmark is never a hazard.
 * - **A proposal is drawn as proposed**: a dashed frame where a landmark has a filled plate, and a
 *   question mark, since a skater's proposal has no kind until a moderator gives it one.
 * - **Decoration**: the mark is `aria-hidden`; the row beside it names the kind in words.
 */

type Glyph = { fill: string; inner: ReactNode };

const VOID = 'var(--bg)';
const STROKE = { stroke: VOID, strokeWidth: 1.3, fill: 'none' } as const;

/** Each kind's plate and glyph, drawn on a −5.5…5.5 box. */
const GLYPHS: Record<LandmarkKind, Glyph> = {
  island: {
    fill: 'var(--line2)',
    inner: <circle r={2.6} fill="none" stroke="var(--fg1)" strokeDasharray="1.2 1.2" />,
  },
  beach: { fill: 'var(--warn)', inner: <path d="M-3 2 h6 M-2 -1 h4" {...STROKE} /> },
  bridge: { fill: 'var(--fg1)', inner: <path d="M-3.5 -1.5 h7 M-3.5 1.5 h7" {...STROKE} /> },
  dam: { fill: 'var(--fg1)', inner: <rect x={-3.5} y={-1.5} width={7} height={3} fill={VOID} /> },
  waterway: {
    fill: 'var(--acc-dim)',
    inner: <path d="M-3.5 0 q1.75 -2.5 3.5 0 t3.5 0" {...STROKE} />,
  },
  bay: { fill: 'var(--acc-dim)', inner: <path d="M-3 -2 q0 4 3 4 t3 -4" {...STROKE} /> },
  narrows: {
    fill: 'var(--acc-dim)',
    inner: <path d="M-3.5 -2.5 l3.5 2 l3.5 -2 M-3.5 2.5 l3.5 -2 l3.5 2" {...STROKE} />,
  },
  settlement: {
    fill: 'var(--fg3)',
    inner: <rect x={-2} y={-2} width={4} height={4} fill={VOID} />,
  },
  establishment: { fill: 'var(--fg3)', inner: <path d="M0 -3 l3 5 h-6 z" fill={VOID} /> },
  point: { fill: 'var(--fg2)', inner: <path d="M-3 2 l3 -4.5 l3 4.5" {...STROKE} /> },
  marina: { fill: 'var(--fg2)', inner: <path d="M0 -3 v6 M-2.5 1 q2.5 3 5 0" {...STROKE} /> },
  lighthouse: { fill: 'var(--fg1)', inner: <path d="M-1.5 3 l0.6 -6 h1.8 l0.6 6 z" fill={VOID} /> },
  other: { fill: 'var(--fg3)', inner: <circle r={1.6} fill={VOID} /> },
};

type LandmarkMarkProps = Omit<ComponentProps<'svg'>, 'children'> & {
  /** The landmark's kind; `proposed` draws a skater's proposal (no kind yet). */
  kind: LandmarkKind | 'proposed';
};

function LandmarkMark({ kind, className, ...props }: LandmarkMarkProps) {
  return (
    <svg
      data-slot="landmark-mark"
      data-kind={kind}
      viewBox="-5.5 -5.5 11 11"
      aria-hidden="true"
      className={cn('block size-(--space-2_5) shrink-0 overflow-visible', className)}
      {...props}
    >
      {kind === 'proposed' ? (
        <>
          <rect
            x={-5}
            y={-5}
            width={10}
            height={10}
            fill="var(--map-plate)"
            stroke="var(--fg)"
            strokeDasharray="1.6 1.2"
          />
          <text
            y={2.6}
            textAnchor="middle"
            fontSize={7}
            fontWeight={700}
            fill="var(--fg)"
            fontFamily="var(--family-sans)"
          >
            ?
          </text>
        </>
      ) : (
        <>
          <rect x={-5.5} y={-5.5} width={11} height={11} fill={GLYPHS[kind].fill} />
          {GLYPHS[kind].inner}
        </>
      )}
    </svg>
  );
}

export { LandmarkMark, type LandmarkMarkProps };
