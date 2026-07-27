import { api } from '@skating/convex/api';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useState } from 'react';
import { AdminEmpty, AdminPageHeader } from '../components/admin/adminUi';
import { Avatar } from '../components/ProfileView';
import { Badge } from '../components/ui/badge';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

/**
 * User admin search (D37) — find **any** account (private, suspended, banned) by name or @handle, then
 * open the detail page to act. Unlike the member-facing search, this drops the public-only filter
 * (server-gated to moderators).
 */
export const Route = createFileRoute('/admin/users')({ component: AdminUsers });

function statusTone(status: string): 'secondary' | 'destructive' | 'outline' {
  if (status === 'banned' || status === 'suspended') return 'destructive';
  // `deleting` is a finalization in flight (usually seconds; longer only if a stage crashed and is
  // waiting on the hourly sweep to re-drive it), so it reads as the same muted state as `deleted`.
  if (status === 'deleted' || status === 'deleting') return 'outline';
  return 'secondary';
}

function AdminUsers() {
  const [term, setTerm] = useState('');
  const hits = useQuery(api.admin.userSearch, term.trim() ? { query: term.trim() } : 'skip');

  return (
    <div className="flex flex-col gap-4">
      <AdminPageHeader title="Users" subtitle="Search by display name or @handle." />
      <Input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Search users…"
        aria-label="Search users"
      />
      {term.trim() === '' ? (
        <AdminEmpty>Start typing to find a user.</AdminEmpty>
      ) : hits === undefined ? (
        <AdminEmpty>Searching…</AdminEmpty>
      ) : hits.length === 0 ? (
        <AdminEmpty>No users match “{term.trim()}”.</AdminEmpty>
      ) : (
        <div className="flex flex-col gap-2">
          {hits.map((u) => (
            <Link key={u.userId} to="/admin/users/$id" params={{ id: u.userId }}>
              <Card className="transition-colors hover:bg-surface-muted">
                <CardContent className="flex items-center gap-3 py-3">
                  <Avatar displayName={u.displayName} imageUrl={u.profileImageUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-foreground text-sm">{u.displayName}</p>
                    <p className="truncate text-foreground-muted text-xs">@{u.username}</p>
                  </div>
                  {u.role !== 'member' ? <Badge variant="outline">{u.role}</Badge> : null}
                  {u.status !== 'active' ? (
                    <Badge variant={statusTone(u.status)}>{u.status}</Badge>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
