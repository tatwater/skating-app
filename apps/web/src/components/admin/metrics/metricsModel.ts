import { HOUR_BUCKETS, OBSERVED_FROM, type ObservedFrom } from '@skating/core';

/**
 * Overview › Metrics: the shapes the tab is drawn from, and the arithmetic between a read's rows and
 * what a board says. Nothing here reads the clock — every age takes `now` — and nothing here reads
 * Convex: the props are shaped like the reads the tab asks for (the seam requests in the build
 * report), which in turn are shaped like the rows they come from (`metricSnapshots`, `signInDays`,
 * `contentFlags`, `supportTickets`, `reports`).
 *
 * **`null` always means "not recorded", never zero.** A day before a record began (the sign-in
 * record and the support queue's depth start the day B01-1 shipped), a metric no write path keeps
 * yet (kudos; the per-state widening), a rollup that didn't run — each is `null`, and each is drawn
 * as absent, never as a bar of nothing. A zero is a measured zero.
 */

// ── Days ─────────────────────────────────────────────────────────────────────────────────────

/** A metric day: the UTC `YYYY-MM-DD` key every `metricSnapshots` row and `signInDays` row uses. */
export type DayKey = string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A day key's midnight, as an instant. Metric days are UTC, so the key names one calendar day. */
function dayInstant(day: DayKey): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

const DAY_MONTH = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });

/** "7 Oct" — a day key as the boards write a date (day, then month). */
export function dayLabel(day: DayKey): string {
  const parts = DAY_MONTH.formatToParts(dayInstant(day));
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')} ${pick('month')}`;
}

/** "Wed 7 Oct" — a hover plate's title. */
export function dayTitle(day: DayKey): string {
  return `${WEEKDAY.format(dayInstant(day))} ${dayLabel(day)}`;
}

