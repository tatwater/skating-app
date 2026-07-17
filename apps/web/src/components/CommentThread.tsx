import { api } from '@skating/convex/api'
import type { Id } from '@skating/convex/dataModel'
import {
  COMMENT_BODY_MAX_LENGTH,
  formatSkateTime,
  isMinor,
  isValidCommentBody,
} from '@skating/core'
import { useMutation, useQuery } from 'convex/react'
import { type ReactNode, useState } from 'react'
import { ModeratorActions, useIsModerator } from './ModeratorActions'
import { Avatar } from './ProfileView'
import { FlagDialog } from './SafetyControls'
import { Button } from './ui/button'
import { Separator } from './ui/separator'
import { Textarea } from './ui/textarea'

/** Public author attribution on a comment (mirrors the server payload). */
export interface CommentAuthor {
  username: string
  displayName: string
  profileImageUrl?: string
}

/** A node in the rendered thread — `comment: null` is a `[hidden]` placeholder (no content). */
export interface CommentNodeData {
  id: string
  hidden: boolean
  comment: {
    body: string
    authorId: string
    author: CommentAuthor | null
    isOwn: boolean
    createdAt: number
    editedAt?: number
  } | null
  replies: CommentNodeData[]
}

/** A compose/edit box with validation + submit. */
function CommentBox({
  initial = '',
  submitLabel,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial?: string
  submitLabel: string
  placeholder: string
  onSubmit: (body: string) => Promise<void> | void
  onCancel?: () => void
}) {
  const [body, setBody] = useState(initial)
  const [busy, setBusy] = useState(false)
  const valid = isValidCommentBody(body.trim())

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        maxLength={COMMENT_BODY_MAX_LENGTH}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onSubmit(body.trim())
              setBody('')
            } finally {
              setBusy(false)
            }
          }}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function CommentNode({
  node,
  depth,
  canComment,
  onCreate,
  onEdit,
  onRemove,
  renderActions,
}: {
  node: CommentNodeData
  depth: number
  canComment: boolean
  onCreate: (body: string, parentId?: string) => Promise<void>
  onEdit: (commentId: string, body: string) => Promise<void>
  onRemove: (commentId: string) => Promise<void>
  renderActions?: (node: CommentNodeData) => ReactNode
}) {
  const [replying, setReplying] = useState(false)
  const [editing, setEditing] = useState(false)

  return (
    <div className="flex flex-col gap-2">
      {node.comment === null ? (
        <p className="text-foreground-muted text-sm italic">[comment hidden]</p>
      ) : (
        <div className="flex gap-2">
          <Avatar
            displayName={node.comment.author?.displayName ?? 'Unknown'}
            imageUrl={node.comment.author?.profileImageUrl}
            size={28}
          />
          <div className="flex flex-1 flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span className="font-medium text-foreground text-sm">
                {node.comment.author?.displayName ?? 'Unknown'}
              </span>
              <span className="text-foreground-muted text-xs">
                {formatSkateTime(node.comment.createdAt)}
                {node.comment.editedAt ? ' · edited' : ''}
              </span>
            </div>
            {editing ? (
              <CommentBox
                initial={node.comment.body}
                submitLabel="Save"
                placeholder="Edit your comment…"
                onCancel={() => setEditing(false)}
                onSubmit={async (body) => {
                  await onEdit(node.id, body)
                  setEditing(false)
                }}
              />
            ) : (
              <p className="whitespace-pre-wrap text-foreground text-sm">{node.comment.body}</p>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {canComment && depth === 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setReplying((r) => !r)}>
                  Reply
                </Button>
              ) : null}
              {node.comment.isOwn ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onRemove(node.id)}>
                    Delete
                  </Button>
                </>
              ) : null}
              {renderActions?.(node)}
            </div>
          </div>
        </div>
      )}

      {replying ? (
        <div className="pl-9">
          <CommentBox
            submitLabel="Reply"
            placeholder="Write a reply…"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await onCreate(body, node.id)
              setReplying(false)
            }}
          />
        </div>
      ) : null}

      {node.replies.length > 0 ? (
        <div className="flex flex-col gap-3 border-border border-l pl-3">
          {node.replies.map((reply) => (
            <CommentNode
              key={reply.id}
              node={reply}
              depth={depth + 1}
              canComment={canComment}
              onCreate={onCreate}
              onEdit={onEdit}
              onRemove={onRemove}
              renderActions={renderActions}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Presentational comment thread (D21/D25) — a 2-level tree with `[hidden]` placeholders, an optional
 * top-level compose box, and per-comment reply/edit/delete for the author. Convex-free: all writes go
 * through the callbacks, and mutation-driven controls (flag/moderate) are injected via `renderActions`
 * — so it's unit-testable with fixtures. `canComment` is false for signed-out users and minors (D41).
 */
export function CommentThread({
  nodes,
  canComment,
  onCreate,
  onEdit,
  onRemove,
  renderActions,
}: {
  nodes: CommentNodeData[]
  canComment: boolean
  onCreate: (body: string, parentId?: string) => Promise<void>
  onEdit: (commentId: string, body: string) => Promise<void>
  onRemove: (commentId: string) => Promise<void>
  renderActions?: (node: CommentNodeData) => ReactNode
}) {
  return (
    <div className="flex flex-col gap-4">
      {canComment ? (
        <CommentBox
          submitLabel="Comment"
          placeholder="Add a comment…"
          onSubmit={(body) => onCreate(body)}
        />
      ) : null}
      {nodes.length === 0 ? (
        <p className="text-foreground-muted text-sm">No comments yet.</p>
      ) : (
        nodes.map((node) => (
          <CommentNode
            key={node.id}
            node={node}
            depth={0}
            canComment={canComment}
            onCreate={onCreate}
            onEdit={onEdit}
            onRemove={onRemove}
            renderActions={renderActions}
          />
        ))
      )}
    </div>
  )
}

/**
 * Container: reads the thread for a report and wires create/edit/remove. Comments are gated to
 * signed-in adults (a minor's `current` role still loads, but the server rejects their create — we
 * hide the box). Flag + moderator controls are injected per comment via `renderActions`.
 */
export function Comments({ reportId }: { reportId: string }) {
  const rid = reportId as Id<'reports'>
  const nodes = useQuery(api.comments.listByReport, { reportId: rid })
  const me = useQuery(api.profiles.current, {})
  const isModerator = useIsModerator()
  const create = useMutation(api.comments.create)
  const edit = useMutation(api.comments.update)
  const remove = useMutation(api.comments.remove)

  // Signed-in, active adults may comment; minors are read-only (D41) so we hide the compose box (the
  // server also rejects them at the trust boundary).
  const canComment = me != null && me.status === 'active' && !isMinor(me.dateOfBirth, Date.now())

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <Separator />
      <h3 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
        Comments
      </h3>
      <CommentThread
        nodes={nodes ?? []}
        canComment={canComment}
        onCreate={async (body, parentId) => {
          await create({
            reportId: rid,
            body,
            ...(parentId ? { parentCommentId: parentId as Id<'comments'> } : {}),
          })
        }}
        onEdit={async (commentId, body) => {
          await edit({ commentId: commentId as Id<'comments'>, body })
        }}
        onRemove={async (commentId) => {
          await remove({ commentId: commentId as Id<'comments'> })
        }}
        renderActions={(node) =>
          node.comment && !node.comment.isOwn ? (
            <>
              <FlagDialog targetType="comment" targetId={node.id} label="Flag" />
              {isModerator ? <ModeratorActions targetType="comment" targetId={node.id} /> : null}
            </>
          ) : null
        }
      />
    </div>
  )
}
