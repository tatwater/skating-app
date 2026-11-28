import { useEffect, useMemo, useRef } from 'react';

import { Log, type LogCopy, type LogLine } from '@/components/kit/log';
import { CellLoader } from '@/components/kit/meter';

import { clockSeconds } from '../corpus/runFormat';
import type { CronLogLineView } from './cronViews';
import { CRON_WORDS } from './cronWords';

/**
 * **A cron run's log** (the runs drawer's open row): the lines the job reported, oldest first, on the
 * kit `Log` with its Copy split. The read pages them newest first, 200 at a time (8a's tail); this
 * draws each page reversed and asks for the next older page when the reader scrolls to the top.
 * A finished run, so never live: a failed run's last line is red-washed by the log itself.
 */

const TONE: Partial<Record<string, LogLine['tone']>> = {
  stage: 'stage',
  start: 'stage',
  warn: 'warn',
  fail: 'bad',
  cap: 'warn',
};

/** Within this of the log's top, the reader has scrolled up for more. */
const TOP_SLACK_PX = 24;

/** A stored line as the log draws it: its writer's time, its kind's tone, its text. */
export function cronLogLine(e: CronLogLineView, timeZone?: string): LogLine {
  const tone = TONE[e.kind];
  return {
    id: e.seq,
    time: clockSeconds(e.loggedAt, timeZone),
    ...(e.kind === 'warn' || e.kind === 'fail' ? { word: e.kind } : {}),
    ...(tone !== undefined && { tone }),
    text:
      e.kind === 'cap' && e.dropped !== null
        ? `${e.dropped.toLocaleString('en-US')} lines past the log’s limit weren’t kept`
        : e.text,
  };
}

export type CronRunLogProps = {
  /** The lines loaded so far, oldest first; `undefined` while the first page loads. */
  lines: readonly CronLogLineView[] | undefined;
  /** Older lines remain on the server. */
  more: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** The run failed or was killed: its log is drawn as a failure's. */
  failed: boolean;
  /** Names the log for a reader ("Log of the run at Today 12:40"). */
  label: string;
  timeZone?: string;
  onCopy?: (text: string, what: LogCopy) => void;
};

export function CronRunLog({
  lines,
  more,
  loadingOlder = false,
  onLoadOlder,
  failed,
  label,
  timeZone,
  onCopy,
}: CronRunLogProps) {
  const box = useRef<HTMLDivElement>(null);
  const ask = useRef({ more, loadingOlder, onLoadOlder });
  ask.current = { more, loadingOlder, onLoadOlder };
  const drawn = useMemo(
    () => (lines === undefined ? [] : lines.map((e) => cronLogLine(e, timeZone))),
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
      <div data-slot="cron-run-log" data-loading="">
        <CellLoader label={CRON_WORDS.logLoading} />
      </div>
    );
  }
  return (
    <div ref={box} data-slot="cron-run-log" className="flex flex-col gap-(--space-1_5)">
      {more && (
        <p
          data-slot="cron-run-log-more"
          className="m-0 font-(family-name:--family-mono) text-mono-sm text-fg3"
        >
          {loadingOlder ? CRON_WORDS.loadingOlder : CRON_WORDS.scrollUp}
        </p>
      )}
      {shown ? (
        <Log
          aria-label={label}
          lines={drawn}
          state={failed ? 'failed' : 'finished'}
          {...(onCopy !== undefined && { onCopy })}
          boxClassName="h-auto max-h-[17rem] bg-bg"
        />
      ) : (
        <p data-slot="cron-run-log-empty" className="m-0 text-assist text-fg3">
          {CRON_WORDS.noLines}
        </p>
      )}
    </div>
  );
}
