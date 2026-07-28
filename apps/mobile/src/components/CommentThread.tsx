import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import {
  COMMENT_BODY_MAX_LENGTH,
  formatSkateTime,
  isLeaving,
  isMinor,
  isValidCommentBody,
  REDACTED_COMMENT_NOTICE,
  type TrustClass,
} from '@skating/core';
import { useMutation, useQuery } from 'convex/react';
import { type ReactNode, useState } from 'react';
import { Button, Paragraph, Separator, Text, TextArea, XStack, YStack } from 'tamagui';
import { ModeratorActions, useIsModerator } from './ModeratorActions';
import { FlagControl } from './SafetyControls';
import { TrustAvatar } from './TrustDisplay';

/** Public author attribution on a comment (mirrors the server payload). */
export interface CommentAuthor {
  username: string;
  displayName: string;
  profileImageUrl?: string;
  /** Cosmetic trust class (D50) — rings the comment avatar; `null`/absent ⇒ no ring. */
  trustClass?: TrustClass | null;
}

/** A node in the rendered thread — `comment: null` is a `[hidden]` placeholder (no content). */
export interface CommentNodeData {
  id: string;
  hidden: boolean;
  comment: {
    body: string;
    /** Author left; `body` is empty and the standing-in line renders instead (D62 2nd amendment). */
    redacted?: boolean;
    authorId: string;
    author: CommentAuthor | null;
    isOwn: boolean;
    createdAt: number;
    editedAt?: number;
  } | null;
  replies: CommentNodeData[];
}

/** A compose/edit box with validation + submit. */
function CommentBox({
  initial = '',
  submitLabel,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial?: string;
  submitLabel: string;
  placeholder: string;
  onSubmit: (body: string) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const valid = isValidCommentBody(body.trim());

  return (
    <YStack gap="$2">
      <TextArea
        value={body}
        onChangeText={setBody}
        maxLength={COMMENT_BODY_MAX_LENGTH}
        placeholder={placeholder}
        borderColor="$border"
      />
      <XStack gap="$2">
        <Button
          size="$2"
          backgroundColor="$primary"
          color="$primaryForeground"
          disabled={!valid || busy}
          onPress={async () => {
            setBusy(true);
            try {
              await onSubmit(body.trim());
              setBody('');
            } finally {
              setBusy(false);
            }
          }}
        >
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button size="$2" chromeless onPress={onCancel}>
            Cancel
          </Button>
        ) : null}
      </XStack>
    </YStack>
  );
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
  node: CommentNodeData;
  depth: number;
  canComment: boolean;
  onCreate: (body: string, parentId?: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onRemove: (commentId: string) => Promise<void>;
  renderActions?: (node: CommentNodeData) => ReactNode;
}) {
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <YStack gap="$2">
      {node.comment === null ? (
        <Text color="$foregroundMuted" fontStyle="italic">
          [comment hidden]
        </Text>
      ) : (
        <XStack gap="$2">
          <TrustAvatar
            displayName={node.comment.author?.displayName ?? 'Unknown'}
            imageUrl={node.comment.author?.profileImageUrl}
            trustClass={node.comment.author?.trustClass}
            size={28}
          />
          <YStack flex={1} gap="$1">
            <XStack gap="$2" alignItems="baseline">
              <Text color="$foreground" fontWeight="600">
                {node.comment.author?.displayName ?? 'Unknown'}
              </Text>
              <Text color="$foregroundMuted" fontSize="$1">
                {formatSkateTime(node.comment.createdAt)}
                {node.comment.editedAt ? ' · edited' : ''}
              </Text>
            </XStack>
            {editing ? (
              <CommentBox
                initial={node.comment.body}
                submitLabel="Save"
                placeholder="Edit your comment…"
                onCancel={() => setEditing(false)}
                onSubmit={async (body) => {
                  await onEdit(node.id, body);
                  setEditing(false);
                }}
              />
            ) : node.comment.redacted ? (
              <Paragraph color="$foregroundMuted" fontStyle="italic">
                {REDACTED_COMMENT_NOTICE}
              </Paragraph>
            ) : (
              <Paragraph color="$foreground">{node.comment.body}</Paragraph>
            )}
            <XStack gap="$1" flexWrap="wrap" alignItems="center">
              {canComment && depth === 0 ? (
                <Button size="$2" chromeless onPress={() => setReplying((r) => !r)}>
                  Reply
                </Button>
              ) : null}
              {node.comment.isOwn ? (
                <>
                  <Button size="$2" chromeless onPress={() => setEditing((e) => !e)}>
                    Edit
                  </Button>
                  <Button size="$2" chromeless onPress={() => onRemove(node.id)}>
                    Delete
                  </Button>
                </>
              ) : null}
              {renderActions?.(node)}
            </XStack>
          </YStack>
        </XStack>
      )}

      {replying ? (
        <YStack paddingLeft="$6">
          <CommentBox
            submitLabel="Reply"
            placeholder="Write a reply…"
            onCancel={() => setReplying(false)}
            onSubmit={async (body) => {
              await onCreate(body, node.id);
              setReplying(false);
            }}
          />
        </YStack>
      ) : null}

      {node.replies.length > 0 ? (
        <YStack gap="$3" paddingLeft="$3" borderLeftWidth={1} borderColor="$border">
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
        </YStack>
      ) : null}
    </YStack>
  );
}

