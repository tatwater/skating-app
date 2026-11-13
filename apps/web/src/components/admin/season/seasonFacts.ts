/**
 * The season's state as Home's stat strip reads it — the watch, winter region-wide, imagery and the
 * first skate — and the adapter from `seasonWatch.homeSummary`, which sends the record's calendar
 * days (`YYYY-MM-DD`) and instants; this draws both in the reader's zone.
 *
 * Standalone from the Overview on purpose: the Seasons page draws the same facts, and these blocks
 * move with them if Seasons folds into the Overview.
 *
 * Nothing here says the ice is safe or predicts it: the watch is a schedule for the machines and a
 * prompt for staff, and every word is about what was measured.
 */

import type { api } from '@skating/convex/api';
import type { FunctionReturnType } from 'convex/server';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "3 Oct" for an instant. */
export function dayMonthOf(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** A record's `YYYY-MM-DD` as local midnight (the watch's dates are calendar days, not instants). */
export function isoDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

// ── The watch ────────────────────────────────────────────────────────────────────────────────

export type IceWatch =
  /** No night has opened it yet; nights count from `countsFrom`. */
  | { state: 'waiting'; countsFrom: number }
  /** Opened on `since`, by `sentinels` of `of` sentinels and/or the region's bodies. */
  | { state: 'open'; since: number; sentinels: number; of: number; byRegion: boolean }
  /** The thaw run closed it on `since`. */
  | { state: 'closed'; since: number };

/** What the season record keeps about the watch's opening (the fields this reads). */
export interface WatchRecord {
  opensOn: string;
  openedBy: readonly string[];
  closesOn?: string | null | undefined;
  opening?: { sentinels: readonly unknown[] } | null | undefined;
  sentinels?: readonly unknown[] | undefined;
}

export function iceWatchFromRecord(record: WatchRecord | null, countsFrom: number): IceWatch {
  if (record === null) return { state: 'waiting', countsFrom };
  if (record.closesOn) return { state: 'closed', since: isoDay(record.closesOn) };
  return {
    state: 'open',
    since: isoDay(record.opensOn),
    sentinels: record.opening?.sentinels.length ?? 0,
    of: record.sentinels?.length ?? 0,
    byRegion: record.openedBy.includes('corpus'),
  };
}

export function iceWatchWords(watch: IceWatch): {
  value: string;
  unit?: string;
  tone: 'default' | 'dim';
  sub: string;
} {
  switch (watch.state) {
    case 'waiting':
      return {
        value: 'Waiting',
        tone: 'dim',
        sub: `Counting nights from ${dayMonthOf(watch.countsFrom)}`,
      };
    case 'closed':
      return {
        value: 'Closed',
        unit: `Since ${dayMonthOf(watch.since)}`,
        tone: 'dim',
        sub: 'Ended by the thaw run',
      };
    case 'open': {
      const by =
        watch.sentinels > 0
          ? `Opened by ${watch.sentinels} of ${watch.of} sentinels${watch.byRegion ? ' and the region' : ''}`
          : 'Opened by the region’s bodies';
      return { value: 'Open', unit: `Since ${dayMonthOf(watch.since)}`, tone: 'default', sub: by };
    }
  }
}

// ── Winter, region-wide ──────────────────────────────────────────────────────────────────────

export type RegionWinter =
  | { state: 'not-yet' }
  | {
      state: 'set';
      /** The night it was recorded for. */
      from: number;
      /** How many nights in a row met the rule — one is a fragile winter, flagged amber. */
      nights: number;
      frozen: number;
      reporting: number;
      /** How many bodies the rule needs on a night. */
      needs: number;
    };

export function winterWords(winter: RegionWinter): {
  value: string;
  unit?: string;
  tone: 'default' | 'dim' | 'warn';
  sub: string;
} {
  if (winter.state === 'not-yet') {
    return { value: 'Not yet', tone: 'dim', sub: 'No night has met the rule' };
  }
  const sub = `${winter.frozen} of ${winter.reporting} bodies ≤ 32 °F on ${dayMonthOf(winter.from)} · needs ${winter.needs}`;
  // A winter recorded from a single night waits on a person to look at the thresholds.
  if (winter.nights <= 1) return { value: 'One night', tone: 'warn', sub };
  return { value: 'Set in', unit: `Since ${dayMonthOf(winter.from)}`, tone: 'default', sub };
}

// ── Imagery ──────────────────────────────────────────────────────────────────────────────────

export interface ImageryState {
  /** `ended` once the watch has closed: the cutter has stopped for the season. */
  state: 'not-started' | 'running' | 'paused' | 'ended';
  /** Granules cut this season. */
  granules: number;
  /** When the cutter was pinned to this season's build. */
  cutterPinnedAt?: number | null;
  /** When the last frame landed. */
  lastLandedAt?: number | null;
  /** When the season's last frame was captured — what an ended season is dated by. */
  lastFrameAt?: number | null;
}

