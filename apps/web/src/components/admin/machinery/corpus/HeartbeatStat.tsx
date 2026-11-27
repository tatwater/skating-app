import { StatTile, type StatTone } from '@/components/kit/stat-tile';
import { cn } from '@/lib/utils';

import { RUN_WORDS as W } from '../words/runWords';
import { clock, everyWords, quietPart } from './runFormat';
import type { LivenessView, RunStatus } from './runViews';

/**
 * **The heartbeat** (kit candidate; boards 6.2 and `live-v5` §1): a `StatTile` whose value is how
 * long the run has been quiet, at the page's clock, and whose tone follows the stall rule — the
 * plain ink while running ("18 s ago"), amber once late or held ("4 min quiet"), red once stalled
 * ("41 min quiet", its kicker red too). The sub-line is the pace it is held to ("Reports about every
 * 3 min"), never a measured rate nothing records. A run that has ended reads *Ended* with how
 * (*failed · By hand* for a mark); one that never beat reads *Not recorded*.
 */
export function HeartbeatStat({
  liveness,
  status,
  marked,
  lastHeardAt,
  timeZone,
  className,
}: {
  /** At the page's clock. */
  liveness: LivenessView;
  status: RunStatus;
  marked: boolean;
  /** The last heartbeat the server saw (`progressAt`), when one was recorded. */
  lastHeardAt: number | null;
  timeZone?: string;
  className?: string;
}) {
  const heard = lastHeardAt === null ? undefined : W.lastHeard(clock(lastHeardAt, timeZone));
  if (liveness.state === 'finished' || marked) {
    const ended = marked ? 'failed' : status === 'running' ? 'running' : status;
    return (
      <StatTile
        data-slot="heartbeat"
        data-state="finished"
        className={className}
        label={W.ended}
        value={ended}
        {...(marked && { unit: W.byHand })}
        tone="dim"
        {...(heard !== undefined && { sub: heard })}
      />
    );
  }
  if (liveness.state === 'notRecorded') {
    return (
      <StatTile
        data-slot="heartbeat"
        data-state="notRecorded"
        className={className}
        label={W.heartbeat}
        value={W.notRecorded}
        tone="warn"
        sub={W.noHeartbeat}
      />
    );
  }
  const part = quietPart(liveness.quietMs);
  const tone: StatTone =
    liveness.state === 'stalled'
      ? 'bad'
      : liveness.state === 'late' || liveness.state === 'waiting'
        ? 'warn'
        : 'default';
  const sub =
    liveness.state === 'waiting' && liveness.waitUntil !== null
      ? W.waitingUntil(clock(liveness.waitUntil, timeZone))
      : liveness.expectedMs === null
        ? W.noPace
        : W.reportsEvery(everyWords(liveness.expectedMs));
  return (
    <StatTile
      data-slot="heartbeat"
      data-state={liveness.state}
      className={className}
      label={
        <span className={cn(tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>
          {W.heartbeat}
        </span>
      }
      value={part.value}
      unit={liveness.state === 'running' ? W.agoUnit(part.unit) : W.quietUnit(part.unit)}
      tone={tone}
      sub={sub}
    />
  );
}
