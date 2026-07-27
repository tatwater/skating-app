import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import type { UserStatus } from '@skating/core';
import { useMutation } from 'convex/react';
import { useState } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { ReasonDialog } from './ReasonDialog';

/** The subset of `profiles.getAdmin` the shared moderation controls need. */
export interface ModeratableUser {
  userId: string;
  username: string;
  status: UserStatus;
  canPostReports: boolean;
  canPostHazards: boolean;
  canPostComments: boolean;
  /** Per-user open-bounty cap (N2 / D57). Absent ⇒ the global cap; `0` ⇒ can't post bounties. */
  activeBountyPostLimit?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPEND_OPTIONS = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

/**
 * The bounty lever is a **number**, not a switch (N2 / D57).
 *
 * Bounties aren't content — they're requests — so the proportionate answer to someone spamming them
 * is fewer rather than none, and a boolean couldn't express that. `0` is still available and still
 * means none, but it's a point on the scale rather than the only alternative to unrestricted.
 */
function BountyLimitRow({ userId, limit }: { userId: string; limit?: number }) {
  const setLimit = useMutation(api.moderation.setBountyPostLimit);
  const [value, setValue] = useState(limit === undefined ? '' : String(limit));

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-foreground text-sm">
        Open bounties
        {limit !== undefined ? (
          <Badge variant={limit === 0 ? 'destructive' : 'secondary'} className="ml-2">
            {limit === 0 ? 'blocked' : `limit ${limit}`}
          </Badge>
        ) : null}
      </span>
      <span className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="1"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="global"
          className="w-24"
          aria-label="Open-bounty limit"
        />
        <ReasonDialog
          trigger={
            <Button variant="outline" size="sm">
              {value === '' ? 'Clear limit' : 'Set limit'}
            </Button>
          }
          title="Set the open-bounty limit"
          description="Blank restores the global cap. Zero blocks bounties while leaving reports and hazards alone."
          confirmLabel="Save"
          onConfirm={(reason) =>
            setLimit({
              userId: userId as Id<'profiles'>,
              ...(value === '' ? {} : { limit: Number(value) }),
              reason,
            })
          }
        />
      </span>
    </div>
  );
}

function PostingPermissionRow({
  userId,
  label,
  permission,
  allowed,
}: {
  userId: Id<'profiles'>;
  label: string;
  permission: 'reports' | 'hazards' | 'comments';
  allowed: boolean;
}) {
  const setPerm = useMutation(api.moderation.setPostingPermission);
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-foreground text-sm">
        {label}
        {!allowed ? (
          <Badge variant="destructive" className="ml-2">
            restricted
          </Badge>
        ) : null}
      </span>
      {allowed ? (
        <ReasonDialog
          trigger={
            <Button variant="outline" size="sm">
              Restrict
            </Button>
          }
          title={`Restrict ${permission} posting`}
          description="A lever finer than a ban — their other contributions stand."
          confirmLabel="Restrict"
          onConfirm={(reason) => setPerm({ userId, permission, allowed: false, reason })}
        />
      ) : (
        <ReasonDialog
          trigger={
            <Button variant="secondary" size="sm">
              Restore
            </Button>
          }
          title={`Restore ${permission} posting`}
          confirmLabel="Restore"
          confirmVariant="secondary"
          onConfirm={(reason) => setPerm({ userId, permission, allowed: true, reason })}
        />
      )}
    </div>
  );
}

/**
 * The shared user-moderation controls (D37/D57) — posting-permission levers + account lifecycle
 * (ban / suspend / unban). Used by both the full `/admin/users/$id` detail page and the in-context
 * moderator panel on a public profile, so the two front-ends stay one implementation over one set of
 * server-gated mutations. Role grant/revoke stays out (admin-only, on the detail page only).
 */
export function UserModerationControls({ user }: { user: ModeratableUser }) {
  const userId = user.userId as Id<'profiles'>;
  const banUser = useMutation(api.moderation.banUser);
  const suspendUser = useMutation(api.moderation.suspendUser);
  const unbanUser = useMutation(api.moderation.unbanUser);
  const [suspendDays, setSuspendDays] = useState(3);
  const isActive = user.status === 'active';

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <PostingPermissionRow
            userId={userId}
            label="Reports"
            permission="reports"
            allowed={user.canPostReports}
          />
          <PostingPermissionRow
            userId={userId}
            label="Hazards"
            permission="hazards"
            allowed={user.canPostHazards}
          />
          <PostingPermissionRow
            userId={userId}
            label="Comments"
            permission="comments"
            allowed={user.canPostComments}
          />
          <BountyLimitRow userId={userId} limit={user.activeBountyPostLimit} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap gap-2">
          {isActive ? (
            <>
              <ReasonDialog
                trigger={
                  <Button variant="outline" size="sm">
                    Suspend
                  </Button>
                }
                title={`Suspend @${user.username}`}
                description="A temporary hold; the account reactivates automatically when it lapses."
                confirmLabel="Suspend"
                extraFields={
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="suspend-days">Duration</Label>
                    <Select
                      value={String(suspendDays)}
                      onValueChange={(v) => setSuspendDays(Number(v))}
                    >
                      <SelectTrigger id="suspend-days" size="sm" className="w-40">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUSPEND_OPTIONS.map((o) => (
                          <SelectItem key={o.days} value={String(o.days)}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                }
                onConfirm={(reason) =>
                  suspendUser({ userId, reason, suspendedUntil: Date.now() + suspendDays * DAY_MS })
                }
              />
              <ReasonDialog
                trigger={
                  <Button variant="destructive" size="sm">
                    Ban
                  </Button>
                }
                title={`Ban @${user.username}`}
                description="Indefinite. Preserves the account for appeal; also locks their sign-in."
                confirmLabel="Ban"
                onConfirm={(reason) => banUser({ userId, reason })}
              />
            </>
          ) : (
            <ReasonDialog
              trigger={
                <Button variant="secondary" size="sm">
                  Lift ban / suspension
                </Button>
              }
              title={`Reinstate @${user.username}`}
              confirmLabel="Reinstate"
              confirmVariant="secondary"
              onConfirm={(reason) => unbanUser({ userId, reason })}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
