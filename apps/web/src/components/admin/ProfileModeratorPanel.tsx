import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { Link } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { useRole } from '../../lib/useRole';
import { buttonVariants } from '../ui/button';
import { UserModerationControls } from './UserModerationControls';

/**
 * In-context moderator panel on a public profile (D37) — act from where you are rather than hunting for
 * the user in a queue. Renders the shared posting-permission + lifecycle controls (same server-gated
 * mutations as the `/admin` tree) plus a link to the full detail page. Null for non-moderators and for
 * your own profile. The raw trust number stays on the detail page (admin-only, D50).
 */
export function ProfileModeratorPanel({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { canModerate } = useRole();
  const user = useQuery(
    api.profiles.getAdmin,
    canModerate && !isSelf ? { userId: userId as Id<'profiles'> } : 'skip',
  );

  if (!canModerate || isSelf || !user) return null;

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-2 py-4">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-foreground-muted text-xs uppercase tracking-widest">
          Moderator tools
        </h2>
        <Link
          to="/admin/users/$id"
          params={{ id: userId }}
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Full detail →
        </Link>
      </div>
      <UserModerationControls user={user} />
    </section>
  );
}
