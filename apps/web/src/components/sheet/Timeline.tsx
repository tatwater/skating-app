import {
  type TimelineModel,
  timelineCaretBounds,
  timelineFraction,
  timelineMsAt,
} from '@skating/core';
import { type PointerEvent as ReactPointerEvent, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

/**
 * The timeline (A10-6 / D206): core's `timelineModel` drawn as a ruler. Hour ticks with their
 * labels below the line; sunrise and sunset as amber ticks; the start and end of this Report as
 * ice carets with the skate as a filled span between them; *now* in ink; the Post's other Reports
 * as faded spans with their number; photos as small squares at their minute; D192's ladder as the
 * tappable half-hours.
 *
 * **The carets drag.** A pointer on START or END moves it along the ruler and hands the minute
 * back through `onSetStart` / `onSetEnd` on release — the WHEN section's fields are the keyboard's
 * way to the same values (founder call 2026-09-23: all three set from either). A click that does
 * not move commits nothing: the caret's own minute is where a drag starts from, so a press on the
 * label is not an edit. A tap on a ladder tick chooses that half-hour as the end. Nothing here is
 * a safety claim (D3).
 */
export function Timeline({
  model,
  onSetEnd,
  onSetStart,
  dim = false,
  endLocked = false,
}: {
  model: TimelineModel;
  onSetEnd?: (ms: number) => void;
  onSetStart?: (ms: number) => void;
  dim?: boolean;
  /** A track's end is exact (`gps`) and is not dragged off it. */
  endLocked?: boolean;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const [drag, setDrag] = useState<{ kind: 'start' | 'end'; ms: number; moved: boolean } | null>(
    null,
  );

  const fractionAt = (clientX: number): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return (clientX - rect.left) / rect.width;
  };
  const begin =
    (kind: 'start' | 'end', fromMs: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (kind === 'end' && (endLocked || !onSetEnd)) return;
      if (kind === 'start' && !onSetStart) return;
      // jsdom has no pointer capture; a browser does, and it keeps the drag when it leaves the caret.
      if (typeof e.currentTarget.setPointerCapture === 'function') {
        e.currentTarget.setPointerCapture(e.pointerId);
      }
      setDrag({ kind, ms: fromMs, moved: false });
    };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const { min, max } = timelineCaretBounds(model, drag.kind);
    const ms = Math.min(max, Math.max(min, timelineMsAt(model, fractionAt(e.clientX))));
    setDrag({ ...drag, ms, moved: true });
  };
  const end = () => {
    if (!drag) return;
    if (drag.moved) {
      if (drag.kind === 'end') onSetEnd?.(drag.ms);
      else onSetStart?.(drag.ms);
    }
    setDrag(null);
  };

  const pct = (fraction: number) => `${fraction * 100}%`;
  const marks = model.marks.map((m) =>
    drag && m.kind === drag.kind
      ? { ...m, fraction: timelineFraction(model, drag.ms), label: `${m.label.split(' ')[0]} …` }
      : m,
  );
  const endBounds = timelineCaretBounds(model, 'end');
  const mine = model.spans.find((s) => s.mine);
  const startMark = marks.find((m) => m.kind === 'start');
  const endMark = marks.find((m) => m.kind === 'end');

  return (
    <fieldset
      ref={ref}
      className={cn(
        'relative mx-9 h-[72px] select-none border-0 p-0 font-mono',
        dim && 'sheet-dim',
      )}
      aria-label="The day, as a timeline"
    >
      {/* The base line */}
      <div className="absolute top-10 right-0 left-0 h-px bg-border-strong/60" />
      {/* The other Reports' spans, then this skate's */}
      {model.spans
        .filter((s) => !s.mine)
        .map((s) => (
          <div
            key={s.id}
            className="absolute top-[38px] h-[5px] bg-foreground-muted/35"
            style={{ left: pct(s.from), width: pct(Math.max(s.to - s.from, 0.004)) }}
          >
            {s.label ? (
              <span className="-translate-x-1/2 absolute top-[-14px] left-1/2 whitespace-nowrap text-[9px] text-foreground-muted">
                {s.label}
              </span>
            ) : null}
          </div>
        ))}
      {mine && startMark && endMark ? (
        <div
          className="absolute top-[38px] h-[5px] bg-primary/80"
          style={{
            left: pct(Math.min(startMark.fraction, endMark.fraction)),
            width: pct(Math.max(Math.abs(endMark.fraction - startMark.fraction), 0.002)),
          }}
        />
      ) : null}
      {/* Hour ticks */}
      {model.ticks.map((t) => (
        <div
          key={t.ms}
          className="absolute top-9 h-[9px] w-px bg-border-strong"
          style={{ left: pct(t.fraction) }}
        >
          <span className="-translate-x-1/2 absolute top-[14px] left-0 whitespace-nowrap text-[10px] text-foreground-muted">
            {t.label}
          </span>
        </div>
      ))}
      {/* The ladder: tappable half-hours (D192) */}
      {model.ladder.map((l) => (
        <button
          key={l.ms}
          type="button"
          // A half-hour at or before the start (or past *now*) would invert the skate; it is drawn
          // but not offered.
          disabled={l.ms < endBounds.min || l.ms > endBounds.max}
          onClick={() => onSetEnd?.(l.ms)}
          aria-label={`End about ${l.label}`}
          className="-translate-x-1/2 absolute top-[30px] h-5 w-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
          style={{ left: pct(l.fraction) }}
        >
          <span
            className={cn(
              'mx-auto block h-3 w-px',
              l.pinned ? 'bg-foreground' : 'bg-foreground-muted',
            )}
          />
        </button>
      ))}
      {/* Photos */}
      {model.photos.map((p) => (
        <span
          key={p.id}
          aria-hidden
          className={cn(
            'absolute top-7 size-[6px] border',
            p.placed
              ? 'border-primary bg-primary'
              : p.mine
                ? 'border-foreground bg-background'
                : 'border-foreground-muted bg-background',
          )}
          style={{ left: `calc(${pct(p.fraction)} - 3px)` }}
        />
      ))}
      {/* Marks */}
      {marks.map((m) => {
        if (m.kind === 'sunrise' || m.kind === 'sunset') {
          return (
            <div
              key={m.kind}
              className="absolute top-[34px] h-3 w-px bg-warning"
              style={{ left: pct(m.fraction) }}
            >
              <span className="-translate-x-1/2 absolute top-[-16px] left-0 whitespace-nowrap text-[10px] text-warning">
                {m.label}
              </span>
            </div>
          );
        }
        if (m.kind === 'now') {
          return (
            <div
              key={m.kind}
              className="absolute top-7 h-5 w-px bg-foreground"
              style={{ left: pct(m.fraction) }}
            >
              <span className="-translate-x-1/2 absolute top-[24px] left-0 whitespace-nowrap font-semibold text-[10px] text-foreground">
                {m.label}
              </span>
            </div>
          );
        }
        const draggable =
          m.kind === 'end' ? !endLocked && onSetEnd !== undefined : onSetStart !== undefined;
        return (
          <button
            key={m.kind}
            type="button"
            aria-label={`${m.label}${draggable ? ', drag to change' : ''}`}
            onPointerDown={begin(m.kind, m.ms)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={() => setDrag(null)}
            className={cn(
              '-translate-x-1/2 absolute top-3 flex h-10 w-6 flex-col items-center focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              draggable ? 'cursor-ew-resize' : 'cursor-default',
            )}
            style={{ left: pct(m.fraction) }}
          >
            <span className="whitespace-nowrap font-semibold text-[10px] text-foreground">
              {m.label}
            </span>
            <span
              className={cn(
                'mt-0.5 size-0 border-x-[5px] border-x-transparent border-t-[7px]',
                m.kind === 'end' ? 'border-t-primary' : 'border-t-primary/70',
              )}
              style={{ filter: 'drop-shadow(0 0 4px var(--ring))' }}
            />
            <span className="h-4 w-px bg-primary" />
          </button>
        );
      })}
    </fieldset>
  );
}