/** "11 Oct" — an instant's day and month in the reader's zone (a table's "Last report"). */
export function instantLabel(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone,
  }).formatToParts(at);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${pick('day')} ${pick('month')}`;
}

/**
 * Which days a season axis labels: the first, then one every `step` days, then the last (today) —
 * about five in all, with a label too close to today's dropped so the two never collide. The board
 * labels 1, 4, 7, 10 Oct and Today over fourteen days.
 */
export function axisTicks(count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const last = count - 1;
  const step = Math.max(1, Math.ceil(last / 4.5));
  const ticks: number[] = [];
  for (let i = 0; i <= last - Math.ceil(step / 2); i += step) ticks.push(i);
  ticks.push(last);
  return ticks;
}

/** The pulse's three labels: the first day, the middle one, the last. */
export function pulseTicks(days: readonly DayKey[]): DayKey[] {
  if (days.length === 0) return [];
  const mid = days[Math.floor((days.length - 1) / 2)] as DayKey;
  const out = [days[0] as DayKey, mid, days[days.length - 1] as DayKey];
  return out.filter((d, i) => out.indexOf(d) === i);
}

// ── Ages ─────────────────────────────────────────────────────────────────────────────────────

/** One figure of an age and its unit: `3 d`, `22 h`, `40 min`. */
export type AgePart = { n: number; unit: 'd' | 'h' | 'min' };

/**
 * An age as a stat writes it: days and hours past a day ("3 d 22 h", "3 d" on the hour), hours under
 * a day, minutes under an hour. Floored, never rounded up — an age never reads older than it is —
 * and a negative span (a clock ahead of ours) reads as none.
 */
export function ageParts(ms: number): AgePart[] {
  const minutes = Math.max(0, Math.floor(ms / MINUTE));
  if (minutes < 60) return [{ n: minutes, unit: 'min' }];
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return [{ n: hours, unit: 'h' }];
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0
    ? [{ n: days, unit: 'd' }]
    : [
        { n: days, unit: 'd' },
        { n: rest, unit: 'h' },
      ];
}

/** An age in its largest unit, as a sub-line says it: "2 d", "5 h", "40 min". */
export function shortAge(ms: number): string {
  const [first] = ageParts(ms);
  return `${first?.n ?? 0} ${first?.unit ?? 'min'}`;
}

/**
 * When the oldest open flag turns red: three days unresolved. A flag that old has outlived a weekend
 * and won't move without someone; younger, it is the queue's ordinary worst case.
 */
export const OLDEST_FLAG_BAD_HOURS = 72;

export function oldestFlagTone(ageMs: number): 'bad' | 'default' {
  return ageMs >= OLDEST_FLAG_BAD_HOURS * HOUR ? 'bad' : 'default';
}

// ── Time to resolve ──────────────────────────────────────────────────────────────────────────

/**
 * The board's six buckets over the rollup's eight (`HOUR_BUCKETS`: 0, 6, 12, 24, 48, 72, 168,
 * 336 h). The last three — three days to a week, a week to two, over two — fold into "3 d+": the
 * board's question is "how long do we keep people waiting", and past three days the answer is
 * already "too long".
 */
export const RESOLVE_BUCKETS = ['0–6 h', '6–12', '12–24', '1–2 d', '2–3 d', '3 d+'] as const;

/** Folds an eight-bucket `HOUR_BUCKETS` histogram into the board's six. A short array pads with 0. */
export function foldResolveBuckets(buckets: readonly number[]): number[] {
  const at = (i: number) => buckets[i] ?? 0;
  const tail = buckets.slice(5).reduce((sum, n) => sum + n, 0);
  return [at(0), at(1), at(2), at(3), at(4), tail];
}

/** Adds day histograms bucket by bucket (a season's, or a week's). */
export function sumBuckets(days: ReadonlyArray<readonly number[] | null>): number[] {
  const out = new Array<number>(HOUR_BUCKETS.length).fill(0);
  for (const day of days) {
    if (day === null) continue;
    day.forEach((n, i) => {
      if (i < out.length) out[i] = (out[i] as number) + n;
    });
  }
  return out;
}

/** How a median's bucket reads: "under 6 h", "6–12 h", "1–2 d", "over 14 d". */
const MEDIAN_WORDS = [
  'under 6 h',
  '6–12 h',
  '12–24 h',
  '1–2 d',
  '2–3 d',
  '3–7 d',
  '7–14 d',
  'over 14 d',
] as const;

/**
 * The bucket the median resolution fell in, said as a sub-line ("Median under 6 h"), or `null` when
 * nothing was resolved. The median is the lower median: of an even count, the earlier of the middle
 * two, so the phrase never claims a slower week than the record shows.
 */
export function medianPhrase(buckets: readonly number[]): string | null {
  const total = buckets.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.ceil(total / 2);
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    seen += buckets[i] as number;
    if (seen >= rank) return `Median ${MEDIAN_WORDS[Math.min(i, MEDIAN_WORDS.length - 1)]}`;
  }
  /* v8 ignore next */
  return null;
}

// ── Scales ───────────────────────────────────────────────────────────────────────────────────

/** 1, 2 or 5 × a power of ten: the step at or above `raw`. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

/**
 * A count axis' ticks: about three steps of 1, 2 or 5, ending a step above the tallest value when
 * the tallest would touch the top — the board's 0 · 2 · 4 · 6 over a tallest bar of 5, and 0–3 over
 * a tallest of 2.
 */
export function countTicks(max: number, steps = 3): number[] {
  const top = Math.max(1, Math.ceil(max));
  const step = Math.max(1, niceStep(top / steps)); // counts are whole
  let end = step * Math.ceil(top / step);
  if (end === top) end += step;
  const ticks: number[] = [];
  for (let v = 0; v <= end; v += step) ticks.push(v);
  return ticks;
}

/** An hours axis' ticks: whole days (24 h steps) up to the first at or over the tallest, four or so. */
export function hourTicks(maxHours: number): number[] {
  const days = Math.max(1, Math.ceil(maxHours / 24 / 4));
  const step = days * 24;
  const end = step * Math.max(1, Math.ceil(maxHours / step));
  const ticks: number[] = [];
  for (let v = 0; v <= end; v += step) ticks.push(v);
  return ticks;
}

// ── The tab's data ───────────────────────────────────────────────────────────────────────────

/** The support categories (`SUPPORT_CATEGORIES`), stacked in the board's key order. */
export const SUPPORT_CATEGORIES = ['bug', 'account', 'other', 'safety'] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];

/** One day of the flag queue: the oldest open flag's age then, and the open flags by lane. */
export type FlagQueueDay = {
  /** `flag_oldest_open_age_h`'s scalar. */
  oldestHours: number;
  /** `flag_queue_depth`'s `meta.standard`. */
  standard: number;
  /** `flag_queue_depth`'s `meta.priority` — the safety lane. */
  safety: number;
};

/** The support half of Keeping up. `null` for a viewer who may not read support (PII, D37). */
export type SupportMetrics = {
  /** Tickets open now (`open` and `in_progress`); `null` until a read counts them. */
  open: number | null;
  /** When the oldest of them was filed; `null` with none open. */
  oldestOpenedAt: number | null;
  /** `support_time_to_resolution_h` summed over the season (eight `HOUR_BUCKETS`); `null` unread. */
  resolveSeason: number[] | null;
  /** `support_queue_depth`'s `meta` per season day; `null` before the record began. */
  depthByDay: Array<Partial<Record<SupportCategory, number>> | null>;
};

export type KeepingUpData = {
  /**
   * Flags open now: every one, and the safety lane's. `null` until a read serves the queue as it
   * stands — and then the oldest open flag isn't known either.
   */
  openFlags: { total: number; safety: number } | null;
  /** The oldest open flag — when it was filed and the body it is about — or `null` with none open. */
  oldestOpenFlag: { openedAt: number; where: string | null } | null;
  /** `flag_time_to_resolution_h` summed over the last seven days (eight buckets); `null` unread. */
  resolvedWeek: number[] | null;
  /** `flag_time_to_resolution_h` summed over the season; `null` unread. */
  resolveSeason: number[] | null;
  /** The flag queue per season day; `null` for a day no rollup measured. */
  queueByDay: Array<FlagQueueDay | null>;
  support: SupportMetrics | null;
};

/** A season total with what it is spread over ("In 11 posts", "On 2 bodies", "14 people"). */
export type PulseSeries = {
  /** One count per season day, aligned with `days`; `null` for a day not recorded. */
  daily: Array<number | null>;
  /** The season's total (a sum, or for people a distinct count). */
  total: number;
  /** What the total is spread over, for the strips that say so. */
  over?: number;
};

/** The pulse's strips, in the board's order. A strip whose series is `null` is not recorded at all. */
export const PULSE_KEYS = [
  'reports',
  'comments',
  'kudos',
  'photos',
  'hazards',
  'accounts',
  'signedIn',
  'contributors',
] as const;
export type PulseKey = (typeof PULSE_KEYS)[number];

export const PULSE_LABELS: Record<PulseKey, string> = {
  reports: 'Reports',
  comments: 'Comments',
  kudos: 'Kudos',
  photos: 'Photos',
  hazards: 'Hazards',
  accounts: 'New accounts',
  signedIn: 'Signed in',
  contributors: 'Contributors',
};

const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A strip's sub-line under its total: what the total is spread over, or what it counts. */
export function pulseSub(key: PulseKey, series: PulseSeries): string {
  const over = series.over ?? 0;
  switch (key) {
    case 'reports':
      return `In ${plural(over, 'post', 'posts')}`;
    case 'comments':
    case 'photos':
      return `On ${plural(over, 'report', 'reports')}`;
    case 'kudos':
      return plural(over, 'person', 'people');
    case 'hazards':
      return `On ${plural(over, 'body', 'bodies')}`;
    case 'accounts':
      return 'This season';
    case 'signedIn':
    case 'contributors':
      return series.total === 1 ? 'Person' : 'People';
  }
}

/** Vantage counts for the season: the three a report states, and the reports that state none. */
export type VantageCounts = Record<ObservedFrom, number> & {
  /** Reports from before vantage was asked (A10), which state none. Drawn only when there are some. */
  unstated: number;
};

export const VANTAGE_LABELS: Record<ObservedFrom | 'unstated', string> = {
  on_ice: 'On the ice',
  shore: 'From shore',
  secondhand: 'Secondhand',
  unstated: 'Not stated',
};

/** The vantage segments to draw, in order, with zero-count kinds kept (the key still says 0). */
export function vantageSegments(
  counts: VantageCounts,
): Array<{ key: ObservedFrom | 'unstated'; count: number }> {
  const stated = OBSERVED_FROM.map((key) => ({ key, count: counts[key] }));
  return counts.unstated > 0 ? [...stated, { key: 'unstated', count: counts.unstated }] : stated;
}

export type MostReportedRow = {
  bodyId: string;
  name: string;
  reports: number;
  photos: number;
  /** Distinct authors. */
  people: number;
  lastReportAt: number;
};

export type ShowingUpData = {
  /** The top stats: the last seven days. A `null` stat isn't recorded yet. */
  week: {
    reports: { count: number; people: number } | null;
    accounts: { added: number; total: number } | null;
    signedIn: { people: number; twoDaysOrMore: number } | null;
    contributors: { people: number; firstTime: number } | null;
  };
  pulse: Record<PulseKey, PulseSeries | null>;
  /** `null` until a read rolls the season's vantage up. */
  vantage: VantageCounts | null;
  /** `null` until a read ranks the season's bodies. */
  mostReported: MostReportedRow[] | null;
};

/** One state's row. A `null` count is a column no write path records yet. */
export type StateCoverageRow = {
  /** A two-letter code (`VT`), as `waterBodies.states` stores it. */
  state: string;
  bodies: number;
  reports: number | null;
  comments: number | null;
  photos: number | null;
  kudos: number | null;
  contributors: number | null;
};

export type CoverageData = {
  /**
   * Listed bodies across the region, each counted once (a border body is in two states' rows);
   * `null` until a read serves coverage, with no state rows.
   */
  listedBodies: number | null;
  states: StateCoverageRow[];
};

/** Reports per 1,000 listed bodies, as the board writes it ("1.47", or "0" for none). */
export function perThousand(reports: number, bodies: number): string {
  if (reports === 0 || bodies === 0) return '0';
  return ((reports / bodies) * 1000).toFixed(2);
}

/**
 * Each state's swatch, by the state, never by its rank: a state keeps its gray when another state
 * outgrows it. The brightest goes to the state the corpus began in.
 */
export const STATE_INK: Record<string, string> = {
  VT: 'var(--fg)',
  NH: 'var(--fg2)',
  ME: 'var(--fg3)',
  NY: 'var(--line2)',
  MA: 'var(--line)',
};

export const stateInk = (code: string): string => STATE_INK[code] ?? 'var(--line)';

// ── Nothing read yet ─────────────────────────────────────────────────────────────────────────

/** The words every unread figure says, beside a dash. */
export const NOT_RECORDED = 'Not recorded yet';

/**
 * The tab before any of its reads exist: every figure `null`, every series a run of `null` days,
 * no rows. Drawn, each section says *Not recorded yet* where its marks would be — never a zero,
 * which is a measured zero. The page mounts this until the reads land, then swaps a part at a time.
 *
 * `support` is whether the viewer may read support at all (PII, D37): without it the support half
 * is left out, as it is with real data.
 */
export function metricsNotRecorded(
  days: readonly DayKey[],
  { support }: { support: boolean },
): { keepingUp: KeepingUpData; showingUp: ShowingUpData; coverage: CoverageData } {
  const unread = <T>(): Array<T | null> => days.map(() => null);
  return {
    keepingUp: {
      openFlags: null,
      oldestOpenFlag: null,
      resolvedWeek: null,
      resolveSeason: null,
      queueByDay: unread<FlagQueueDay>(),
      support: support
        ? { open: null, oldestOpenedAt: null, resolveSeason: null, depthByDay: unread() }
        : null,
    },
    showingUp: {
      week: { reports: null, accounts: null, signedIn: null, contributors: null },
      pulse: Object.fromEntries(PULSE_KEYS.map((key) => [key, null])) as Record<
        PulseKey,
        PulseSeries | null
      >,
      vantage: null,
      mostReported: null,
    },
    coverage: { listedBodies: null, states: [] },
  };
}