/**
 * Presentational comment thread (D21/D25), the mobile mirror of web's `CommentThread` — a 2-level
 * tree with `[hidden]` placeholders, an optional compose box, and per-comment reply/edit/delete for
 * the author. All writes go through callbacks; flag/moderate are injected via `renderActions`.
 */
export function CommentThread({
  nodes,
  canComment,
  onCreate,
  onEdit,
  onRemove,
  renderActions,
}: {
  nodes: CommentNodeData[];
  canComment: boolean;
  onCreate: (body: string, parentId?: string) => Promise<void>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onRemove: (commentId: string) => Promise<void>;
  renderActions?: (node: CommentNodeData) => ReactNode;
}) {
  return (
    <YStack gap="$4">
      {canComment ? (
        <CommentBox
          submitLabel="Comment"
          placeholder="Add a comment…"
          onSubmit={(body) => onCreate(body)}
        />
      ) : null}
      {nodes.length === 0 ? (
        <Text color="$foregroundMuted">No comments yet.</Text>
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
    </YStack>
  );
}

/** Container: reads the thread for a report and wires create/edit/remove + flag/moderate. */
export function Comments({ reportId }: { reportId: string }) {
  const rid = reportId as Id<'reports'>;
  const nodes = useQuery(api.comments.listByReport, { reportId: rid });
  const me = useQuery(api.profiles.current, {});
  const isModerator = useIsModerator();
  const create = useMutation(api.comments.create);
  const edit = useMutation(api.comments.update);
  const remove = useMutation(api.comments.remove);

  // Signed-in, active adults may comment; minors are read-only (D41) — hide the compose box. A
  // pending deletion is read-only for the same reason and by the same mechanism (D62 amendment).
  const canComment =
    me != null && me.status === 'active' && !isMinor(me.dateOfBirth, Date.now()) && !isLeaving(me);

  return (
    <YStack gap="$3">
      <Separator borderColor="$border" />
      <Text color="$foregroundMuted" fontSize={11} letterSpacing={1.5} textTransform="uppercase">
        Comments
      </Text>
      <CommentThread
        nodes={nodes ?? []}
        canComment={canComment}
        onCreate={async (body, parentId) => {
          await create({
            reportId: rid,
            body,
            ...(parentId ? { parentCommentId: parentId as Id<'comments'> } : {}),
          });
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
              <FlagControl targetType="comment" targetId={node.id} />
              {isModerator ? <ModeratorActions targetType="comment" targetId={node.id} /> : null}
            </>
          ) : null
        }
      />
    </YStack>
  );
}
