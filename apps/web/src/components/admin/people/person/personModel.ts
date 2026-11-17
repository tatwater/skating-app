import type { api } from '@skating/convex/api';
import { CONTRADICTION_FLAG_THRESHOLD, TRUST_CLASS_LABELS } from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { plural, timeLeftInWords } from '@/lib/ages';
import { floorText as countText } from '../answers';
import { WORDS } from './personWords';

/**
 * The person page's reads, as the page words them — pure, so each rule is tested without Convex.
 * `PersonPane` runs the queries; the blocks draw what these return.
 *
 * **Three answers, never confused on screen** (the People server's contract):
 * - **pending** — still being prepared after a deploy: *Still being prepared*, never a number and
 *   never a "+";
 * - **capped** — the read stopped short: a floor, "N+";
 * - **`null`** — not recorded: *Not recorded yet*.
 *
 * None of the three is ever drawn as zero. A figure in one of them is a dash in the dim ink with the
 * words on its sub-line, as the season tiles draw theirs, so the cell keeps its shape.
 */

// ── The reads ────────────────────────────────────────────────────────────────────────────────

export type PersonRead = NonNullable<FunctionReturnType<typeof api.people.person>>;
export type Can = PersonRead['can']['suspend'];

/**
 * `can` as the web reads it from either server: the server follow-up adds an explicit `extend` (a
 * new window on a suspended account); today's server has none, and the page reads `suspend` for it.
 */
export type PersonCan = PersonRead['can'] & { extend?: Can };
export type HistoryRead = NonNullable<FunctionReturnType<typeof api.people.history>>;
export type ActionRow = HistoryRead['rows'][number];
/**
 * `people.decisions`, as the web reads it from either server: today's always answers a page; the
 * server follow-up answers `null` for someone not on staff or with no account — no feed, not an error.
 */
export type DecisionsRead = NonNullable<FunctionReturnType<typeof api.people.decisions>>;
export type DecisionsAnswer = DecisionsRead | null;
export type StaffStatsRead = NonNullable<FunctionReturnType<typeof api.people.staffStats>>;
export type StaffSeasonRead = NonNullable<FunctionReturnType<typeof api.people.staffSeason>>;
export type TrendRead = NonNullable<FunctionReturnType<typeof api.people.reportTrend>>;
export type Role = PersonRead['role'];

/** A count a read capped (`Count` on the server). */
export type Count = { count: number; capped: boolean };

// ── Facts: a value, or one of the three answers ─────────────────────────────────────────────

export const PENDING_WORDS = WORDS.pending;
export const NOT_RECORDED = WORDS.notRecorded;

export type FactTone = 'default' | 'warn' | 'bad' | 'dim';
export type FactState = 'value' | 'capped' | 'pending' | 'unrecorded' | 'empty';

/** A person a cell names: their name as the page says it, and their photo when there is one. */
export type NamedPerson = { userId: string; name: string; src: string | null };

/**
 * What a stat cell draws: its value (a dash for the three answers), unit, tone and sub-line — and,
 * when the sub-line names people, who (`named`: drawn after `sub` as circles and names, the rest
 * counted).
 */
export type Fact = {
  value: string;
  unit?: string;
  tone: FactTone;
  sub?: string;
  named?: { people: NamedPerson[]; more: number };
  state: FactState;
};

/** The dash every answer that isn't a number draws, with its words on the sub-line. */
const DASH = '—';

export const pendingFact = (): Fact => ({
  value: DASH,
  tone: 'dim',
  sub: PENDING_WORDS,
  state: 'pending',
});

export const unrecordedFact = (sub: string = NOT_RECORDED): Fact => ({
  value: DASH,
  tone: 'dim',
  sub,
  state: 'unrecorded',
});

/** A count as a cell writes it: "283", "1,204", or "200+" — the People pages' one form. */
export { countText };

/**
 * A count as a cell draws it. Pending wins over everything (the figure may be wrong, not merely
 * short); `null` is not recorded; a capped count is a floor.
 */
export function countFact(
  count: Count | null,
  opts: { pending?: boolean; unit?: string; sub?: string; tone?: FactTone } = {},
): Fact {
  if (opts.pending === true) return pendingFact();
  if (count === null) return unrecordedFact();
  return {
    value: countText(count),
    ...(opts.unit !== undefined && { unit: opts.unit }),
    tone: opts.tone ?? 'default',
    ...(opts.sub !== undefined && { sub: opts.sub }),
    state: count.capped ? 'capped' : 'value',
  };
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A count and its word, written out — `lib/ages`' one form, which every person-page word uses. */
export { plural };

/** One formatter a zone (`''` is the reader's own): building one is the costly part of a call. */
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? '';
  let f = FORMATTERS.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-GB', {
      weekday: 'short',
      day: 'numeric',
      month: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    });
    FORMATTERS.set(key, f);
  }
  return f;
}

