import {
  type ComponentProps,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  useRef,
} from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/kit/toggle-group';
import { cn } from '@/lib/utils';

import { BAND_WORD, isShown, type PassRow, seenWords } from './imageryModel';

/**
 * Board 5.4.6's dock, at the map's foot over the symbol key: the passes as notches on one rail,
 * the lit pass's caption, and the band switch. The frame places it; it draws what it is handed.
 *
 * **With the Imagery tab open the thumb lands on every pass**, hidden ones too (the founder's call:
 * an admin's thumb lands on a skipped pass only here). A shown pass is a tall notch, a hidden one a
 * short faint one, a pass staff showed anyway a tall amber one — amber because a person overrode
 * the gate. ← → step, Home and End go to the ends, a press picks the nearest notch.
 */

export type ImageryDockViewProps = Omit<ComponentProps<'div'>, 'children' | 'onSelect'> & {
  rows: readonly PassRow[];
  selected: number;
  onSelect: (index: number) => void;
  /** The bands this season published, `visual` first (core's `bandsIn`). */
  bands: readonly string[];
  band: string;
  onBandChange: (band: string) => void;
};

/*
 * The scrubber's sizes, which the token library lacks (the mock's, body-tab-imagery-v5.js and
 * v5.js `drawScrubber`): one-off to this dock.
 */
/** A shown pass's notch: 14 px. */
const SCRUB_TALL = '0.875rem';
/** A hidden pass's notch: 7 px. */
const SCRUB_SHORT = '0.4375rem';
/** The thumb: a hollow plate 8 × 22 px around the lit notch. */
const SCRUB_THUMB_WIDTH = '0.5rem';
const SCRUB_THUMB_HEIGHT = '1.375rem';

const SCRUB_VARS = {
  '--scrub-tall': SCRUB_TALL,
  '--scrub-short': SCRUB_SHORT,
  '--scrub-thumb-width': SCRUB_THUMB_WIDTH,
  '--scrub-thumb-height': SCRUB_THUMB_HEIGHT,
} as CSSProperties;

/** Where notch `i` of `n` stands on the rail, as a fraction: evenly, one per pass. */
export function notchAt(i: number, n: number): number {
  return n <= 1 ? 0.5 : i / (n - 1);
}

/** The notch nearest a fraction of the rail. */
export function nearestNotch(fraction: number, n: number): number {
  if (n <= 1) return 0;
  return Math.min(n - 1, Math.max(0, Math.round(fraction * (n - 1))));
}

export function ImageryDockView({
  rows,
  selected,
  onSelect,
  bands,
  band,
  onBandChange,
  className,
  ...props
}: ImageryDockViewProps) {
  const row = rows[selected];
  return (
    <div
      data-slot="imagery-dock"
      className={cn(
        'flex flex-col gap-(--space-1_5) bg-map-foot px-(--space-3_5) pt-(--space-2) pb-(--space-2_5)',
        className,
      )}
      {...props}
    >
      {rows.length > 0 && <PassScrubber rows={rows} selected={selected} onSelect={onSelect} />}
      <div className="flex items-center justify-between gap-(--space-3)">
        <span data-slot="dock-caption" className="flex min-w-0 flex-col gap-[0.2em]">
          {row === undefined ? (
            <span className="text-assist text-fg2">
              No satellite passes over this body this winter
            </span>
          ) : (
            <>
              <span className="text-row leading-(--lead-snug) text-fg2">
                <b className="font-medium text-fg">{row.date}</b> · {row.source}
              </span>
              <span className="text-assist leading-(--lead-snug) whitespace-nowrap text-fg3">
                {row.caveat !== null && `${row.caveat} · `}
                {isShown(row.seen) ? (
                  seenWords(row.seen)
                ) : (
                  <b className="font-medium text-fg1">{seenWords(row.seen)}</b>
                )}
              </span>
            </>
          )}
        </span>
        {bands.length > 1 && (
          <ToggleGroup aria-label="Band" value={band} onValueChange={onBandChange}>
            {bands.map((b) => (
              <ToggleGroupItem key={b} value={b}>
                {BAND_WORD[b] ?? b}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </div>
    </div>
  );
}

function PassScrubber({
  rows,
  selected,
  onSelect,
}: {
  rows: readonly PassRow[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const rail = useRef<HTMLDivElement>(null);
  const n = rows.length;
  const row = rows[selected];
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const next =
      event.key === 'ArrowLeft' || event.key === 'ArrowDown'
        ? selected - 1
        : event.key === 'ArrowRight' || event.key === 'ArrowUp'
          ? selected + 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? n - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const clamped = Math.min(n - 1, Math.max(0, next));
    if (clamped !== selected) onSelect(clamped);
  };
  const onPointer = (event: PointerEvent<HTMLDivElement>) => {
    const r = rail.current?.getBoundingClientRect();
    if (r === undefined || r.width === 0) return;
    const at = nearestNotch((event.clientX - r.left) / r.width, n);
    if (at !== selected) onSelect(at);
  };
  return (
    <div
      ref={rail}
      role="slider"
      tabIndex={0}
      aria-label="Pass"
      aria-valuemin={1}
      aria-valuemax={n}
      aria-valuenow={selected + 1}
      aria-valuetext={row === undefined ? undefined : `${row.date}, ${seenWords(row.seen)}`}
      data-slot="pass-scrubber"
      onKeyDown={onKey}
      onPointerDown={onPointer}
      className="relative mx-(--space-0_5) h-(--scrub-thumb-height) cursor-pointer outline-none focus-visible:shadow-focus"
      style={SCRUB_VARS}
    >
      <i aria-hidden="true" className="absolute inset-x-0 bottom-0 h-(--stroke-hair) bg-line" />
      {rows.map((r, i) => (
        <i
          key={r.id}
          aria-hidden="true"
          data-slot="pass-notch"
          data-seen={r.seen}
          className={cn(
            'absolute bottom-0 w-(--stroke-hair) -translate-x-1/2',
            isShown(r.seen) ? 'h-(--scrub-tall)' : 'h-(--scrub-short)',
            r.seen === 'shown' && 'bg-fg2',
            r.seen === 'shown-anyway' && 'bg-warn',
            !isShown(r.seen) && (i === selected ? 'bg-fg2' : 'bg-line2'),
          )}
          style={{ left: `${notchAt(i, n) * 100}%` }}
        />
      ))}
      <i
        aria-hidden="true"
        data-slot="pass-thumb"
        className={cn(
          'absolute bottom-0 z-1 h-(--scrub-thumb-height) w-(--scrub-thumb-width) -translate-x-1/2 border border-solid bg-transparent',
          row !== undefined && isShown(row.seen) ? 'border-fg' : 'border-fg2',
        )}
        style={{ left: `${notchAt(selected, n) * 100}%` }}
      />
    </div>
  );
}
