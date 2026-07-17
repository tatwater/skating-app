import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { type CommentNodeData, CommentThread } from './CommentThread'

const noop = async () => {}

const mkComment = (
  id: string,
  body: string,
  isOwn: boolean,
  replies: CommentNodeData[] = [],
): CommentNodeData => ({
  id,
  hidden: false,
  comment: {
    body,
    authorId: `author-${id}`,
    author: { username: id, displayName: `User ${id}` },
    isOwn,
    createdAt: 1_700_000_000_000,
  },
  replies,
})

describe('CommentThread', () => {
  it('renders a 2-level thread with nested replies', () => {
    const nodes = [mkComment('a', 'top-level', false, [mkComment('b', 'a reply', false)])]
    render(
      <CommentThread
        nodes={nodes}
        canComment={false}
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    )
    expect(screen.getByText('top-level')).toBeInTheDocument()
    expect(screen.getByText('a reply')).toBeInTheDocument()
  })

  it('renders a [hidden] placeholder without leaking content, keeping visible replies', () => {
    const placeholder: CommentNodeData = {
      id: 'p',
      hidden: true,
      comment: null,
      replies: [mkComment('r', 'surviving reply', false)],
    }
    render(
      <CommentThread
        nodes={[placeholder]}
        canComment={false}
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    )
    expect(screen.getByText('[comment hidden]')).toBeInTheDocument()
    expect(screen.getByText('surviving reply')).toBeInTheDocument()
  })

  it('shows Edit/Delete only on the viewer’s own comment', () => {
    render(
      <CommentThread
        nodes={[mkComment('mine', 'my comment', true)]}
        canComment
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
      />,
    )
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
  })

  it('hides the compose box when the viewer cannot comment (signed out / minor)', () => {
    render(
      <CommentThread nodes={[]} canComment={false} onCreate={noop} onEdit={noop} onRemove={noop} />,
    )
    expect(screen.queryByPlaceholderText('Add a comment…')).not.toBeInTheDocument()
    expect(screen.getByText('No comments yet.')).toBeInTheDocument()
  })

  it('offers Reply only at the top level (the 2-level cap flattens deeper)', () => {
    const nodes = [mkComment('a', 'top', false, [mkComment('b', 'reply', false)])]
    render(<CommentThread nodes={nodes} canComment onCreate={noop} onEdit={noop} onRemove={noop} />)
    // Exactly one Reply button (on the top-level comment, not on the reply).
    expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1)
  })

  it('injects per-comment actions via renderActions', () => {
    const renderActions = vi.fn(() => <span>action-slot</span>)
    render(
      <CommentThread
        nodes={[mkComment('a', 'top', false)]}
        canComment
        onCreate={noop}
        onEdit={noop}
        onRemove={noop}
        renderActions={renderActions}
      />,
    )
    expect(screen.getByText('action-slot')).toBeInTheDocument()
  })
})
