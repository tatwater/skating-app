/**
 * The in-house analytics vocabulary (Phase 7b / D37) — **one file**, the same way `reputationConfig.ts`
 * single-sources the tuning constants.
 *
 * Every number the operator surface charts is stored as a **`metricSnapshots` row**, never computed by
 * scanning the live corpus at read time. That's the `listInViewport` lesson (PRs #10/#11) generalized:
 * a read path whose cost scales with the corpus is a read-cap crash waiting for the corpus to grow. So
 * the charts read pre-aggregated rows, and there are exactly two ways a row gets written:
 *
 *   - **`counter`** — *maintain-on-write.* The event leaves no queryable trace behind (a
 *     weather-explained contradiction is a `continue`; a truncated viewport is a `console.warn`), so
 *     the event site bumps today's row as it happens. Forward-only by construction — these series
 *     start the day they ship and fill going forward.
 *   - **`rollup`** — *sweep-by-cron.* The data IS in the tables, so a once-a-day job computes a bounded
 *     aggregate. Backfillable, because the source rows are still there.
 *
 * This module holds the vocabulary + the pure bucketing math; the Convex layer owns the writes
 * (`lib/metrics.ts`), the cron owns the rollups (`analyticsRollup.ts`), and the web control-room owns
 * the pairing of each constant with the chart that tunes it.
 *
 * **Days are UTC.** A metric day is a `YYYY-MM-DD` UTC string — lexicographically sortable, so a date
 * range is an index range. Northeast-US local days would smear an hour or two of activity into the
 * neighbouring bucket; at the granularity these charts are read (weeks of trend), that's noise, and a
 * timezone-aware day key would make the cron's idempotency depend on when it ran.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Day keys
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** The UTC `YYYY-MM-DD` day an epoch-ms timestamp falls in — a `metricSnapshots.date`. */
export function metricDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Start-of-day (UTC, epoch ms) for a `YYYY-MM-DD` key — the inverse of `metricDay`. */
export function metricDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/**
 * The `count` most recent day keys ending at `endMs`'s day, oldest first — the x-axis of every time
 * series. Generated rather than read from the table so a day with no activity renders as a real zero
 * instead of silently collapsing the axis.
 */
export function metricDayRange(endMs: number, count: number): string[] {
  const days: string[] = [];
  for (let i = count - 1; i >= 0; i--) days.push(metricDay(endMs - i * DAY_MS));
  return days;
}

// ─────────────────────────────────────────────────────────────────────────────
// Histograms
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Index of the bucket `value` falls in, given ascending **lower edges**. Edge `i` owns
 * `[edges[i], edges[i+1])`, and the last edge is an open-ended overflow bucket. A value below the
 * first edge lands in bucket 0 (the edges always start at the domain minimum), so nothing is dropped —
 * a histogram that silently discards its tails is worse than no histogram.
 */
export function bucketIndex(value: number, edges: readonly number[]): number {
  let i = 0;
  while (i + 1 < edges.length && value >= (edges[i + 1] as number)) i++;
  return i;
}

/** Bucket counts for `values` against ascending lower `edges` — `histogram(...).length === edges.length`. */
export function histogram(values: readonly number[], edges: readonly number[]): number[] {
  const counts = new Array<number>(edges.length).fill(0);
  for (const value of values) {
    const i = bucketIndex(value, edges);
    counts[i] = (counts[i] as number) + 1;
  }
  return counts;
}

/** Axis labels for a bucket-edge array — `"15–59"`, with the last rendered open-ended (`"250+"`). */
export function bucketLabels(edges: readonly number[]): string[] {
  return edges.map((lo, i) => {
    const next = edges[i + 1];
    if (next === undefined) return `${lo}+`;
    return next - lo === 1 ? `${lo}` : `${lo}–${next - 1}`;
  });
}

/**
 * Reputation-point histogram edges (D50). Deliberately **straddling the three
 * `TRUST_CLASS_THRESHOLDS` (15 / 60 / 150)** rather than being evenly spaced: the question this chart
 * answers is "do the class cutoffs bunch or spread people?", which you can only see if a cutoff is a
 * bucket boundary. Even spacing would hide a pile-up sitting just under `trusted`.
 */
