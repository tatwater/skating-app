import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery } from 'convex/react';
import { AdminEmpty, AdminPageHeader, StatTile } from '../components/admin/adminUi';
import { ReasonDialog } from '../components/admin/ReasonDialog';
import { UserModerationControls } from '../components/admin/UserModerationControls';
import { Avatar } from '../components/ProfileView';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { useRole } from '../lib/useRole';

/**
 * Operator user detail (D37/D50/D57). The **contributor-trust panel** (contradiction count + tenure)
 * feeds the D57 posting-permission decision; the **raw trust number** is admin-only (D50, gated
 * server-side). Lifecycle + posting-permission levers come from the shared `UserModerationControls`
 * (also used in-context on a profile); role grant/revoke is admin-only and lives here. The tenure-aware
 * good-vs-bad trend chart arrives with the analytics commit.
 */
export const Route = createFileRoute('/admin/users/$id')({ component: AdminUserDetail });

const DAY_MS = 24 * 60 * 60 * 1000;

function ageLabel(createdAt: number): string {
  const days = Math.max(0, Math.round((Date.now() - createdAt) / DAY_MS));
  if (days < 60) return `${days}d old`;
  const months = Math.round(days / 30);
  if (months < 24) return `${months}mo old`;
  return `${Math.round(months / 12)}y old`;
}

function AdminUserDetail() {
  const { id } = Route.useParams();
  const userId = id as Id<'profiles'>;
  const { isAdmin, userId: viewerId } = useRole();
  const user = useQuery(api.profiles.getAdmin, { userId });
  const grantRole = useMutation(api.admin.grantRole);
  const revokeRole = useMutation(api.admin.revokeRole);

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

      {/* Posting-permission levers (D57) + account lifecycle (D37) — shared with the profile panel. */}
      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Moderation
        </h2>
        <UserModerationControls user={user} />
      </section>

      {/* Role management — admin only, and never on your own row: `grantRole`/`revokeRole` both
          refuse self-targeting so the last admin can't demote themselves out of the app (D37). */}
      {isAdmin && viewerId !== userId ? (
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
