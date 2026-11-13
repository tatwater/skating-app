/**
 * The Overview's Home tab as data: the view models its blocks draw, and the pure rules that turn
 * the server's reads into them — counts that say when they were capped, the ages a list row reads
 * ("4 d"), the feed's clock words, the heads row's badges, and the live mark's state.
 *
 * Everything here is pure and takes `now` as an argument, so a board renders the same on every
 * runner (fixtures pin it to `BOARD_NOON`) and the live container is the only thing that reads the
 * clock.
 */

// ── Counts ───────────────────────────────────────────────────────────────────────────────────

/** A count the server read through an index and capped (`console.overview`'s `Count`). */
export interface Count {
  count: number;
  /** The read hit its cap: the true number is larger than `count`. */
  capped: boolean;
}

/** A count as a row says it: "283", "1,204", or "200+" once the server stopped reading. */
export function countText({ count, capped }: Count): string {
  return `${count.toLocaleString('en-US')}${capped ? '+' : ''}`;
}

/** Several counts added up; capped if any part was (the sum is then a floor, too). */
export function sumCounts(parts: ReadonlyArray<Count | null | undefined>): Count {
  let count = 0;
  let capped = false;
  for (const part of parts) {
    if (part == null) continue;
    count += part.count;
    capped ||= part.capped;
  }
  return { count, capped };
}

/** The tone a count row's value wears: zero steps back; a lane can ask for amber or red above it. */
export type ValueTone = 'default' | 'dim' | 'warn' | 'bad';

export function countTone(count: Count, above: Exclude<ValueTone, 'dim'> = 'default'): ValueTone {
  return count.count === 0 && !count.capped ? 'dim' : above;
}

// ── Ages and clock words ─────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * A list row's age, short: "12 min", "5 h", "1.5 d", "4 d". Under two days it keeps a tenth (a
 * day and a half reads differently from a day); past that, whole days, rounded down — an item is
 * "4 d" old until it is five. Never negative: a clock skew reads as "0 min".
 */
export function shortAge(ms: number): string {
  const age = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h`;
  const days = age / DAY;
  const shown = days < 2 ? Math.floor(days * 10) / 10 : Math.floor(days);
  return `${shown} d`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
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

/** "14:41" — the local time of day, 24-hour. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "14:42:31" — to the second (the live mark's *Last checked*). */
export function clockSeconds(at: number): string {
  const d = new Date(at);
  return `${clockTime(at)}:${pad2(d.getSeconds())}`;
}

/** "3 Oct" — a table cell's date: day and month, no year. */
export function dayMonth(at: number): string {
  const d = new Date(at);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The month's short name ("Oct") for a `YYYY-MM` key or an instant. */
export function monthName(at: number): string {
  return MONTHS[new Date(at).getMonth()] ?? '';
}

/** Local midnight of the day `at` falls on. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * When a feed row happened, as the board writes it: the time alone today ("14:41"), the weekday and
 * time within the last six days ("Sat 22:14"), the date before that ("3 Oct"). Calendar days in the
 * viewer's zone, so "today" turns over at their midnight, not 24 hours on.
 */
export function feedWhen(at: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day >= today) return clockTime(at);
  // Calendar days apart, rounded: a DST change makes one day 23 or 25 hours long.
  const daysAgo = Math.round((today - day) / DAY);
  if (daysAgo <= 6) return `${WEEKDAYS[new Date(at).getDay()]} ${clockTime(at)}`;
  return dayMonth(at);
}

// ── Heads: what needs a person, what needs a hand ────────────────────────────────────────────

export interface Head {
  /** The kicker over the badges ("Needs a person"). */
  kicker: string;
  /** Amber waits on a person; red will not recover without one. */
  tone: 'warn' | 'bad';
  /** One state per badge ("19 in the inbox", "2 re-fits"): two states are two badges. */
  badges: string[];
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The heads row's two groups. A badge for zero is dropped, and a group with no badges is dropped
 * with it — the row never says "0 failed".
 */
export function overviewHeads({
  inbox,
  refits,
  stalled,
  failed,
}: {
  /** Everything open in the Inbox. */
  inbox: Count;
  /** Chord re-fits waiting in the Corpus — "200+" once the read stopped, as the inbox's count. */
  refits: Count;
  /** Runs gone quiet past their heartbeat. */
  stalled: number;
  /** Runs or crons whose last outcome was a failure. */
  failed: number;
}): Head[] {
  const person = [
    inbox.count > 0 ? `${countText(inbox)} in the inbox` : null,
    refits.count > 0 ? `${countText(refits)} ${plural(refits.count, 're-fit', 're-fits')}` : null,
  ].filter((b): b is string => b !== null);
  const hand = [
    stalled > 0 ? `${stalled} stalled` : null,
    failed > 0 ? `${failed} failed` : null,
  ].filter((b): b is string => b !== null);
  const heads: Head[] = [];
  if (person.length > 0) heads.push({ kicker: 'Needs a person', tone: 'warn', badges: person });
  if (hand.length > 0) heads.push({ kicker: 'Needs a hand', tone: 'bad', badges: hand });
  return heads;
}

// ── The live mark ────────────────────────────────────────────────────────────────────────────

/** Live (heard from the server lately), checking (a request in flight), or off (gone quiet). */
export type LiveState = 'live' | 'checking' | 'off';

/** How many expected intervals of silence make the mark go hollow. */
export const QUIET_FACTOR = 3;

/**
 * The live mark's state. Quiet for more than three times the expected interval reads *Not live*
 * whatever else is true — a request stuck in flight doesn't keep a dead feed looking fresh. Inside
 * that, a request in flight reads *Checking*. Nothing heard yet is *Checking*, never live.
 */
export function liveMarkState({
  now,
  lastCheckedAt,
  expectedMs,
  inFlight = false,
}: {
  now: number;
  /** When the feed last heard from the server; `null` before it ever has. */
  lastCheckedAt: number | null;
  /** How often it expects to hear. */
  expectedMs: number;
  inFlight?: boolean;
}): LiveState {
  if (lastCheckedAt === null) return 'checking';
  if (now - lastCheckedAt > QUIET_FACTOR * expectedMs) return 'off';
  return inFlight ? 'checking' : 'live';
}