export const REPUTATION_POINT_BUCKETS = [0, 5, 15, 30, 60, 100, 150, 250] as const;

/** Contradiction-count histogram edges — hinged on `CONTRADICTION_FLAG_THRESHOLD` (3). */
export const CONTRADICTION_COUNT_BUCKETS = [0, 1, 2, 3, 5, 10] as const;

/**
 * Hour-scale histogram edges, used for both **time-to-bounty-fulfillment** and **hazard age at
 * confirmation**. Log-ish, because both distributions are heavily front-loaded (most bounties that get
 * fulfilled are fulfilled fast) and a linear axis would put everything in bucket 0.
 */
export const HOUR_BUCKETS = [0, 6, 12, 24, 48, 72, 168, 336] as const;

// ─────────────────────────────────────────────────────────────────────────────
// The metric vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How a metric's payload is shaped, so the chart layer knows what to render without special-casing
 * each key: a `scalar` is one number per day, `buckets` is a histogram, and `meta` is a small labelled
 * record (a funnel, a composition breakdown, a per-type table).
 */
export type MetricShape = 'scalar' | 'buckets' | 'meta';

export interface MetricSpec {
  /** Human label for the chart title / stat tile. */
  label: string;
  /** What the number means and what it tells you — rendered under the chart in the control-room. */
  description: string;
  /** `counter` = bumped at the event site (forward-only); `rollup` = computed by the daily cron. */
  kind: 'counter' | 'rollup';
  shape: MetricShape;
  /** Bucket edges, for `shape: 'buckets'` metrics. */
  edges?: readonly number[];
}

/**
 * Every metric key the app writes. Adding a key here is the *only* way a new number enters the
 * operator surface, so the control-room can enumerate what exists rather than hard-coding a list that
 * drifts from what the cron actually writes.
 */
