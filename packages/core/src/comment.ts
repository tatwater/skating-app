/**
 * Comment body validation + thread-depth helpers (D21/D25).
 *
 * The data model allows arbitrary `parentCommentId` nesting, but the UI caps threads at **2 levels**
 * — a top-level tier plus one reply tier (D25). Deeper replies flatten onto the reply tier. This is
 * single-sourced here so the compose box (web + mobile) and the `comments.create` trust boundary
 * (D37) agree on both the body rules and the depth cap; the server never trusts the client's copy.
 */

/** Comment body length bounds — non-empty, roomy enough for a real follow-up, capped to deter walls. */
export const COMMENT_BODY_MIN_LENGTH = 1
export const COMMENT_BODY_MAX_LENGTH = 2000

/** Canonical stored form of a comment body: outer whitespace trimmed, inner formatting preserved. */
export function normalizeCommentBody(input: string): string {
  return input.trim()
}

/** Whether an already-normalized comment body is within bounds. */
export function isValidCommentBody(normalized: string): boolean {
  return (
    normalized.length >= COMMENT_BODY_MIN_LENGTH && normalized.length <= COMMENT_BODY_MAX_LENGTH
  )
}

/** Deepest reply tier the UI renders (D25): top-level = 0, one reply tier = 1. */
export const MAX_COMMENT_DEPTH = 1

/**
 * The `parentCommentId` a **new** reply to `target` should carry, enforcing the 2-level cap (D25):
 * replying to a top-level comment attaches to it; replying to an already-nested reply flattens onto
 * that reply's top-level parent. So every reply's parent is guaranteed top-level — which is exactly
 * what `comments.create` re-enforces server-side (reject a parent that itself has a parent).
 */
export function resolveReplyParentId(target: { id: string; parentCommentId?: string }): string {
  return target.parentCommentId ?? target.id
}

/** A comment as the thread builder needs to see it: identity, parent link, order, and visibility. */
export interface ThreadComment {
  id: string
  parentCommentId?: string
  createdAt: number
  /** Moderation-visible AND the author isn't blocked (see `canViewComment`) — computed by the caller. */
  visible: boolean
}

/**
 * A node in the flattened 2-level thread. A `hidden` node is a `[hidden]` **placeholder** — kept only
 * because it has visible descendants — and its content must NOT be rendered. Top-level nodes may
 * carry `replies`; reply nodes are always leaves (the cap flattens any deeper nesting up to the reply
 * tier), so their `replies` is always empty.
 */
export interface ThreadNode {
  id: string
  hidden: boolean
  replies: ThreadNode[]
}

/**
 * Arrange a flat comment list (all for one report) into the 2-level threaded shape the UI renders
 * (D25). Every non-top-level comment attaches to its **top-level ancestor's** reply tier, flattening
 * depth ≥ 2 onto depth 1. A comment (or reply) that isn't `visible` is dropped, **except** a
 * top-level comment with ≥ 1 visible reply, which is kept as a `[hidden]` placeholder so its replies
 * don't vanish (D25). Ordering is `createdAt` ascending at both tiers; placeholders keep their
 * chronological slot. Pure + deterministic (no clock), so it's fully unit-testable.
 */
export function buildCommentThread(comments: ThreadComment[]): ThreadNode[] {
  const byId = new Map<string, ThreadComment>()
  for (const c of comments) byId.set(c.id, c)

  // The top-level ancestor a comment groups under: walk parent links up to the root. A missing parent
  // (shouldn't happen within one report) makes the current comment a root. Bounded to guard a cycle.
  const rootOf = (c: ThreadComment): ThreadComment => {
    let cur = c
    for (let hops = 0; cur.parentCommentId !== undefined && hops < 64; hops++) {
      const parent = byId.get(cur.parentCommentId)
      if (!parent) break
      cur = parent
    }
    return cur
  }

  const sortByCreated = (a: ThreadComment, b: ThreadComment) => a.createdAt - b.createdAt
  const roots = comments.filter((c) => c.parentCommentId === undefined).sort(sortByCreated)

  // Group every non-root comment under its top-level ancestor's id.
  const repliesByRoot = new Map<string, ThreadComment[]>()
  for (const c of comments) {
    if (c.parentCommentId === undefined) continue
    const root = rootOf(c)
    if (root.id === c.id) continue // orphan (parent missing): treated as its own root below
    const list = repliesByRoot.get(root.id) ?? []
    list.push(c)
    repliesByRoot.set(root.id, list)
  }

  // An orphan (non-root comment whose ancestor chain didn't resolve to a listed root) still needs a
  // home; surface it at the top tier so nothing is silently lost.
  const orphans = comments.filter((c) => c.parentCommentId !== undefined && rootOf(c).id === c.id)
  const topLevel = [...roots, ...orphans].sort(sortByCreated)

  const nodes: ThreadNode[] = []
  for (const root of topLevel) {
    const visibleReplies = (repliesByRoot.get(root.id) ?? [])
      .filter((r) => r.visible)
      .sort(sortByCreated)
      .map((r): ThreadNode => ({ id: r.id, hidden: false, replies: [] }))

    if (root.visible) {
      nodes.push({ id: root.id, hidden: false, replies: visibleReplies })
    } else if (visibleReplies.length > 0) {
      // Hidden parent, but visible replies exist → keep as a `[hidden]` placeholder (D25).
      nodes.push({ id: root.id, hidden: true, replies: visibleReplies })
    }
    // else: hidden with no visible replies → dropped entirely.
  }
  return nodes
}
