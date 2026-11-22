import type { AccessRuling, TimelineEvent } from '../handlers/Access/accessModel';

/**
 * **A standing ruling as one timeline event** — the one mapper from the server's `RulingView` to the
 * event the timeline draws (`TimelineEventBody`): the Access item's ruling (2.2) and the ruling a
 * contest-access ask contests (2.3's kind) read the same, said once.
 */
export function rulingEvent(r: AccessRuling): Extract<TimelineEvent, { kind: 'ruling' }> {
  return {
    kind: 'ruling',
    key: 'ruling',
    at: r.ruledAt,
    verdict: r.verdict,
    by: r.by,
    note: r.note,
    reason: r.reason?.trim() || null,
  };
}
