/**
 * **The console's two ways of saying how long** — one home for each, by the founder's standing rule:
 *
 * - **A list row** says it short, as the boards draw a row's right column: {@link shortAge} —
 *   "12 min", "5 h", "1.5 d", "4 d" (and "12 d left" built on it).
 * - **A pane head, a note or a status line** writes its units out: {@link ageInWords} — "2 days ago",
 *   "Just now" — and {@link timeLeftInWords} — "1 day left", "Less than an hour left".
 *
 * The Overview, Metrics, the People list and the person page all read these; none keeps its own.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

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

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** How long ago `at` was, written out: "2 days ago", "5 hours ago", "3 minutes ago", "Just now". */
export function ageInWords(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age >= DAY) return `${plural(Math.floor(age / DAY), 'day', 'days')} ago`;
  if (age >= HOUR) return `${plural(Math.floor(age / HOUR), 'hour', 'hours')} ago`;
  const minutes = Math.floor(age / MINUTE);
  return minutes < 1 ? 'Just now' : `${plural(minutes, 'minute', 'minutes')} ago`;
}

/** How long until `until`, written out: "1 day left", "5 hours left", "Less than an hour left". */
export function timeLeftInWords(until: number, now: number): string {
  const left = until - now;
  if (left >= DAY) return `${plural(Math.floor(left / DAY), 'day', 'days')} left`;
  if (left >= HOUR) return `${plural(Math.floor(left / HOUR), 'hour', 'hours')} left`;
  return 'Less than an hour left';
}
