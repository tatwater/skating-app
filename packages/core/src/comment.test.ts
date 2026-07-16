import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  buildCommentThread,
  COMMENT_BODY_MAX_LENGTH,
  isValidCommentBody,
  normalizeCommentBody,
  resolveReplyParentId,
  type ThreadComment,
} from './comment'

describe('normalizeCommentBody', () => {
  it('trims outer whitespace but preserves inner formatting', () => {
    expect(normalizeCommentBody('  hey  ')).toBe('hey')
    expect(normalizeCommentBody('line one\n\nline two')).toBe('line one\n\nline two')
  })
})

describe('isValidCommentBody', () => {
  it('accepts a non-empty body within bounds', () => {
    expect(isValidCommentBody('nice')).toBe(true)
    expect(isValidCommentBody('a'.repeat(COMMENT_BODY_MAX_LENGTH))).toBe(true)
  })

  it('rejects empty or over-long bodies', () => {
    expect(isValidCommentBody('')).toBe(false)
    expect(isValidCommentBody('a'.repeat(COMMENT_BODY_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('resolveReplyParentId (2-level cap, D25)', () => {
  it('replying to a top-level comment attaches to it', () => {
    expect(resolveReplyParentId({ id: 'c1' })).toBe('c1')
  })

  it('replying to a nested reply flattens onto its top-level parent', () => {
    expect(resolveReplyParentId({ id: 'c2', parentCommentId: 'c1' })).toBe('c1')
  })
})

/** Convenience builder for a thread comment. */
const c = (
  id: string,
  createdAt: number,
  visible: boolean,
  parentCommentId?: string,
): ThreadComment => ({ id, createdAt, visible, parentCommentId })

describe('buildCommentThread', () => {
  it('orders top-level comments and their replies by createdAt', () => {
    const tree = buildCommentThread([
      c('a', 2, true),
      c('b', 1, true),
      c('a2', 4, true, 'a'),
      c('a1', 3, true, 'a'),
    ])
    expect(tree.map((n) => n.id)).toEqual(['b', 'a'])
    const a = tree.find((n) => n.id === 'a')
    expect(a?.replies.map((n) => n.id)).toEqual(['a1', 'a2'])
  })

  it('flattens a depth-2 reply onto the reply tier of its top-level ancestor', () => {
    // grandchild `g` replies to reply `r`, which replies to root `t`.
    const [root, ...rest] = buildCommentThread([
      c('t', 1, true),
      c('r', 2, true, 't'),
      c('g', 3, true, 'r'),
    ])
    expect(rest).toHaveLength(0)
    expect(root?.id).toBe('t')
    // Both `r` and the flattened `g` sit at the single reply tier.
    expect(root?.replies.map((n) => n.id)).toEqual(['r', 'g'])
    expect(root?.replies.every((n) => n.replies.length === 0)).toBe(true)
  })

  it('keeps a hidden top-level comment with visible replies as a [hidden] placeholder', () => {
    const [root, ...rest] = buildCommentThread([c('t', 1, false), c('r', 2, true, 't')])
    expect(rest).toHaveLength(0)
    expect(root).toMatchObject({ id: 't', hidden: true })
    expect(root?.replies.map((n) => n.id)).toEqual(['r'])
  })

  it('drops a hidden top-level comment with no visible replies', () => {
    expect(buildCommentThread([c('t', 1, false)])).toEqual([])
    expect(buildCommentThread([c('t', 1, false), c('r', 2, false, 't')])).toEqual([])
  })

  it('drops a hidden reply but keeps its flattened visible descendant', () => {
    // `r` (hidden) has a visible grandchild `g`; `g` flattens to a reply of root `t`, `r` is dropped.
    const [root] = buildCommentThread([
      c('t', 1, true),
      c('r', 2, false, 't'),
      c('g', 3, true, 'r'),
    ])
    expect(root?.replies.map((n) => n.id)).toEqual(['g'])
  })

  it('never renders content for a hidden placeholder (hidden flag set)', () => {
    const [root] = buildCommentThread([c('t', 1, false), c('r', 2, true, 't')])
    expect(root?.hidden).toBe(true)
  })

  it('surfaces an orphan (missing parent) at the top tier rather than losing it', () => {
    const tree = buildCommentThread([c('orphan', 1, true, 'missing-parent')])
    expect(tree.map((n) => n.id)).toEqual(['orphan'])
  })
})

describe('buildCommentThread invariants (property)', () => {
  const arbComments = fc
    .array(
      fc.record({
        id: fc.string({ minLength: 1, maxLength: 4 }),
        createdAt: fc.integer({ min: 0, max: 100 }),
        visible: fc.boolean(),
        parentCommentId: fc.option(fc.string({ minLength: 1, maxLength: 4 }), { nil: undefined }),
      }),
      { maxLength: 12 },
    )
    // Unique ids; a comment can't be its own parent.
    .map((cs) => {
      const byId = new Map(cs.map((x) => [x.id, x]))
      return [...byId.values()].map((x) =>
        x.parentCommentId === x.id ? { ...x, parentCommentId: undefined } : x,
      )
    })

  it('is never deeper than 2 levels and never exposes a hidden comment’s content', () => {
    fc.assert(
      fc.property(arbComments, (comments) => {
        const tree = buildCommentThread(comments)
        for (const node of tree) {
          // Reply tier is flat (leaves only) — the 2-level cap.
          for (const reply of node.replies) {
            expect(reply.replies).toEqual([])
            // A rendered reply is always visible content (never a placeholder).
            expect(reply.hidden).toBe(false)
          }
          // A hidden top-level node is only ever kept as a placeholder with ≥1 visible reply.
          if (node.hidden) expect(node.replies.length).toBeGreaterThan(0)
        }
      }),
    )
  })
})
