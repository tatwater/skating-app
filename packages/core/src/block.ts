/**
 * Block helpers (D32). A block is one bidirectional `blocks` row — "hide this person from me and me
 * from them" — with no follow graph to unwind (D13). Block == mute (one feature, no separate mute).
 * These pure guards are single-sourced so the client and the `blocks.block` trust boundary (D37)
 * agree; the mutation re-enforces them server-side.
 */

/** A user can't block themselves (D32). Re-enforced in `blocks.block`. */
export function canBlock(blockerId: string, targetId: string): boolean {
  return blockerId !== targetId;
}
