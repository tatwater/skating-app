import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faExpand } from '@fortawesome/sharp-light-svg-icons';
import { ONBOARDING_COPY, termsVersionLabel } from '@skating/core';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '../../kit/button';
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../kit/dialog';
import { Kbd } from '../../kit/kbd';
import { ScrollArea } from '../../kit/scroll-area';
import { useEntryScroller } from './EntryScreen';
import { TermsText } from './TermsText';

/** Where the end was reached: the page's own reader, or the full-screen one. */
export type TermsReaderVia = 'inline' | 'fullscreen';

/**
 * Calls `onSeen` once `el` has been wholly on screen inside `root` — the box that scrolls it (the
 * reader's window, the phone's page, the full-screen reader's body). An `IntersectionObserver`
 * rooted there, not at the viewport: a desk board drawn wider than its canvas (a story, a narrow
 * window) must still count the end it scrolled to. Watches only while `armed` and `root` is known,
 * and stops after one sighting. `stillRight` is asked at the sighting: a root the layout has just
 * stopped making the right one (the observer is re-rooted a beat later) never counts.
 */
export function useSeenOnScreen(
  el: HTMLElement | null,
  root: HTMLElement | null,
  armed: boolean,
  onSeen: () => void,
  stillRight: () => boolean = () => true,
): void {
  const seen = useRef(onSeen);
  seen.current = onSeen;
  const right = useRef(stillRight);
  right.current = stillRight;
  useEffect(() => {
    if (!armed || !el || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!right.current()) return;
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.99)) {
          observer.disconnect();
          seen.current();
        }
      },
      { root, threshold: [0, 0.99, 1] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, root, armed]);
}

/**
 * Calls `onGone` once `el` is wholly off screen inside `root` — how a disarmed end learns the marker
 * has left, so the next arrival can count again. Watches only while `active` and `root` is known.
 */
export function useGoneFromScreen(
  el: HTMLElement | null,
  root: HTMLElement | null,
  active: boolean,
  onGone: () => void,
): void {
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (!active || !el || !root || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => !e.isIntersecting)) {
          observer.disconnect();
          gone.current();
        }
      },
      { root, threshold: [0] },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, root, active]);
}

/** How far through its content a box has scrolled, 0–1, or `null` when it doesn't scroll. */
export function scrollFraction(el: HTMLElement | null): number | null {
  if (!el) return null;
  const room = el.scrollHeight - el.clientHeight;
  if (room <= 1) return null;
  return Math.min(1, Math.max(0, el.scrollTop / room));
}

/**
 * The box the skater reads the inline terms in, as the layout stands now: the reader's own window
 * when it scrolls (a desk), else the page (a phone, where the window lets go of its height and
 * clips nothing) — or `null` while the page isn't known yet, so nothing is watched. Never the
 * window when it doesn't scroll: rooted there, the whole text is "inside" it and the end would
 * count without a scroll.
 */
export function readingRoot(own: HTMLElement | null, page: HTMLElement | null): HTMLElement | null {
  return scrollFraction(own) !== null ? own : page;
}

/**
 * **The terms, read here** (boards 10.3, 10.4, 11.2–11.4; D295). On a desk, a window onto the whole
 * text with a rail that says how far (the kit's `ScrollArea`, its thumb always drawn); on a phone the
 * page is the reader — the window lets go of its height and the screen's own body scrolls, and the
 * hairline under the bar fills instead (`onProgress`).
 *
 * The end marker's arrival on screen is the reading's end, in either place: watched while `armed`,
 * reported once through `onEnd('inline')`. *Open in full-screen* is the kit Dialog at its viewer
 * size, the same text and marker; reaching its end reports `onEnd('fullscreen')`, and Esc brings the
 * skater back with the box unlocked. Neither reader gates the Privacy Notice: it is a link.
 *
 * `resetKey` starts the reading again from the top of both readers (a refusal that says the server
 * has no reading). While `disarmed` — a stamp failed, or the reading started again — the end doesn't
 * count; the reader watches for the marker to leave the screen instead and says so through
 * `onEndGone`, so the next arrival can.
 */
