/**
 * The drop ledger — **the thing that makes a silent failure impossible** (N7).
 *
 * ## Why this exists, stated as the incident it came from
 *
 * `normalizeNhdId` was written from a single observed example: Beau Lake's `Permanent_Identifier`,
 * read off the ArcGIS service as a brace-wrapped GUID. It refused everything that was not a GUID.
 *
 * Then the archive was censused: **84.4% of NHD's post-floor water bodies carry a plain numeric
 * identifier**, not a GUID. The strict rule would have refused five sixths of the corpus's join keys
 * — and refused them *silently*, because a body whose id fails to normalize simply never gets an
 * `nhdId`. No error, no warning, no count. The reconciliation would have reported a low match rate
 * and everyone would have gone looking at the geometry.
 *
 * That was one of four identifier spellings found in a single session, and **every one of them failed
 * the same way**: an empty join, a missing id, an empty clip. Never an exception.
 *
 * ## The two rules this encodes
 *
 * **1. A rejection must be counted and named.** Not "returned undefined" — tallied under a reason,
 * with a bounded sample of the raw values, so the run row says *"1,032 rejected: sentinel"* rather
 * than nothing at all.
 *
 * **2. A pass that drops more than it expects must FAIL, not warn.** `expectAcceptance` is the
 * mechanism. A warning in a 20-minute ETL log is indistinguishable from silence; an exception is not.
 * The floor is a claim about the data ("we believe ~98% of these ids are well-formed"), so when it
 * trips, either the data changed or the belief was wrong — and both are things to stop for.
 *
 * ## Why reasons rather than a boolean
 *
 * "Absent", "sentinel" and "malformed" are three different facts and only one of them is a problem.
 * NHD writes `gnis_id = -1` on 1,032 post-floor rows to mean *"this feature has no GNIS entry"* —
 * they are cross-border Québec lakes like `Lac des Ours` and `Étang Payeur`. Collapsing that into
 * "malformed" would put a healthy 2% in the same bucket as a broken parser; treating it as an **id**
 * would merge 855 unrelated lakes into one body. The reason is the difference between those outcomes.
 */

/** Why a value did not survive normalization. Extend deliberately; each one is a distinct fact. */
export type RejectionReason =
  /** Nothing there — null, undefined, empty after trimming. Usually normal and usually fine. */
  | 'absent'
  /** A documented "no value" marker the publisher writes in the value's own slot (NHD's `-1`). */
  | 'sentinel'
  /** Present, non-sentinel, and did not match any accepted shape. The one worth investigating. */
  | 'malformed';

/** A normalization outcome that can say **why** it failed, which `undefined` cannot. */
export type Normalized =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: RejectionReason };

export const accepted = (value: string): Normalized => ({ ok: true, value });
export const rejected = (reason: RejectionReason): Normalized => ({ ok: false, reason });

/** How many raw values to keep per reason. Enough to diagnose, bounded so a run row stays small. */
export const LEDGER_SAMPLE_CAP = 5;

export interface LedgerReport {
  label: string;
  seen: number;
  accepted: number;
  rejected: number;
  /** Counts per reason — the shape a run row's `counts` wants. */
  byReason: Record<RejectionReason, number>;
  /** Up to `LEDGER_SAMPLE_CAP` raw values per reason, so a failure is diagnosable from the row. */
  samples: Partial<Record<RejectionReason, string[]>>;
  /** `accepted / seen`, or 1 for an empty input (nothing was dropped). */
  acceptanceRate: number;
}

/**
 * Tally normalization outcomes so a pass can report what it refused.
 *
 * Deliberately dumb: it counts and samples, and does not decide anything. The decision is
 * `expectAcceptance`, kept separate so a pass can log a ledger without asserting on it (an
 * exploratory census) or assert without logging (a unit test).
 */
export class DropLedger {
  private seen = 0;
  private ok = 0;
  private readonly counts: Record<RejectionReason, number> = {
    absent: 0,
    sentinel: 0,
    malformed: 0,
  };
  private readonly samples: Partial<Record<RejectionReason, string[]>> = {};

  constructor(private readonly label: string) {}

  /** Record one outcome. `raw` is kept only for a bounded sample, and only on rejection. */
  record(outcome: Normalized, raw?: unknown): Normalized {
    this.seen += 1;
    if (outcome.ok) {
      this.ok += 1;
      return outcome;
    }
    this.counts[outcome.reason] += 1;
    // Two statements rather than an assignment inside the expression: `??=` in a `const` initialiser
    // reads as a lookup and is a write, which is the one place a reader's eye skips over a mutation.
    const bucket = this.samples[outcome.reason] ?? [];
    this.samples[outcome.reason] = bucket;
    if (bucket.length < LEDGER_SAMPLE_CAP) bucket.push(String(raw ?? ''));
    return outcome;
  }