export const METRICS = {
  // ── App health (tunes the operator, not a constant) ────────────────────────
  reports_created: {
    label: 'Reports',
    description: 'Visible reports whose skate ended this day — the app’s core activity signal.',
    kind: 'rollup',
    shape: 'scalar',
  },
  signups: {
    label: 'New accounts',
    description: 'Profiles created this day.',
    kind: 'rollup',
    shape: 'scalar',
  },
  active_contributors: {
    label: 'Active contributors',
    description:
      'Distinct authors who posted a report or hazard in the trailing 7 days — the number that decides whether every other rate here is signal or noise.',
    kind: 'rollup',
    shape: 'scalar',
  },
  hazards_created: {
    label: 'Hazards',
    description: 'Hazards created this day.',
    kind: 'rollup',
    shape: 'scalar',
  },

  // ── Bounties (FRESH_REPORT_HOURS, BOUNTY_REOPEN_*, MAX_OPEN_BOUNTIES_PER_DAY, lifetime, reward) ──
  bounty_outcomes: {
    label: 'Bounty outcomes',
    description:
      'The lifetime outcome funnel: open / fulfilled / expired / cancelled. A high expired-without-fulfillment share means the lifetime or the reward is wrong — people are asking and nobody is answering.',
    kind: 'rollup',
    shape: 'meta',
  },
  bounty_time_to_fulfillment_h: {
    label: 'Time to fulfillment',
    description:
      'Hours from bounty create to the fulfilling report, for bounties fulfilled in the trailing 30 days. Tunes DEFAULT_BOUNTY_LIFETIME_MS — a lifetime far beyond the tail is just clutter.',
    kind: 'rollup',
    shape: 'buckets',
    edges: HOUR_BUCKETS,
  },
  bounty_gate_decisions: {
    label: 'Gate decisions',
    description:
      'Every bounty-create attempt by verdict: allowed / suppressed by fresh eyes / capped by the daily limit. Mostly-suppressed means FRESH_REPORT_HOURS is too long; mostly-capped means MAX_OPEN_BOUNTIES_PER_DAY is too tight.',
    kind: 'rollup',
    shape: 'meta',
  },
  bounty_weather_reopen_rate: {
    label: 'Weather-reopen rate',
    description:
      'Share of attempts where a freeze/thaw since the suppressing report flipped a would-be block into an allow. Flat zero through a real thaw means BOUNTY_REOPEN_FREEZING/THAW_DEGREE_HOURS are set too high to ever fire.',
    kind: 'rollup',
    shape: 'scalar',
  },
  bounty_cap_hit_rate: {
    label: 'Daily-cap hit rate',
    description:
      'Share of attempts rejected by the rolling per-requester cap. The empirical case for (or against) the deferred per-user activeBountyPostLimit lever — if a handful of requesters account for all of it, the cap is doing its job and the lever is unnecessary.',
    kind: 'rollup',
    shape: 'scalar',
  },

  // ── Trust & points (TRUST_CLASS_THRESHOLDS, POINT_WEIGHTS) ─────────────────
  reputation_points_hist: {
    label: 'Reputation distribution',
    description:
      'Reputation points across active accounts, bucketed across the 15 / 60 / 150 class cutoffs. The single best view of whether the thresholds bunch or spread people.',
    kind: 'rollup',
    shape: 'buckets',
    edges: REPUTATION_POINT_BUCKETS,
  },
  point_source_composition: {
    label: 'Point sources',
    description:
      'Share of awarded points by reason over the trailing 30 days. Tunes POINT_WEIGHTS: if report_submitted dominates, volume is masquerading as trust.',
    kind: 'rollup',
    shape: 'meta',
  },

  // ── Enforcement (CONTRADICTION_FLAG_THRESHOLD, the weather gate, AUTO_LOW_QUALITY_*) ──
  contradiction_detected: {
    label: 'Contradictions detected',
    description:
      'Disagreeing report pairs found before the weather gate runs — the top of the enforcement funnel.',
    kind: 'counter',
    shape: 'scalar',
  },
  contradiction_weather_explained: {
    label: 'Explained by weather',
    description:
      'Disagreements the weather gate dismissed as an honest "the ice changed". If this explains away almost everything, the 48 FDH / 36 TDH gate is too permissive to catch anyone.',
    kind: 'counter',
    shape: 'scalar',
  },
  contradiction_escalated: {
    label: 'Escalated',
    description:
      'Weather-unexplained disagreements where the un-corroborated minority accrued a contradiction — the only stage that touches a contributor.',
    kind: 'counter',
    shape: 'scalar',
  },
  contradiction_count_hist: {
    label: 'Contradictions per contributor',
    description:
      'Distribution of the private contradictionCount across accounts, hinged on the flag threshold of 3. A long tail past 3 means the threshold is filing more flags than a human can judge.',
    kind: 'rollup',
    shape: 'buckets',
    edges: CONTRADICTION_COUNT_BUCKETS,
  },
  flag_dispositions: {
    label: 'Flag dispositions',
    description:
      'How flags resolved this day, by reason and by upheld-vs-dismissed. Mostly-dismissed auto_low_quality means AUTO_LOW_QUALITY_NET_UNHELPFUL is too low; mostly-dismissed unsafe_false_report means CONTRADICTION_FLAG_THRESHOLD is.',
    kind: 'counter',
    shape: 'meta',
  },

  // ── Hazards (HAZARD_DECAY tiers, HAZARD_CORROBORATION_MIN_CONFIRMS) ────────
  hazard_confirm_outcomes: {
    label: 'Confirmation outcomes',
    description:
      'Per hazard type: still-here / healing-but-unsafe / fully-healed verdicts this day. A type that keeps getting "still here" past its stale line is decaying too fast — the empirical check on the whole D52 research table.',
    kind: 'rollup',
    shape: 'meta',
  },
  hazard_age_at_confirm_h: {
    label: 'Age at confirmation',
    description:
      'Hours between a hazard’s first report and a confirmation, against the per-type fresh/aging cutoffs. Confirmations clustering past agingH mean the tier is short.',
    kind: 'rollup',
    shape: 'buckets',
    edges: HOUR_BUCKETS,
  },

  // ── Display / map (the minVisibleZoom curve, MAX_VIEWPORT_LIMIT) ───────────
  viewport_truncated: {
    label: 'Viewport truncations',
    description:
      'Map reads that hit the result clamp and dropped bodies (D5). Non-zero means the 256 cap or the displayScore curve is hiding water at some zoom.',
    kind: 'counter',
    shape: 'scalar',
  },

  // ── Operational health (tunes the operator) ────────────────────────────────
  flag_queue_depth: {
    label: 'Open flags',
    description:
      'Flags still open or under review at rollup time, split by the safety priority lane.',
    kind: 'rollup',
    shape: 'meta',
  },
  flag_oldest_open_age_h: {
    label: 'Oldest open flag',
    description:
      'Age in hours of the oldest unresolved flag — the queue’s worst case, not its average.',
    kind: 'rollup',
    shape: 'scalar',
  },
  flag_time_to_resolution_h: {
    label: 'Flag resolution time',
    description: 'Hours from flag to resolution, for flags resolved this day.',
    kind: 'rollup',
    shape: 'buckets',
    edges: HOUR_BUCKETS,
  },
  support_volume: {
    label: 'Support tickets',
    description: 'Tickets opened this day by category — the highest-signal channel in alpha.',
    kind: 'rollup',
    shape: 'meta',
  },
  support_time_to_resolution_h: {
    label: 'Support resolution time',
    description: 'Hours from ticket to resolution, for tickets resolved this day.',
    kind: 'rollup',
    shape: 'buckets',
    edges: HOUR_BUCKETS,
  },

  // ── Additional tracked stats (numbers first, charts if they earn them) ─────
  photo_orphans: {
    label: 'Orphaned photos',
    description:
      'Photos referenced by no report or hazard. Feeds the deferred GC-cron decision — build it when this number starts growing, not before.',
    kind: 'rollup',
    shape: 'scalar',
  },
  weather_strip_renders: {
    label: 'Weather-strip renders',
    description:
      'Weather-since strip resolutions, split fresh vs aged. Tunes the strip’s minAgeHours=6 / maxAgeDays=14 window — an all-aged split means the window outlives the data people actually look at.',
    kind: 'counter',
    shape: 'meta',
  },
  report_rejected_future_skate: {
    label: 'Future-skate rejections',
    description:
      'Reports rejected for a skate time beyond SKATE_TIME_FUTURE_TOLERANCE_MS. Persistent non-zero means real clock skew is costing people reports, not that people are lying.',
    kind: 'counter',
    shape: 'scalar',
  },
  state_coverage: {
    label: 'Coverage by state',
    description:
      'Listed water bodies and trailing-30-day reports per state — which of the Phase-2.5 regions actually took, and where expansion should go next.',
    kind: 'rollup',
    shape: 'meta',
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricKey = keyof typeof METRICS;

/** Every metric key — the cron's checklist and the control-room's index. */
export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

/** The keys written at the event site (forward-only); the rest are computed by the daily cron. */
export const COUNTER_METRIC_KEYS = METRIC_KEYS.filter((k) => METRICS[k].kind === 'counter');

// ─────────────────────────────────────────────────────────────────────────────
// Rollup helpers (pure — the cron does DB reads, this does the arithmetic)
// ─────────────────────────────────────────────────────────────────────────────

/** Tally occurrences of each key in `values` into a plain record — the `meta` shape's workhorse. */
export function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

/**
 * A share of a total, `0` when the total is zero. Rates are stored as fractions (not percents) so a
 * chart can format them; and a zero denominator is a real "no attempts", never `NaN` on an axis.
 */
export function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/** Hours between two epoch-ms timestamps, floored at 0 (clock skew must not produce a negative age). */
export function hoursBetween(from: number, to: number): number {
  return Math.max(0, (to - from) / (60 * 60 * 1000));
}
