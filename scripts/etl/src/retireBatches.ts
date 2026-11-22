/**
 * **The retire pass's batching** (A07a-3; B01-5d R10-C): the absorbed pairs sent to
 * `waterBodies:retireAbsorbedBodies` a batch at a time, the one-row-once keys and the survivors' lists
 * carried across batches, and — since the mutation keeps each batch inside one transaction — the
 * pairs a call had no room for (`deferred`) sent again in a later call.
 *
 * **Bounded.** The mutation always merges a call's first fitting pair, so a call that hands back
 * every pair it was given made no progress on its head: that pair is reported skipped ("never fits
 * one transaction here") rather than retried for ever, and the rest are sent again. Split out of `retireAbsorbed.ts` (the CLI shell)
 * because this is a decision, and decisions are tested (the ETL's coverage rule).
 */

export interface PairRef {
  survivor: { source: string; externalId: string };
  absorbed: { source: string; externalId: string };
}

export type TakenLists = {
  key: string;
  pins: string[];
  aliases: string[];
  links: { label: string; url: string }[];
}[];

/** What one call of `waterBodies:retireAbsorbedBodies` answers. */
export interface RetireResult {
  applied: boolean;
  scanned: number;
  retired: number;
  samples: { absorbed: string; into: string; name: string }[];
  retiredKeys: string[];
  taken: TakenLists;
  skipped: Record<string, number>;
  skippedSamples: { pair: string; why: string }[];
  /** Pairs the call had no room left for, as given (absent from a server before R10-C). */
  deferred?: PairRef[];
}

/** The arguments one call sends. */
export interface RetireArgs {
  pairs: PairRef[];
  campaignId?: string;
  apply?: true;
  alreadyRetired?: string[];
  taken?: TakenLists;
}

/** The skip a pair gets when a call defers every pair it was given. */
export const NEVER_FITS = 'never fits one transaction here, so a person merges it';

/** What the whole pass did: its totals, every skip by reason, and the named samples. */
export interface RetireTotals {
  scanned: number;
  retired: number;
  calls: number;
  skipped: Record<string, number>;
  samples: { absorbed: string; into: string; name: string }[];
  skippedSamples: { pair: string; why: string }[];
}

const SAMPLES = 25;

const labelOf = (p: PairRef) =>
  `${p.absorbed.source}:${p.absorbed.externalId} → ${p.survivor.source}:${p.survivor.externalId}`;

/**
 * Run the pass over `pairs`, `batch` at a time through `call`, re-sending what each call defers until
 * nothing is left. `onBatch` hears the running totals after each call (the CLI's progress log).
 */
export function retireInBatches(
  pairs: readonly PairRef[],
  opts: { batch: number; apply: boolean; campaignId?: string },
  call: (args: RetireArgs) => RetireResult,
  onBatch?: (totals: RetireTotals) => void,
): RetireTotals {
  const totals: RetireTotals = {
    scanned: 0,
    retired: 0,
    calls: 0,
    skipped: {},
    samples: [],
    skippedSamples: [],
  };
  const skip = (why: string, n: number) => {
    totals.skipped[why] = (totals.skipped[why] ?? 0) + n;
  };
  // Carried across calls: the resolved keys already retired, and each survivor's lists by now.
  const retiredKeys: string[] = [];
  let taken: TakenLists = [];
  let queue: PairRef[] = [...pairs];
  while (queue.length > 0) {
    const slice = queue.slice(0, opts.batch);
    queue = queue.slice(opts.batch);
    const result = call({
      pairs: slice,
      ...(opts.campaignId ? { campaignId: opts.campaignId } : {}),
      ...(opts.apply ? { apply: true } : {}),
      ...(retiredKeys.length > 0 ? { alreadyRetired: [...retiredKeys] } : {}),
      ...(taken.length > 0 ? { taken } : {}),
    });
    totals.calls++;
    retiredKeys.push(...result.retiredKeys);
    taken = result.taken ?? [];
    totals.retired += result.retired;
    for (const [why, n] of Object.entries(result.skipped)) skip(why, n);
    for (const s of result.samples) if (totals.samples.length < SAMPLES) totals.samples.push(s);
    for (const s of result.skippedSamples) {
      if (totals.skippedSamples.length < SAMPLES) totals.skippedSamples.push(s);
    }
    const deferred = result.deferred ?? [];
    // What this call actually looked at: the pairs it was given, less those it handed back.
    totals.scanned += slice.length - deferred.length;
    if (deferred.length > 0 && deferred.length >= slice.length) {
      // No progress: even as the call's first pair, the head could not be merged. It is reported by
      // name and never sent again; the rest go back, so each such call drops one pair — bounded.
      const [stuck, ...rest] = deferred as [PairRef, ...PairRef[]];
      totals.scanned += 1;
      skip(NEVER_FITS, 1);
      if (totals.skippedSamples.length < SAMPLES) {
        totals.skippedSamples.push({ pair: labelOf(stuck), why: NEVER_FITS });
      }
      queue = [...rest, ...queue];
    } else if (deferred.length > 0) {
      // Sent again first, ahead of what this call never reached.
      queue = [...deferred, ...queue];
    }
    onBatch?.(totals);
  }
  return totals;
}
