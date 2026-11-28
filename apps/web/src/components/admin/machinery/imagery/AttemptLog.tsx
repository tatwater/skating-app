import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { usePaginatedQuery } from 'convex/react';
import { useEffect, useMemo, useRef } from 'react';

import { Log, type LogCopy, type LogLine } from '@/components/kit/log';
import { CellLoader } from '@/components/kit/meter';

import { clockSeconds } from '../corpus/runFormat';
import type { AttemptLogLine } from './imageryModel';
import * as W from './imageryWords';

/** Lines a page of an attempt's log holds (`machineryImagery.attemptLog`'s page). */
export const ATTEMPT_LOG_PAGE = 200;

/** Within this of the log's top, the reader has scrolled up for more. */
const TOP_SLACK_PX = 24;

const TONE: Record<string, LogLine['tone']> = {
  stage: 'stage',
  start: 'stage',
  warn: 'warn',
  fail: 'bad',
  cap: 'warn',
};

/**
 * A stored attempt line as the log draws it: the writer's own clock (`loggedAt` — the cutter's
 * stamp, Fly's, or the pump's), **who wrote it** as the word after the time (*cutter*, *Fly*,
 * *pump*: the board's first-line `cutter`), toned by its kind (a warning amber, a failure red, a
 * stage bright), then its text. A line with no origin (written before origins) has no word.
 */
export function attemptLineOf(e: AttemptLogLine, timeZone?: string): LogLine {
  const tone = TONE[e.kind];
  return {
    id: e.seq,
    time: clockSeconds(e.loggedAt, timeZone),
    ...(e.origin != null && { word: W.ORIGIN_WORDS[e.origin] }),
    ...(tone !== undefined && { tone }),
    text:
      e.kind === 'cap' && e.dropped !== null ? `${e.text} (${e.dropped} lines not kept)` : e.text,
  };
}

export type AttemptLogProps = {
  /** The lines loaded so far, oldest first; `undefined` while the first page loads. */
  lines: readonly AttemptLogLine[] | undefined;
  more: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** A cut that didn't land red-washes its last line. */
  failed: boolean;
  timeZone?: string;
  onCopy?: (text: string, what: LogCopy) => void;
  className?: string;
};

/**
 * **An attempt's machine log** (board 6.4's *Machine log*) on the kit's `Log`: the cutter's own
 * lines, Fly's and the pump's, merged at settle and kept in Convex. A post-mortem, never a live tail
 * (Ma19): no Follow. The read pages newest first and this draws oldest first, asking for an older
 * page as the reader scrolls to the top. A copy is of the lines loaded.
 */
export function AttemptLog({
  lines,
  more,
  loadingOlder = false,
  onLoadOlder,
  failed,
  timeZone,
  onCopy,
  className,
}: AttemptLogProps) {
  const box = useRef<HTMLDivElement>(null);
  const ask = useRef({ more, loadingOlder, onLoadOlder });
  ask.current = { more, loadingOlder, onLoadOlder };
  const drawn = useMemo(
    () => (lines === undefined ? [] : lines.map((l) => attemptLineOf(l, timeZone))),
    [lines, timeZone],
  );
  const shown = drawn.length > 0;

  useEffect(() => {
    if (!shown) return;
    const viewport = box.current?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) return;
    const onScroll = () => {
      const { more: m, loadingOlder: busy, onLoadOlder: load } = ask.current;
      if (viewport.scrollTop <= TOP_SLACK_PX && m && !busy) load?.();
    };
    viewport.addEventListener('scroll', onScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', onScroll);
  }, [shown]);

  if (lines === undefined) {
    return (
      <div data-slot="attempt-log" data-loading="" className={className}>
        <CellLoader label={W.LOG_LOADING} />
      </div>
    );
  }
  return (
    <div ref={box} data-slot="attempt-log" className={className}>
      {more && (
        <p
          data-slot="attempt-log-more"
          className="m-0 mb-(--space-1_5) font-(family-name:--family-mono) text-mono-sm text-fg3"
        >
          {loadingOlder ? W.LOADING_OLDER : W.SCROLL_UP}
        </p>
      )}
      {drawn.length === 0 ? (
        <p data-slot="attempt-log-empty" className="m-0 text-assist text-fg3">
          {W.LOG_EMPTY}
        </p>
      ) : (
        <Log
          lines={drawn}
          state={failed ? 'failed' : 'finished'}
          aria-label={W.MACHINE_LOG}
          {...(onCopy !== undefined && { onCopy })}
          boxClassName="h-[12rem]"
        />
      )}
    </div>
  );
}

/**
 * The log wired to `machineryImagery.attemptLog`: 200 lines a page, newest first, reversed to draw
 * oldest first; scrolling up loads the next older page.
 */
export function LiveAttemptLog({
  attemptId,
  ...rest
}: Omit<AttemptLogProps, 'lines' | 'more' | 'loadingOlder' | 'onLoadOlder'> & {
  attemptId: Id<'imageryAttempts'>;
}) {
  const { results, status, loadMore } = usePaginatedQuery(
    api.machineryImagery.attemptLog,
    { attemptId },
    { initialNumItems: ATTEMPT_LOG_PAGE },
  );
  const lines = useMemo(
    () => (status === 'LoadingFirstPage' ? undefined : [...results].reverse()),
    [results, status],
  );
  return (
    <AttemptLog
      key={attemptId}
      lines={lines}
      more={status === 'CanLoadMore' || status === 'LoadingMore'}
      loadingOlder={status === 'LoadingMore'}
      onLoadOlder={() => loadMore(ATTEMPT_LOG_PAGE)}
      {...rest}
    />
  );
}
