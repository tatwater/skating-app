import { useAuth } from '@clerk/tanstack-react-start';
import { api } from '@skating/convex/api';
import { corpusCountLines } from '@skating/core';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { useQuery } from 'convex/react';
import { SkaterShell } from '../components/skater/SkaterShell';
import { AboutView } from '../components/skater/settings/AboutView';

/**
 * About + the license disclosure (D43; boards 7.16, 7.17). Public, so it sits **outside** the
 * skater layout: signed in, it mounts the skater shell itself (under the top bar); signed out it's
 * bare but for the logo and the way in. Final legal wording remains Q10.
 */
export const Route = createFileRoute('/about')({ component: AboutPage });

export function AboutPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const stats = useQuery(api.regionStats.list, {});
  const view = (
    <AboutView
      signedIn={isSignedIn === true}
      counts={stats === undefined ? undefined : corpusCountLines(stats)}
      onNavigate={(href) => router.history.push(href)}
    />
  );
  return isSignedIn ? <SkaterShell sheetHost={false}>{view}</SkaterShell> : view;
}
