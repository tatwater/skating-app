import type { InboxMemberStatus } from '@skating/core';

/**
 * The ask a decision is written on, for a request and a place ask alike: the oldest open one, as
 * served (the read lists oldest first), else the first — the server closes its siblings with it.
 */
export function decidedAsk<T extends { status: InboxMemberStatus }>(asks: readonly T[]): T | null {
  return asks.find((a) => a.status === 'open') ?? asks[0] ?? null;
}
