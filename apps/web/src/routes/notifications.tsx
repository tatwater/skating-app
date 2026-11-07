import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useChromeStore } from '../stores/chromeStore';

/**
 * `/notifications` (D242): the inbox page retired into the top bar's bell. The path keeps working —
 * emails and old links point here — by landing on the map with the bell open. Done on mount rather
 * than in `beforeLoad`, which also runs on the server, where a store write would be every request's.
 */
export const Route = createFileRoute('/notifications')({ component: NotificationsRedirect });

function NotificationsRedirect() {
  const router = useRouter();
  useEffect(() => {
    useChromeStore.getState().setOverlay('notifications');
    router.history.replace('/');
  }, [router]);
  return null;
}
