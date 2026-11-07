import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faReply } from '@fortawesome/sharp-light-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  COMMENT_BODY_MAX_LENGTH,
  isLeaving,
  isMinor,
  isValidCommentBody,
  REDACTED_COMMENT_NOTICE,
} from '@skating/core';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useState } from 'react';

import { useAnalytics } from '@/lib/analytics';
import { useRole } from '@/lib/useRole';
import { Avatar } from '../../kit/avatar';
import { Button } from '../../kit/button';
import { SectionSlug } from '../../kit/section-slug';
import { Textarea } from '../../kit/textarea';
import { ModeratorActions } from '../../ModeratorActions';
import { PersonName } from '../../PersonName';
import { FlagDialog } from './FlagDialog';
import { ageLabel } from './panelTime';

/** A comment's author as the server sends it (`publicAuthor`). */
export interface CommentAuthor {
  username: string;
  displayName: string;
  profileImageUrl?: string;
  /** A tombstone: the name shows, nothing links. */
  deleted?: true;
}

/** One node of the two-level thread. `comment: null` is a hidden comment's placeholder. */
export interface CommentNodeData {
  id: string;
  hidden: boolean;
  comment: {
    body: string;
    /** The author left; the standing-in line renders instead (D62). */
    redacted?: boolean;
    authorId: string;
    author: CommentAuthor | null;
    isOwn: boolean;
    createdAt: number;
    editedAt?: number;
  } | null;
  replies: CommentNodeData[];
}

/** The viewer, for the compose box's face. */
export interface CommentViewer {
  displayName: string;
  profileImageUrl?: string;
}

