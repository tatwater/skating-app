import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { usePaginatedQuery } from 'convex/react';
import { useEffect, useMemo, useRef } from 'react';

import { Log, type LogCopy, type LogLine } from '@/components/kit/log';
import { CellLoader } from '@/components/kit/meter';

import { RUN_WORDS, TAIL_WORDS } from '../words/runWords';
import { clockSeconds } from './runFormat';
import { type QuietLine, quietLine } from './runModel';
import type { LivenessView, RunEventView } from './runViews';

/** Lines a page of the log holds (the read's page). */
export const TAIL_PAGE = 200;

/** Within this of the log's top, the reader has scrolled up for more. */
const TOP_SLACK_PX = 24;

const TONE: Record<string, LogLine['tone']> = {
  start: 'stage',
  stage: 'stage',
  flush: 'ok',
  warn: 'warn',
  fail: 'bad',
  mark: 'bad',
  wait: 'warn',
  stop: 'warn',
  cap: 'warn',
};

/**
 * A stored line as the log draws it: its writer's time (the laptop's, `loggedAt`), its kind's word
 * toned by meaning, its text. The `cap` row is drawn honestly — how many lines past the log's limit
 * weren't kept — whatever text it carries; a close that says it failed is red.
 */
export function logLineOf(e: RunEventView, timeZone?: string): LogLine {
  const word = TAIL_WORDS.kind[e.kind] ?? e.kind;
  if (e.kind === 'cap') {
    return {
      id: e.seq,
      time: clockSeconds(e.loggedAt, timeZone),
      word,
      tone: 'warn',
      text: e.dropped === null ? TAIL_WORDS.cappedUnknown : TAIL_WORDS.capped(e.dropped),
    };
  }
  // The logger's close reads *Failed: …*; the server's, for a run closed beside a mark, *The loader
  // closed the run itself: failed…* — both red.
  const failedClose = e.kind === 'close' && /(^|: )failed\b/i.test(e.text);
  const tone = failedClose ? 'bad' : (TONE[e.kind] ?? undefined);
  return {
    id: e.seq,
    time: clockSeconds(e.loggedAt, timeZone),
    word,
    ...(tone !== undefined && { tone }),
    text: e.text,
  };
}

/** The page's own last line while the run is quiet, appended (never stored, so never a seq). */
function quietLogLine(q: QuietLine, now: number, timeZone?: string): LogLine {
  return {
    id: 'quiet',
    time: clockSeconds(now, timeZone),
    word: q.word,
    tone: q.tone,
    text: q.text,
    ...(q.fail && { fail: true }),
  };
}

export type RunTailProps = {
  /** The lines loaded so far, oldest first. `undefined` while the first page loads. */
  events: readonly RunEventView[] | undefined;
  /** Older lines remain on the server. */
  more: boolean;
  /** An older page is on its way. */
  loadingOlder?: boolean;
  /** Loads the next older page (scrolling to the top asks for it). */
  onLoadOlder?: () => void;
  /** How the log draws: live while the run writes. */
  state: 'live' | 'finished' | 'failed';
  /** The run's liveness at the page's clock: a late or stalled run gets the page's quiet line. */
  liveness: LivenessView;
  /** The last heartbeat the server saw, for the quiet line's "no flush since". */
  lastHeardAt: number | null;
  now: number;
  timeZone?: string;
  /** Where a copy goes (a story's own); the clipboard otherwise. */
  onCopy?: (text: string, what: LogCopy) => void;
  className?: string;
};

/**
 * **The live tail** (board 6.2's *Live tail*) on the kit's `Log` — Follow while the run writes, the
 * Copy split (*Copy log*, *Copy warnings & errors*). The lines are the run logger's own (start,
 * stages, counts at each flush, failures, beats, close) and what the console did to the run; the
 * read pages them newest first and this draws them oldest first, asking for an older page when the
 * reader scrolls to the top (*Scroll up for full log output*). A copy is of the lines loaded.
 * While the run is late or stalled the page draws its own last line, from the stall rule.
 */
export function RunTail({
  events,
  more,
  loadingOlder = false,
  onLoadOlder,
  state,
  liveness,
  lastHeardAt,
  now,
  timeZone,
  onCopy,
  className,
}: RunTailProps) {
  const box = useRef<HTMLDivElement>(null);
  const ask = useRef({ more, loadingOlder, onLoadOlder });
  ask.current = { more, loadingOlder, onLoadOlder };
  const lines = useMemo(() => {
    if (events === undefined) return [];
    const drawn = events.map((e) => logLineOf(e, timeZone));
    const q = state === 'live' ? quietLine(liveness, lastHeardAt, timeZone) : null;
    return q === null ? drawn : [...drawn, quietLogLine(q, now, timeZone)];
  }, [events, state, liveness, lastHeardAt, now, timeZone]);
  // The log (and its scroller) is drawn only once there is a line: a run opened before its first
  // line lands draws the empty note first, so the scroll is wired when the log appears.
  const drawn = lines.length > 0;

  // Scrolling to the top asks for the next older page.
  useEffect(() => {
    if (!drawn) return;
    const viewport = box.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const onScroll = () => {
      const { more: m, loadingOlder: busy, onLoadOlder: load } = ask.current;
      if (viewport.scrollTop <= TOP_SLACK_PX && m && !busy) load?.();
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [drawn]);

  if (events === undefined) {
    return (
      <div data-slot="run-tail" data-loading="" className={className}>
        <CellLoader label={RUN_WORDS.logLoading} />
      </div>
    );
  }
  return (
    <div ref={box} data-slot="run-tail" className={className}>
      {more && (
        <p
          data-slot="run-tail-more"
          className="m-0 mb-(--space-1_5) font-(family-name:--family-mono) text-mono-sm text-fg3"
        >
          {loadingOlder ? RUN_WORDS.loadingOlder : RUN_WORDS.scrollUp}
        </p>
      )}
      {lines.length === 0 ? (
        <p data-slot="run-tail-empty" className="m-0 text-assist text-fg3">
          {RUN_WORDS.noLines}
        </p>
      ) : (
        <Log
          lines={lines}
          state={state}
          {...(onCopy !== undefined && { onCopy })}
          boxClassName="h-[17rem]"
        />
      )}
    </div>
  );
}

/**
 * The tail wired to `machineryRuns.events`: a page of 200 at a time, newest first, reversed to draw
 * oldest first; scrolling up loads the next older page. Live: a new line lands on the first page.
 */
export function LiveRunTail({
  runId,
  ...rest
}: Omit<RunTailProps, 'events' | 'more' | 'loadingOlder' | 'onLoadOlder'> & {
  runId: Id<'importRuns'>;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.machineryRuns.events,
    { runId },
    { initialNumItems: TAIL_PAGE },
  );
  const events = useMemo(
    () => (status === 'LoadingFirstPage' ? undefined : [...results].reverse()),
    [results, status],
  );
  return (
    <RunTail
      key={runId}
      events={events}
      more={status === 'CanLoadMore' || status === 'LoadingMore'}
      loadingOlder={status === 'LoadingMore'}
      onLoadOlder={() => loadMore(TAIL_PAGE)}
      {...rest}
    />
  );
}
