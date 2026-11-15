/**
 * **The person page's two written-out forms** — the founder's rule: a list row says "4 d" (the
 * list's short form, `shortAge` in `overview/overviewModel`); a pane head, a note or a status line
 * writes its units out. The page draws no list rows, so it only needs these two:
 *
 * - {@link ageInWords} — how long ago, written out: "2 days ago", "5 hours ago", "Just now";
 * - {@link timeLeftInWords} — how long until, written out: "1 day left", "5 hours left".
 *
 * Named so the integrator can pair them with the list's own (its short age, and whatever it names
 * its written-out forms) and keep one pair.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** How long ago `at` was, written out: "2 days ago", "5 hours ago", "3 minutes ago", "Just now". */
export function ageInWords(at: number, now: number): string {
  const age = Math.max(0, now - at);
  if (age >= DAY) return `${plural(Math.floor(age / DAY), 'day', 'days')} ago`;
  if (age >= HOUR) return `${plural(Math.floor(age / HOUR), 'hour', 'hours')} ago`;
  const minutes = Math.floor(age / 60_000);
  return minutes < 1 ? 'Just now' : `${plural(minutes, 'minute', 'minutes')} ago`;
}

/** How long until `until`, written out: "1 day left", "5 hours left", "Less than an hour left". */
export function timeLeftInWords(until: number, now: number): string {
  const left = until - now;
  if (left >= DAY) return `${plural(Math.floor(left / DAY), 'day', 'days')} left`;
  if (left >= HOUR) return `${plural(Math.floor(left / HOUR), 'hour', 'hours')} left`;
  return 'Less than an hour left';
}