/** The parts of `at` in `timeZone` (the reader's own when absent). */
function parts(at: number, timeZone?: string) {
  const f = formatter(timeZone).formatToParts(at);
  const get = (type: string) => f.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: get('weekday'),
    day: Number(get('day')),
    month: Number(get('month')),
    year: Number(get('year')),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** "14 Oct" — and "14 Oct 2025" when it isn't `now`'s year. */
export function dateWords(at: number, now: number, timeZone?: string): string {
  const p = parts(at, timeZone);
  const base = `${p.day} ${MONTHS[p.month - 1]}`;
  return p.year === parts(now, timeZone).year ? base : `${base} ${p.year}`;
}

/** "Sat 10 Oct 19:48" — a status line's moment, with the year when it isn't `now`'s. */
export function momentWords(at: number, now: number, timeZone?: string): string {
  const p = parts(at, timeZone);
  return `${p.weekday} ${dateWords(at, now, timeZone)} ${p.time}`;
}

/** "1 Oct" for a `YYYY-MM-DD` key: the calendar day it names, in no zone. */
export function dayKeyWords(key: string): string {
  const [, m, d] = key.split('-').map(Number);
  return `${d ?? 1} ${MONTHS[(m ?? 1) - 1]}`;
}

/** "Oct 2026" for a `YYYY-MM` month key. */
export function monthKeyWords(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${y ?? ''}`.trim();
}

/** "14 Oct" for a UTC day start (the staff weeks are counted in UTC days). */
export function utcDayWords(at: number): string {
  const d = new Date(at);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The role, in the console's words: a member is a skater. */
export const ROLE_WORDS: Record<Role, string> = {
  admin: 'Admin',
  moderator: 'Moderator',
  member: 'Skater',
};

/** "an admin", "a moderator", "a skater". */
export const ROLE_ARTICLE: Record<Role, string> = {
  admin: 'an admin',
  moderator: 'a moderator',
  member: 'a skater',
};

/**
 * The trust class, capitalized (the pill sets it in caps) — core's words, the ones the list's chip
 * reads, so a class can't be spelled two ways.
 */
export const TRUST_WORDS: Readonly<Record<NonNullable<PersonRead['trustClass']>, string>> =
  TRUST_CLASS_LABELS;

/** A person named in a row: their name, or the handle when it is blank; `null` before the rows. */
export function personName(ref: {
  displayName: string | null;
  username: string | null;
}): string | null {
  const name = ref.displayName?.trim() ?? '';
  if (name !== '') return name;
  const handle = ref.username?.trim() ?? '';
  return handle === '' ? null : handle;
}

/**
 * The name a page says for the person it is about — the head, the dialogs, the receipts — and a
 * list row's: their real name, or the handle for an account with no name on it. One rule, so an
 * account the list names by its handle is never an empty heading or a nameless toast.
 */
export function shownName(p: { displayName: string | null; username: string | null }): string {
  return personName(p) ?? p.username ?? '';
}

/** Staff are named by first name in prose (the boards' rule). */
export const firstName = (name: string) => name.split(/\s+/u)[0] ?? name;

// ── The status note ──────────────────────────────────────────────────────────────────────────

export type StatusNoteWords = {
  /** The badge: "Suspended · 1 day left", "Banned". */
  badge: string;
  tone: 'warn' | 'bad';
  /** The reason on file, or *Not recorded yet*. */
  reason: string | null;
  /** Who set it: their name (first name, staff by first name), *System*, or not recorded. */
  by: { name: string; via: string | null } | 'system' | null;
  /** "Suspended Sat 10 Oct 19:48", or `null` when no row says when. */
  when: string | null;
  /** "Lifts on its own Thu 15 Oct 19:48", on its own line; `null` for a ban or an open end. */
  lifts: string | null;
};

/** What the status note says about a suspension or a ban, every fact from `statusNote`. */
export function statusNoteWords(
  note: NonNullable<PersonRead['statusNote']>,
  now: number,
  timeZone?: string,
): StatusNoteWords {
  const suspended = note.action === 'suspend';
  const until = note.suspendedUntil;
  // The read's `lapsed` is as of the minute the page opened; the end passing since is lapsed too.
  const lapsed = note.lapsed || (until !== null && until <= now);
  let badge: string;
  if (!suspended) badge = WORDS.banned;
  else if (lapsed) badge = WORDS.suspendedLapsed;
  else if (until === null) badge = WORDS.suspendedOpenEnded;
  else badge = WORDS.suspendedLeft(timeLeftInWords(until, now).toLowerCase());
  const named = note.by === null ? null : personName(note.by);
  const by: StatusNoteWords['by'] =
    note.by === null
      ? note.at === null
        ? null
        : 'system'
      : { name: named === null ? WORDS.nameNotReady : firstName(named), via: note.via };
  const verb = suspended ? 'Suspended' : 'Banned';
  return {
    badge,
    tone: suspended ? 'warn' : 'bad',
    reason: note.reason?.trim() ? note.reason.trim() : null,
    by,
    when: note.at === null ? null : `${verb} ${momentWords(note.at, now, timeZone)}`,
    lifts:
      suspended && until !== null
        ? lapsed
          ? WORDS.ranItsCourse(momentWords(until, now, timeZone))
          : `Lifts on its own ${momentWords(until, now, timeZone)}`
        : null,
  };
}

// ── The skater strip ─────────────────────────────────────────────────────────────────────────

/** Contradictions: private, unexplained by weather; amber from the flag threshold. */
export function contradictionsFact(value: number | null): Fact {
  if (value === null) return unrecordedFact();
  return {
    value: value.toLocaleString('en-US'),
    tone: value >= CONTRADICTION_FLAG_THRESHOLD ? 'warn' : 'default',
    sub: 'Private · unexplained by weather',
    state: 'value',
  };
}

/**
 * Open flags: on their content (the value) and on them (the sub-line). Flags on their content rest
 * on the subject backfill: until it has run, that figure is *Still being prepared*.
 */
export function openFlagsFact(
  flags: PersonRead['strip']['openFlags'],
  contentPending: boolean,
): Fact {
  const onUser = WORDS.onThePerson(countText(flags.onUser));
  if (contentPending) return { ...pendingFact(), sub: `${PENDING_WORDS} · ${onUser}` };
  const total = flags.onContent.count + flags.onUser.count;
  return {
    value: countText(flags.onContent),
    unit: 'on content',
    tone: total > 0 ? 'bad' : 'default',
    sub: capitalize(onUser),
    state: flags.onContent.capped ? 'capped' : 'value',
  };
}

/** Reports: kept and hidden together, with hidden and edited under them. */
export function reportsFact(trend: TrendRead): Fact {
  return {
    value: countText(trend.total),
    tone: 'default',
    sub: `${countText(trend.hidden)} hidden · ${countText(trend.edited)} edited`,
    state: trend.total.capped ? 'capped' : 'value',
  };
}

/** Raw trust points — only when the read returns them for this viewer. */
export function trustPointsFact(points: number): Fact {
  return {
    value: points.toLocaleString('en-US'),
    tone: 'default',
    sub: 'Raw score',
    state: 'value',
  };
}

export type TrendBar = { key: string; title: string; kept: number; hidden: number };

/** The months the read returns (months before the account are absent, not zero), oldest first. */
export function trendBars(trend: TrendRead): TrendBar[] {
  return trend.months.map((m) => ({
    key: m.month,
    title: monthKeyWords(m.month),
    kept: m.kept,
    hidden: m.hidden,
  }));
}

/** The trend's label: how many months it shows. */
export function trendLabel(trend: TrendRead): string {
  const n = trend.months.length;
  return `Reports · ${plural(n, 'month', 'months')}`;
}

// ── The staff strip ──────────────────────────────────────────────────────────────────────────

type Undone = StaffStatsRead['decisions']['undoneByOthers'];

/**
 * Who undid a staffer's decisions this week, most first, as the strip names them: the server's
 * named few (staff, so by first name, the boards' rule), and how many more — a person whose row
 * isn't written yet is counted with the rest, never drawn as a blank name.
 */
export function undoersOf(undone: Undone): { people: NamedPerson[]; more: number } {
  const people: NamedPerson[] = [];
  let more = undone.byMore;
  for (const ref of undone.by) {
    const name = personName(ref);
    if (name === null) more++;
    else people.push({ userId: ref.userId, name: firstName(name), src: ref.profileImageUrl });
  }
  return { people, more };
}

/**
 * Decisions this week, and how many someone else later undid on net — naming who, when the read
 * names anyone ("2 later undone by ‹Ada› and 1 more"), else in the plain words.
 */
export function decisionsFact(stats: StaffStatsRead): Fact {
  const undone = stats.decisions.undoneByOthers;
  const base = {
    value: countText(stats.decisions.thisWeek),
    unit: 'this week',
    tone: 'default',
    state: stats.decisions.thisWeek.capped ? 'capped' : 'value',
  } as const;
  if (stats.pending.length > 0) return { ...base, sub: WORDS.undonePending };
  if (undone.count === 0 && !undone.capped) return { ...base, sub: WORDS.noneUndone };
  const named = undoersOf(undone);
  if (named.people.length > 0) {
    return { ...base, sub: WORDS.undoneByNamed(countText(undone)), named };
  }
  return {
    ...base,
    sub:
      undone.count === 1 && !undone.capped
        ? WORDS.undoneByOne(countText(undone))
        : WORDS.undoneByMany(countText(undone)),
  };
}

/** The median, filed to decided: minutes, then hours, then days. */
export function timeToDecideFact(stats: StaffStatsRead): Fact {
  const t = stats.timeToDecide;
  const sub = 'Median, filed to decided';
  if (t.capped) {
    return {
      value: DASH,
      tone: 'dim',
      sub: WORDS.medianTooMany,
      state: 'capped',
    };
  }
  if (t.medianMs === null) {
    return unrecordedFact(t.decided === 0 ? WORDS.noneDecided : NOT_RECORDED);
  }
  const minutes = Math.round(t.medianMs / 60_000);
  if (minutes < 120)
    return { value: String(minutes), unit: 'min', tone: 'default', sub, state: 'value' };
  const hours = Math.round(t.medianMs / HOUR);
  if (hours < 48)
    return { value: String(hours), unit: 'hours', tone: 'default', sub, state: 'value' };
  return {
    value: String(Math.round(t.medianMs / DAY)),
    unit: 'days',
    tone: 'default',
    sub,
    state: 'value',
  };
}

/**
 * Overturned this season. Between 1 July and 1 October the season is honestly empty: a dash, and
 * the day its record begins.
 */
export function overturnedFact(season: StaffSeasonRead): Fact {
  if (season.empty) {
    return {
      value: DASH,
      tone: 'dim',
      sub: `Record begins ${dayKeyWords(season.opensOn)}`,
      state: 'empty',
    };
  }
  return countFact(season.overturned, {
    pending: season.pending.length > 0,
    sub: 'This season',
  });
}

/** The tenure cell's label: *Admin since* on an admin's page, *Staff since* on a moderator's. */
export const tenureLabel = (role: Role) => (role === 'admin' ? 'Admin since' : 'Staff since');

/**
 * The tenure cell. On an admin's page it is *Admin since* — the day they became an admin (the
 * board's value) — with the day they first joined staff under it when that was earlier ("Moderator
 * from 12 Jan"), or *Admin from the start*. On a moderator's page it is *Staff since*, with the
 * role's own day under it when that differs. Dates from `roleSince` / `staffSince`; pending, capped
 * and not recorded said as such.
 */
export function staffSinceFact(
  stats: StaffStatsRead,
  role: Role,
  now: number,
  timeZone?: string,
): { label: string; fact: Fact } {
  const admin = role === 'admin';
  const label = tenureLabel(role);
  if (stats.pending.length > 0) return { label, fact: pendingFact() };
  const main = admin ? stats.roleSince : stats.staffSince;
  const other = admin ? stats.staffSince : stats.roleSince;
  if (main === null) {
    return {
      label,
      fact: stats.tenureCapped
        ? { value: DASH, tone: 'dim', sub: WORDS.tenureTooOld, state: 'capped' }
        : unrecordedFact(),
    };
  }
  // The other day, beneath, only when it is known and differs; the same day is "from the start".
  const sub =
    other === null
      ? undefined
      : other.at === main.at
        ? WORDS.roleFromTheStart(ROLE_WORDS[role])
        : admin
          ? WORDS.staffFrom(ROLE_WORDS[other.role], dateWords(other.at, now, timeZone))
          : WORDS.roleSince(ROLE_WORDS[role], dateWords(other.at, now, timeZone));
  return {
    label,
    fact: {
      value: dateWords(main.at, now, timeZone),
      tone: 'default',
      ...(sub !== undefined && { sub }),
      state: 'value',
    },
  };
}

export type WeekBar = { key: string; title: string; count: number; capped: boolean };

/** The nine weeks, oldest first; the last runs to today. */
export function weekBars(stats: StaffStatsRead, now: number): WeekBar[] {
  return stats.weeks.map((w, i) => {
    const last = i === stats.weeks.length - 1;
    const end = last ? Math.min(w.from + 7 * DAY, now) - 1 : w.from + 7 * DAY - 1;
    const from = utcDayWords(w.from);
    const to = utcDayWords(end);
    const sameMonth = new Date(w.from).getUTCMonth() === new Date(end).getUTCMonth();
    return {
      key: String(w.from),
      // "13–19 Aug" within a month, "28 Sep–4 Oct" across one (the board's "12–14 Oct").
      title:
        from === to ? from : sameMonth ? `${new Date(w.from).getUTCDate()}–${to}` : `${from}–${to}`,
      count: w.count,
      capped: w.capped,
    };
  });
}

/** "152 in all", a floor when any week was. */
export function weeksTotal(stats: StaffStatsRead): string {
  const total = stats.weeks.reduce((n, w) => n + w.count, 0);
  const capped = stats.weeks.some((w) => w.capped);
  return `${countText({ count: total, capped })} in all`;
}

// ── Small things ─────────────────────────────────────────────────────────────────────────────

export const capitalize = (s: string) => (s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1));