export interface CommentThreadViewProps {
  nodes: readonly CommentNodeData[];
  now: number;
  /** Signed in, active, an adult, not leaving (D41, D62). Otherwise the thread is read-only. */
  viewer: CommentViewer | null;
  onCreate: (body: string, parentId?: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onRemove: (commentId: string) => Promise<void>;
  /** Flag and moderator controls, injected so the thread stays Convex-free. */
  renderActions?: (node: CommentNodeData) => ReactNode;
}

/**
 * The comments under a report (board 2.4): the slug with its count, one row per comment — a circle,
 * the name, how long ago, the words — replies indented under their parent, then the compose box with
 * the viewer's face. Two levels, as the server keeps them (D21/D25).
 */
export function CommentThreadView({
  nodes,
  now,
  viewer,
  onCreate,
  onEdit,
  onRemove,
  renderActions,
}: CommentThreadViewProps) {
  const count = countVisible(nodes);
  return (
    <section data-slot="comment-thread" className="flex flex-col gap-(--space-4)">
      <SectionSlug title="Comments" count={count} level={3} />
      {nodes.length === 0 ? (
        <p className="m-0 text-assist text-fg2">No comments yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-(--space-4) p-0">
          {nodes.map((node) => (
            <CommentRow
              key={node.id}
              node={node}
              depth={0}
              now={now}
              canComment={viewer !== null}
              onCreate={onCreate}
              onEdit={onEdit}
              onRemove={onRemove}
              renderActions={renderActions}
            />
          ))}
        </ol>
      )}
      {viewer !== null && (
        <Compose
          viewer={viewer}
          submitLabel="Post"
          placeholder="Add a comment…"
          onSubmit={(body) => onCreate(body)}
        />
      )}
    </section>
  );
}

function countVisible(nodes: readonly CommentNodeData[]): number {
  return nodes.reduce(
    (n, node) => n + (node.comment === null ? 0 : 1) + countVisible(node.replies),
    0,
  );
}

function CommentRow({
  node,
  depth,
  now,
  canComment,
  onCreate,
  onEdit,
  onRemove,
  renderActions,
}: {
  node: CommentNodeData;
  depth: number;
  now: number;
  canComment: boolean;
  onCreate: (body: string, parentId?: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onRemove: (commentId: string) => Promise<void>;
  renderActions?: ((node: CommentNodeData) => ReactNode) | undefined;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const c = node.comment;
  const name = c?.author?.displayName ?? 'Unknown';

  return (
    <li
      data-slot="comment"
      data-reply={depth > 0 ? '' : undefined}
      className="flex flex-col gap-(--space-3)"
    >
      {c === null ? (
        <p className="m-0 text-assist text-fg3 italic">This comment is hidden.</p>
      ) : (
        <div className="flex gap-(--space-3)">
          <Avatar
            name={name}
            {...(c.author?.profileImageUrl ? { src: c.author.profileImageUrl } : {})}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-(--space-1)">
            <div className="flex items-baseline gap-(--space-2) text-assist">
              <AuthorName author={c.author} name={name} />
              <span className="font-(family-name:--family-mono) text-[0.65625rem] text-fg3">
                {ageLabel(c.createdAt, now)}
                {c.editedAt !== undefined ? ' · edited' : ''}
              </span>
            </div>
            {editing ? (
              <Compose
                initial={c.body}
                submitLabel="Save"
                placeholder="Edit your comment…"
                onCancel={() => setEditing(false)}
                onSubmit={async (body) => {
                  await onEdit(node.id, body);
                  setEditing(false);
                }}
              />
            ) : (
              <p
                className={
                  c.redacted
                    ? 'm-0 text-row text-fg3 italic'
                    : 'm-0 text-row leading-body whitespace-pre-wrap text-fg1'
                }
              >
                {c.redacted ? REDACTED_COMMENT_NOTICE : c.body}
              </p>
            )}
            <div className="mt-(--space-1) flex flex-wrap items-center gap-(--space-1_5)">
              {canComment && depth === 0 && (
                <Button
                  size="xs"
                  data-attr="comment-reply"
                  aria-expanded={replying}
                  onClick={() => setReplying((r) => !r)}
                >
                  <FontAwesomeIcon icon={faReply} aria-hidden="true" className="h-2.5" />
                  Reply
                </Button>
              )}
              {c.isOwn && !c.redacted && (
                <>
                  <Button size="xs" data-attr="comment-edit" onClick={() => setEditing((e) => !e)}>
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    data-attr="comment-delete"
                    onClick={() => void onRemove(node.id)}
                  >
                    Delete
                  </Button>
                </>
              )}
              {renderActions?.(node)}
            </div>
          </div>
        </div>
      )}
      {replying && (
        <div className="pl-[2.375rem]">
          <Compose
            submitLabel="Reply"
            placeholder="Write a reply…"
            autoFocus
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await onCreate(body, node.id);
              setReplying(false);
            }}
          />
        </div>
      )}
      {node.replies.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-(--space-4) p-0 pl-[2.375rem]">
          {node.replies.map((reply) => (
            <CommentRow
              key={reply.id}
              node={reply}
              depth={depth + 1}
              now={now}
              canComment={canComment}
              onCreate={onCreate}
              onEdit={onEdit}
              onRemove={onRemove}
              renderActions={renderActions}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

function AuthorName({ author, name }: { author: CommentAuthor | null; name: string }) {
  const label = <PersonName className="font-medium text-fg">{name}</PersonName>;
  if (author === null || author.deleted || author.username === '') return label;
  return (
    <Link
      to="/u/$username"
      params={{ username: author.username }}
      className="text-fg no-underline hover:underline"
    >
      {label}
    </Link>
  );
}

/** The compose box: a face (top level), the boxed field, the action. */
function Compose({
  viewer,
  initial = '',
  submitLabel,
  placeholder,
  autoFocus = false,
  onSubmit,
  onCancel,
}: {
  viewer?: CommentViewer;
  initial?: string;
  submitLabel: string;
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const valid = isValidCommentBody(body.trim());

  const submit = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await onSubmit(body.trim());
      setBody('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-slot="comment-compose" className="flex flex-col gap-(--space-2)">
      <div className="flex items-end gap-(--space-2_5)">
        {viewer !== undefined && (
          <Avatar
            name={viewer.displayName}
            {...(viewer.profileImageUrl ? { src: viewer.profileImageUrl } : {})}
          />
        )}
        <Textarea
          aria-label={placeholder.replace('…', '')}
          placeholder={placeholder}
          maxLength={COMMENT_BODY_MAX_LENGTH}
          autoFocus={autoFocus}
          rows={2}
          className="min-h-10 flex-1"
          value={body}
          onValueChange={(value) => setBody(value)}
        />
        <Button
          size="sm"
          data-attr="comment-submit"
          disabled={!valid}
          loading={busy}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button size="sm" variant="bare" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
      {failed && (
        <p role="alert" className="m-0 text-assist text-bad">
          Not posted. Check your connection and try again.
        </p>
      )}
    </div>
  );
}

/**
 * The live thread: `comments.listByReport`, `create`, `update`, `remove`. Flag on anyone else's
 * comment; a moderator's takedown beside it.
 */
export function Comments({ reportId, now }: { reportId: string; now: number }) {
  const analytics = useAnalytics();
  const rid = reportId as Id<'reports'>;
  const nodes = useQuery(api.comments.listByReport, { reportId: rid });
  const me = useQuery(api.profiles.current, {});
  const { canModerate } = useRole();
  const create = useMutation(api.comments.create);
  const edit = useMutation(api.comments.update);
  const remove = useMutation(api.comments.remove);

  // Signed-in, active adults may comment; minors read (D41), and a pending deletion reads too (D62).
  const canComment =
    me != null && me.status === 'active' && !isMinor(me.dateOfBirth, now) && !isLeaving(me);

  return (
    <CommentThreadView
      nodes={(nodes ?? []) as CommentNodeData[]}
      now={now}
      viewer={
        canComment
          ? {
              displayName: me.displayName,
              ...(me.profileImageUrl !== undefined ? { profileImageUrl: me.profileImageUrl } : {}),
            }
          : null
      }
      onCreate={async (body, parentId) => {
        await create({
          reportId: rid,
          body,
          ...(parentId !== undefined ? { parentCommentId: parentId as Id<'comments'> } : {}),
        });
        analytics.capture('comment_created', { is_reply: parentId !== undefined });
      }}
      onEdit={async (commentId, body) => {
        await edit({ commentId: commentId as Id<'comments'>, body });
      }}
      onRemove={async (commentId) => {
        await remove({ commentId: commentId as Id<'comments'> });
      }}
      renderActions={(node) =>
        node.comment && !node.comment.isOwn ? (
          <>
            <FlagDialog target="comment" targetId={node.id} size="xs" />
            {canModerate ? <ModeratorActions targetType="comment" targetId={node.id} /> : null}
          </>
        ) : null
      }
    />
  );
}
