/**
 * The pure arithmetic behind the console Overview's counts (B01 §5.1): no reads, so each rule is tested on
 * its own and the queries stay a list of bounded reads.
 */

/** A count the server read through an index and capped: `capped` says the true number is larger. */
export interface Count {
  count: number;
  capped: boolean;
}

/** Past this, a count reads "200+" — enough to say "a lot" without reading the lot. */
export const COUNT_CAP = 200;

/** `rows` read with `take(COUNT_CAP + 1)`, as a count. */
export function cappedCount(rows: number, cap = COUNT_CAP): Count {
  return { count: Math.min(rows, cap), capped: rows > cap };
}

/**
 * When the median open item was opened — the instant the Inbox card's foot ages against the reader's
 * own clock ("median age 1.5 d"), so the age keeps growing between reads instead of freezing at the
 * server's. The lower median of the ages: of an even count, the younger of the middle two (the later
 * opened), so the foot never reads older than the queue is. `null` with nothing open.
 */
export function medianOpenedAt(openedAts: readonly number[]): number | null {
  if (openedAts.length === 0) return null;
  const newestFirst = [...openedAts].sort((a, b) => b - a);
  return newestFirst[Math.floor((newestFirst.length - 1) / 2)] as number;
}

/** The median age `now` reads from {@link medianOpenedAt}: never negative, a clock behind reads as none. */
export function medianAge(openedAts: readonly number[], now: number): number | null {
  const at = medianOpenedAt(openedAts);
  return at === null ? null : Math.max(0, now - at);
}

/**
 * Day histograms added bucket by bucket over the days that were recorded; `null` when none was —
 * nothing measured is not a measured nothing. A short day pads with zeros to the widest.
 */
export function sumRecorded(
  days: ReadonlyArray<readonly number[] | null | undefined>,
): number[] | null {
  let out: number[] | null = null;
  for (const day of days) {
    if (day == null) continue;
    const sum: number[] = out ?? [];
    day.forEach((n, i) => {
      sum[i] = (sum[i] ?? 0) + n;
    });
    for (let i = 0; i < sum.length; i++) sum[i] ??= 0;
    out = sum;
  }
  return out;
}
