import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader, StatTile } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { Avatar } from '../components/ProfileView';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Label } from '../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useRole } from '../lib/useRole';

/**
 * Operator user detail (D37/D50/D57). The **contributor-trust panel** (contradiction count + tenure)
 * feeds the D57 posting-permission decision; the **raw trust number** is admin-only (D50, gated
 * server-side). Lifecycle (ban/suspend/unban), posting-permission levers, and — for admins — role
 * grant/revoke, each audited via the shared reason dialog. The tenure-aware good-vs-bad trend chart
 * arrives with the analytics commit.
 */
export const Route = createFileRoute('/admin/users/$id')({ component: AdminUserDetail });

const DAY_MS = 24 * 60 * 60 * 1000;
const SUSPEND_OPTIONS = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
];

function ageLabel(createdAt: number): string {
  const days = Math.max(0, Math.round((Date.now() - createdAt) / DAY_MS));
  if (days < 60) return `${days}d old`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo old`;
  return `${Math.round(months / 12)}y old`;
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

function AdminUserDetail() {
  const { id } = Route.useParams();
  const userId = id as Id<'profiles'>;
  const { isAdmin } = useRole();
  const user = useQuery(api.profiles.getAdmin, { userId });

  const banUser = useMutation(api.moderation.banUser);
  const suspendUser = useMutation(api.moderation.suspendUser);
  const unbanUser = useMutation(api.moderation.unbanUser);
  const grantRole = useMutation(api.admin.grantRole);
  const revokeRole = useMutation(api.admin.revokeRole);
  const [suspendDays, setSuspendDays] = useState(3);

  if (user === undefined) return <AdminEmpty>Loading…</AdminEmpty>;
  if (user === null) return <AdminEmpty>User not found.</AdminEmpty>;

  const isActive = user.status === 'active';

  return (
    <div className="flex flex-col gap-6">
      <AdminPageHeader
        title={user.displayName}
        subtitle={`@${user.username} · ${ageLabel(user.createdAt)}`}
        actions={
          <div className="flex items-center gap-2">
            <Avatar displayName={user.displayName} imageUrl={user.profileImageUrl} size={40} />
            {user.role !== 'member' ? <Badge variant="outline">{user.role}</Badge> : null}
            <Badge variant={isActive ? 'secondary' : 'destructive'}>{user.status}</Badge>
          </div>
        }
      />
      {user.statusReason ? (
        <p className="text-foreground-muted text-sm">Reason on file: {user.statusReason}</p>
      ) : null}

      {/* Contributor-trust panel — the D57 lever's input. Raw score admin-only (D50). */}
      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Contributor trust
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Contradictions"
            value={user.contradictionCount}
            hint="weather-unexplained (private)"
            tone={user.contradictionCount >= 3 ? 'warning' : 'default'}
          />
          <StatTile label="Open flags" value={user.openFlagCount} />
          <StatTile label="Reports" value={user.reportCount} />
          {isAdmin ? (
            <StatTile
              label="Trust points"
              value={user.reputationPoints ?? 0}
              hint="raw score — admin only"
            />
          ) : (
            <StatTile label="Trust class" value={user.trustClass ?? '—'} />
          )}
        </div>
        <p className="text-foreground-muted text-xs">
          The tenure-aware good-vs-bad trend chart arrives with the analytics surface.
        </p>
      </section>

      {/* Posting-permission levers (D57). */}
      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Posting permissions
        </h2>
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
          </CardContent>
        </Card>
      </section>

      {/* Account lifecycle (D37). */}
      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Account status
        </h2>
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
                    suspendUser({
                      userId,
                      reason,
                      suspendedUntil: Date.now() + suspendDays * DAY_MS,
                    })
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
      </section>

      {/* Role management — admin only (D37). */}
      {isAdmin ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
            Role
          </h2>
          <Card>
            <CardContent className="flex flex-wrap gap-2">
              {user.role !== 'moderator' ? (
                <ReasonDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      Make moderator
                    </Button>
                  }
                  title={`Grant @${user.username} the moderator role`}
                  confirmLabel="Grant"
                  confirmVariant="default"
                  onConfirm={(reason) => grantRole({ userId, role: 'moderator', reason })}
                />
              ) : null}
              {user.role !== 'admin' ? (
                <ReasonDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      Make admin
                    </Button>
                  }
                  title={`Grant @${user.username} the admin role`}
                  description="Admins hold the keys — role-granting, PII, and the tuning surface."
                  confirmLabel="Grant admin"
                  onConfirm={(reason) => grantRole({ userId, role: 'admin', reason })}
                />
              ) : null}
              {user.role !== 'member' ? (
                <ReasonDialog
                  trigger={
                    <Button variant="ghost" size="sm">
                      Revoke role
                    </Button>
                  }
                  title={`Revoke @${user.username}'s role`}
                  confirmLabel="Revoke"
                  onConfirm={(reason) => revokeRole({ userId, reason })}
                />
              ) : null}
            </CardContent>
          </Card>
        </section>
      ) : null}
    </div>
  );
}
