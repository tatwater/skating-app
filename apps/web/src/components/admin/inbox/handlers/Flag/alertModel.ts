import type { LifeLine, LifeLineMeaning, LifeStation } from '@/components/kit/life-strip';

import { dayKey, dayMonth } from './flagFormat';
import type { AlertSubjectData } from './flagTypes';
import { ALERT_WORDS as W } from './flagWords';

/**
 * **An access alert's life, as the kit's strip map** (board 2.6) — pure. One station per event,
 * evenly spaced; the line between two is the state the alert was in then (thin: active, lapsing on
 * its own; heavy: pinned official) with the days it lasted; and, while it would still lapse, a last
 * dashed line to the day it would (what happens if no one acts — never what happened). A run of
 * confirmations folds into one station so any count fits. A station records what happened to the
 * alert; nothing here says whether the access is or was as claimed.
 */

const DAY = 86_400_000;

type Event = AlertSubjectData['life'][number];

/** "6 d" between two moments, never negative; under a day "<1 d". */
export function lastedWords(from: number, to: number): string {
  const days = Math.floor(Math.max(0, to - from) / DAY);
  return days < 1 ? '<1 d' : `${days} d`;
}

/** Consecutive confirmations folded into one event that counts them. */
export function foldConfirmations(life: readonly Event[]): (Event & { times: number })[] {
  const out: (Event & { times: number })[] = [];
  for (const e of life.slice().sort((a, b) => a.at - b.at)) {
    const last = out[out.length - 1];
    if (last !== undefined && e.event === 'confirmed' && last.event === 'confirmed') {
      out[out.length - 1] = { ...e, times: last.times + 1, by: e.by };
    } else {
      out.push({ ...e, times: 1 });
    }
  }
  return out;
}

const MARK = {
  posted: 'dot',
  pinned: 'square',
  unpinned: 'square',
  confirmed: 'ring',
  denied: 'hollow',
  flagged: 'warn',
  retracted: 'square',
  resolved: 'square',
} as const;

/** The alert's stations, oldest first, and what each line weight means here. */
export function alertLife(
  alert: Pick<AlertSubjectData, 'life' | 'status' | 'expiresAt'>,
  now: number,
  timeZone?: string,
): { stations: LifeStation[]; lines: LifeLineMeaning[] } {
  const events = foldConfirmations(alert.life);
  let pinned = false;
  const states: LifeLine[] = [];
  for (const e of events) {
    if (e.event === 'pinned') pinned = true;
    if (e.event === 'unpinned') pinned = false;
    states.push(pinned ? 'heavy' : 'thin');
  }
  const ended = alert.status === 'retracted' || alert.status === 'resolved';
  const today = dayKey(now, timeZone);
  const last = events[events.length - 1];
  const lastIsToday = last !== undefined && dayKey(last.at, timeZone) === today;
  const stations: LifeStation[] = events.map((e, i) => {
    const isLast = i === events.length - 1;
    const next = events[i + 1];
    const when = dayMonth(e.at, timeZone);
    const station: LifeStation = {
      when: isLast && lastIsToday ? W.today(when) : when,
      title: e.event === 'confirmed' && e.times > 1 ? W.confirmedTimes(e.times) : W.event[e.event],
      ...(e.by !== null && !e.by.deleted && { sub: e.by.displayName }),
      mark: isLast && lastIsToday && !ended ? 'now' : MARK[e.event],
    };
    if (next !== undefined) {
      station.next = states[i] ?? 'thin';
      station.lasted = lastedWords(e.at, next.at);
    }
    return station;
  });
  // Today, when nothing happened today and the alert still stands.
  if (!ended && last !== undefined && !lastIsToday) {
    const prev = stations[stations.length - 1];
    if (prev !== undefined) {
      prev.next = states[states.length - 1] ?? 'thin';
      prev.lasted = lastedWords(last.at, now);
    }
    stations.push({ when: W.today(dayMonth(now, timeZone)), title: W.todayTitle, mark: 'now' });
  }
  // The day it would lapse, if no one acts — only while it still would.
  const lapses = !ended && alert.expiresAt !== null && alert.expiresAt > now;
  if (lapses && alert.expiresAt !== null) {
    const prev = stations[stations.length - 1];
    if (prev !== undefined) {
      prev.next = 'dashed';
      prev.lasted = lastedWords(now, alert.expiresAt);
    }
    stations.push({
      when: dayMonth(alert.expiresAt, timeZone),
      title: W.wouldLapse,
      sub: W.ifNoOneActs,
      mark: 'end',
    });
  }
  const used = new Set(stations.map((s) => s.next).filter((l): l is LifeLine => l !== undefined));
  const lines: LifeLineMeaning[] = (
    [
      { line: 'thin', label: W.lineActive },
      { line: 'heavy', label: W.linePinned },
      { line: 'dashed', label: W.lineNext },
    ] as const
  ).filter((l) => used.has(l.line));
  return { stations, lines };
}

/** "Pinned · since 3 Oct", "Active · lapses 8 Nov" — the skater's card's foot. */
export function alertCardFoot(
  alert: Pick<AlertSubjectData, 'status' | 'life' | 'expiresAt'>,
  timeZone?: string,
): string {
  const pin = alert.life
    .slice()
    .reverse()
    .find((e) => e.event === 'pinned');
  if (alert.status === 'official' && pin !== undefined)
    return W.pinnedSince(dayMonth(pin.at, timeZone));
  if (alert.expiresAt !== null) return W.lapses(dayMonth(alert.expiresAt, timeZone));
  return W.status[alert.status] ?? alert.status;
}
