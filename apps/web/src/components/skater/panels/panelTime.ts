/**
 * The cards' clock words, in the viewer's own zone. Coarse on purpose: an observation's age is a
 * confidence signal, not a measurement (D3), so nothing here is finer than a minute and nothing past
 * a day says the hour unless the line asks for it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days between two instants, in the viewer's zone (0 = the same day). */
export function daysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / DAY);
}

/** "11:40 AM". */
export function clockLabel(ms: number): string {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(ms);
}

/** "Today", "Yesterday", "Thursday" inside the week, then "Jan 4". */
export function dayLabel(ms: number, now: number): string {
  const days = daysBetween(ms, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(ms);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
}

/**
 * The short form a row's corner carries: "just now", "25 min", "3 h", "Thu", "Jan 4".
 *
 * Under a day is always counted in hours, even across midnight. This used to also require the same
 * calendar day, which meant a report that ended at 11 PM read "Fri" to anyone looking at 12:30 AM
 * — ninety minutes old, cornered as though it were days old, on the one signal the card exists to
 * carry (D3: age is a confidence signal). The day words belong to `dayLabel` and `whenLabel`,
 * which still say "Yesterday" where that is the true answer; a corner's job is the age.
 */
export function ageLabel(ms: number, now: number): string {
  const diff = now - ms;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h`;
  const days = daysBetween(ms, now);
  if (days < 7) return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(ms);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
}

/** A report's corner: "Today · 11:40 AM", "Thu · 3:15 PM", "Jan 4 · 9:05 AM". */
export function whenLabel(ms: number, now: number): string {
  const days = daysBetween(ms, now);
  const day =
    days <= 0
      ? 'Today'
      : days < 7
        ? new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(ms)
        : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
  return `${day} · ${clockLabel(ms)}`;
}