export function imageryWords(imagery: ImageryState): {
  value: string;
  unit?: string;
  tone: 'default' | 'dim';
  sub: string;
} {
  const unit = `${imagery.granules.toLocaleString('en-US')} ${imagery.granules === 1 ? 'granule' : 'granules'}`;
  const landed =
    imagery.lastLandedAt != null
      ? `Last landed ${dayMonthOf(imagery.lastLandedAt)}`
      : 'Nothing landed yet';
  const pinned =
    imagery.cutterPinnedAt != null ? `Cutter pinned ${dayMonthOf(imagery.cutterPinnedAt)}` : null;
  const sub = pinned ? `${pinned} · ${landed.charAt(0).toLowerCase()}${landed.slice(1)}` : landed;
  switch (imagery.state) {
    case 'not-started':
      return { value: 'Not started', tone: 'dim', sub: 'Starts when the watch asks for it' };
    case 'paused':
      return { value: 'Paused', unit, tone: 'dim', sub };
    case 'ended':
      return {
        value: 'Ended',
        unit,
        tone: 'dim',
        sub:
          imagery.lastFrameAt != null
            ? `Last frame ${dayMonthOf(imagery.lastFrameAt)}`
            : 'No frame landed',
      };
    case 'running':
      return { value: 'Running', unit, tone: 'default', sub };
  }
}

// ── First skated ─────────────────────────────────────────────────────────────────────────────

export interface FirstSkate {
  /** This season's first report from on the ice, if any. */
  at: number | null;
  body: string | null;
  /**
   * The date was entered by staff, not reported: a season with no on-ice report at all (the launch
   * season, skated before the app could record it). A report always wins over it.
   */
  byStaff?: boolean;
  /** Last winter's, for comparison while this one has none. */
  lastWinter?: { at: number; body: string; byStaff?: boolean } | null;
}

/** The words a staff-entered date carries, so it is never read as a report. */
export const BY_STAFF = 'recorded by staff';

export function firstSkateWords(first: FirstSkate): {
  value: string;
  tone: 'default' | 'dim';
  sub: string;
} {
  const last = first.lastWinter
    ? `Last winter ${dayMonthOf(first.lastWinter.at)} · ${first.lastWinter.body}${first.lastWinter.byStaff ? ` · ${BY_STAFF}` : ''}`
    : '';
  if (first.at === null) return { value: '—', tone: 'dim', sub: last };
  if (first.byStaff) {
    const said = first.body ? `${first.body} · ${BY_STAFF}` : BY_STAFF;
    return {
      value: dayMonthOf(first.at),
      tone: 'default',
      sub: said.charAt(0).toUpperCase() + said.slice(1),
    };
  }
  return { value: dayMonthOf(first.at), tone: 'default', sub: first.body ?? last };
}

// ── From the server ──────────────────────────────────────────────────────────────────────────

/** `seasonWatch.homeSummary`, as the server returns it. */
export type HomeSummary = FunctionReturnType<typeof api.seasonWatch.homeSummary>;
type SkateMark = NonNullable<NonNullable<HomeSummary['firstSkate']>['first']>;

/** A first skate's instant: a staff-entered day at the reader's midnight, or the report's moment. */
function skateAt(mark: SkateMark): number {
  return mark.source === 'field' ? isoDay(mark.day) : mark.at;
}

/** The four tiles from the summary; each `null` where the server records nothing. */
export function seasonFromSummary(summary: HomeSummary): {
  watch: IceWatch;
  winter: RegionWinter | null;
  imagery: ImageryState;
  firstSkate: FirstSkate | null;
} {
  const first = summary.firstSkate;
  return {
    watch: iceWatchFromRecord(summary.watch, isoDay(summary.countsFrom)),
    winter:
      summary.winter === null
        ? null
        : summary.winter.state === 'not-yet'
          ? { state: 'not-yet' }
          : { ...summary.winter, from: isoDay(summary.winter.from) },
    imagery: summary.imagery,
    firstSkate:
      first === null
        ? null
        : {
            at: first.first === null ? null : skateAt(first.first),
            body: first.first?.body ?? null,
            ...(first.first?.source === 'field' ? { byStaff: true } : {}),
            lastWinter:
              first.lastWinter === null
                ? null
                : {
                    at: skateAt(first.lastWinter),
                    body: first.lastWinter.body ?? 'A body since removed',
                    ...(first.lastWinter.source === 'field' ? { byStaff: true } : {}),
                  },
          },
  };
}