  /** Run a normalizer over a value and record the result in one step. */
  normalize(raw: unknown, fn: (raw: unknown) => Normalized): Normalized {
    return this.record(fn(raw), raw);
  }

  report(): LedgerReport {
    const rejectedTotal = this.seen - this.ok;
    return {
      label: this.label,
      seen: this.seen,
      accepted: this.ok,
      rejected: rejectedTotal,
      byReason: { ...this.counts },
      samples: JSON.parse(JSON.stringify(this.samples)),
      // An empty input dropped nothing. Reporting 0 would make "we read no rows" trip every floor,
      // which trains people to ignore the floor — the failure mode this whole module exists to avoid.
      acceptanceRate: this.seen === 0 ? 1 : this.ok / this.seen,
    };
  }

  /** The report flattened into `{ name, value }` counts, for a run row. */
  counts_(): { name: string; value: number }[] {
    const r = this.report();
    return [
      { name: `${r.label}.seen`, value: r.seen },
      { name: `${r.label}.accepted`, value: r.accepted },
      ...(Object.entries(r.byReason) as [RejectionReason, number][])
        .filter(([, v]) => v > 0)
        .map(([reason, value]) => ({ name: `${r.label}.rejected.${reason}`, value })),
    ];
  }
}

/**
 * Fail the pass if too much was dropped.
 *
 * **Throws rather than warns, on purpose.** A warning inside a twenty-minute ETL log has the same
 * practical effect as silence, and silence is the failure this module exists to remove. The message
 * carries the per-reason breakdown and the sampled raw values, so the exception is the diagnosis
 * rather than the start of one.
 *
 * `minRate` is a **claim about the data**, so pick it from a census and write the census down beside
 * it. When it trips, either the source changed shape or the claim was wrong; both are worth stopping
 * for, and neither is worth discovering three passes downstream.
 *
 * **The floor measures `accepted / (accepted + malformed)`, and only `malformed` indicts the rule.**
 * The other two reasons are properties of the *data*: 71.7% of NHD's post-floor rows have no GNIS id
 * at all, and a further 1,032 carry the publisher's `-1` meaning "no GNIS entry". Counting either
 * against the parser makes a healthy archive look broken.
 *
 * **This distinction was found by the mechanism catching itself.** The first version excluded only
 * `absent`, and the very first real run failed at 93.1% — entirely because 1,032 correctly-identified
 * sentinels were being scored as parse failures. A floor that cries wolf gets ignored, which is the
 * failure this module exists to prevent, so the semantics were fixed rather than the number lowered.
 *
 * `countAbsent` / `countSentinel` re-admit them for a field where their presence genuinely is a
 * failure — an id column that must never be empty, say.
 */
export function expectAcceptance(
  report: LedgerReport,
  minRate: number,
  options: { countAbsent?: boolean; countSentinel?: boolean } = {},
): void {
  const excluded =
    (options.countAbsent ? 0 : report.byReason.absent) +
    (options.countSentinel ? 0 : report.byReason.sentinel);
  const denominator = report.seen - excluded;
  if (denominator === 0) return;
  const rate = report.accepted / denominator;
  if (rate >= minRate) return;

  const breakdown = (Object.entries(report.byReason) as [RejectionReason, number][])
    .filter(([, v]) => v > 0)
    .map(([reason, v]) => {
      const eg = report.samples[reason]?.slice(0, 3).map((s) => JSON.stringify(s)) ?? [];
      return `${reason}=${v}${eg.length ? ` (e.g. ${eg.join(', ')})` : ''}`;
    })
    .join('; ');

  throw new Error(
    `${report.label}: accepted ${report.accepted} of ${denominator} (${(rate * 100).toFixed(1)}%), ` +
      `below the ${(minRate * 100).toFixed(1)}% floor. ${breakdown}. ` +
      'Either the source changed shape or the rule was derived from too few examples — ' +
      'census the archive before widening the rule.',
  );
}

/** One-line summary for a log. */
export function formatLedger(report: LedgerReport): string {
  const parts = (Object.entries(report.byReason) as [RejectionReason, number][])
    .filter(([, v]) => v > 0)
    .map(([reason, v]) => `${v} ${reason}`);
  return `${report.label}: ${report.accepted.toLocaleString()}/${report.seen.toLocaleString()} accepted${
    parts.length ? ` · rejected ${parts.join(', ')}` : ''
  }`;
}