export function TermsReader({
  read,
  waiting = false,
  armed,
  disarmed = false,
  onEndGone,
  resetKey = 0,
  onEnd,
  onScrollActivity,
  onProgress,
}: {
  /** The end has been reached and recorded: the meta line says so. */
  read: boolean;
  /**
   * A reached end has waited a while on the server: the full-screen reader's foot says it is still
   * connecting, as the page does under the agreement, which the open dialog covers.
   */
  waiting?: boolean;
  /** Whether reaching the end counts now (off while it's already counted, or being recorded). */
  armed: boolean;
  /** A stamp failed: watch for the end marker to leave the screen (`onEndGone`). */
  disarmed?: boolean;
  onEndGone?: () => void;
  resetKey?: number;
  onEnd: (via: TermsReaderVia) => void;
  /** Any scroll in either reader: the skater is reading. */
  onScrollActivity?: () => void;
  onProgress?: (fraction: number) => void;
}) {
  const copy = ONBOARDING_COPY.terms;
  const box = useRef<HTMLDivElement>(null);
  const [end, setEnd] = useState<HTMLDivElement | null>(null);
  const [fullEnd, setFullEnd] = useState<HTMLDivElement | null>(null);
  const scroller = useEntryScroller();
  const [full, setFull] = useState(false);

  const viewport = useCallback(
    () => box.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null,
    [],
  );

  // What scrolls the inline end into view (`readingRoot`), picked again whenever the layout changes:
  // the card's container query flips the window between a scrolling box (a desk) and none (a
  // phone), which resizes it, and the page arrives a render after the reader does.
  const [inlineRoot, setInlineRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const own = viewport();
    const pick = () => setInlineRoot(readingRoot(own, scroller));
    pick();
    if (!own || typeof ResizeObserver === 'undefined') return;
    const layout = new ResizeObserver(pick);
    layout.observe(own);
    if (scroller) layout.observe(scroller);
    return () => layout.disconnect();
  }, [viewport, scroller]);

  // How far: the window when it scrolls (a desk), else the phone's page.
  const progress = useRef(onProgress);
  progress.current = onProgress;
  useEffect(() => {
    const own = viewport();
    const report = () => {
      const fraction = scrollFraction(own) ?? scrollFraction(scroller);
      if (fraction !== null) progress.current?.(fraction);
    };
    report();
    own?.addEventListener('scroll', report, { passive: true });
    scroller?.addEventListener('scroll', report, { passive: true });
    return () => {
      own?.removeEventListener('scroll', report);
      scroller?.removeEventListener('scroll', report);
    };
  }, [viewport, scroller]);

  // A new reading starts at the top, in every reader: the full-screen one too, or its end would
  // still sit in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger
  useEffect(() => {
    if (resetKey === 0) return;
    viewport()?.scrollTo({ top: 0 });
    scroller?.scrollTo({ top: 0 });
    fullEnd?.closest<HTMLElement>('[data-slot="dialog-body"]')?.scrollTo({ top: 0 });
    progress.current?.(0);
  }, [resetKey]);

  // The skater is reading, in whichever reader scrolls: the window, the page, or the full screen.
  const activity = useRef(onScrollActivity);
  activity.current = onScrollActivity;
  const fullRoot = fullEnd?.closest<HTMLElement>('[data-slot="dialog-body"]') ?? null;
  useEffect(() => {
    const boxes = [viewport(), scroller, fullRoot].filter((b): b is HTMLElement => b !== null);
    const tell = () => activity.current?.();
    for (const b of boxes) b.addEventListener('scroll', tell, { passive: true });
    return () => {
      for (const b of boxes) b.removeEventListener('scroll', tell);
    };
  }, [viewport, scroller, fullRoot]);

  useSeenOnScreen(
    end,
    inlineRoot,
    armed && !full,
    () => onEnd('inline'),
    () => readingRoot(viewport(), scroller) === inlineRoot,
  );
  useSeenOnScreen(fullEnd, fullRoot, armed && full, () => onEnd('fullscreen'));
  // Disarmed: the marker in whichever reader is open has to leave before it can count again.
  useGoneFromScreen(full ? fullEnd : end, full ? fullRoot : inlineRoot, disarmed, () =>
    onEndGone?.(),
  );

  return (
    <div data-slot="terms-reader" className="flex flex-col gap-3">
      <div ref={box}>
        <ScrollArea
          always
          aria-label={copy.kicker}
          className="h-[18.5rem] border border-line2 border-solid bg-panel @max-[48rem]/entry:h-auto @max-[48rem]/entry:border-0 @max-[48rem]/entry:bg-transparent @max-[48rem]/entry:[&_[data-slot=scroll-area-scrollbar]]:hidden"
          viewportClassName="px-[1.375rem] py-5 @max-[48rem]/entry:p-0"
        >
          <TermsText ref={setEnd} />
        </ScrollArea>
      </div>
      <div className="flex items-center gap-3 @max-[48rem]/entry:hidden">
        <span
          data-slot="terms-meta"
          className="whitespace-nowrap font-(family-name:--family-mono) font-medium text-[0.75rem] text-fg2 leading-none"
        >
          {termsVersionLabel()}
          {read && ` · ${copy.readToEnd}`}
        </span>
        <Dialog open={full} onOpenChange={setFull}>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setFull(true)}
            data-attr="terms-full-screen"
          >
            {copy.openFullScreen}
            <FontAwesomeIcon icon={faExpand} aria-hidden="true" />
          </Button>
          <DialogContent size="viewer" data-surface="skater" className="ph-no-capture">
            <DialogHeader>
              <DialogTitle>{copy.kicker}</DialogTitle>
            </DialogHeader>
            <DialogBody className="items-center">
              <div className="w-full max-w-[42rem] py-4">
                <TermsText ref={setFullEnd} />
              </div>
            </DialogBody>
            <DialogFooter
              note={
                <span className="flex items-center gap-2">
                  <span className="font-(family-name:--family-mono)">
                    {termsVersionLabel()}
                    {read && ` · ${copy.readToEnd}`}
                  </span>
                  {/* In the foot from the start, empty until the wait is long (a live region mounted
                      holding its words is often not announced). */}
                  <span role="status" data-slot="terms-waiting" className="empty:sr-only">
                    {waiting ? copy.stillConnecting : null}
                  </span>
                </span>
              }
            >
              <Kbd variant="dim" aria-hidden="true">
                Esc
              </Kbd>
              <DialogClose render={<Button size="sm" />}>
                {ONBOARDING_COPY.terms.closeFullScreen}
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
