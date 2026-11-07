import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ProfilePage } from '../components/skater/profile/ProfilePage';

/**
 * A skater's page, `/u/$username` (D47; B03 §1.4) — your own included. No search params: block and
 * flag are dialogs, so they're component state. The path carries another person's handle, which is
 * why analytics masks this segment (D240).
 */
export const Route = createFileRoute('/_skater/u/$username')({ component: ProfileRoute });

function ProfileRoute() {
  const { username } = Route.useParams();
  const router = useRouter();
  return <ProfilePage username={username} onNavigate={(href) => router.history.push(href)} />;
}
