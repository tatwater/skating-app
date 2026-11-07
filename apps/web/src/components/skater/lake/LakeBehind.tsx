import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useQuery } from 'convex/react';

import { useSkaterMapStore } from '@/stores/skaterMapStore';
import { LakeSidebarView } from './LakePage';
import { usePageNav } from './lakeNav';

/**
 * The lake's sidebar under an inset card (boards 2.1–2.9): drawn as the lake page draws it, but
 * inert — no focus, no presses, hidden from assistive tech — while the card's scrim dims it. None
 * of the page's side effects come with it (the map spec, the analytics, Esc stay with `LakePage`).
 * Bare ground until the card's lake is known, and on a phone, where the card fills the screen.
 */
export function LakeBehind({ waterBodyId }: { waterBodyId: string | undefined }) {
  return waterBodyId === undefined ? null : <LoadedBehind waterBodyId={waterBodyId} />;
}

function LoadedBehind({ waterBodyId }: { waterBodyId: string }) {
  const nav = usePageNav();
  const contourCredit = useSkaterMapStore((s) => s.contourCredit);
  const result = useQuery(api.waterBodies.get, { waterBodyId: waterBodyId as Id<'waterBodies'> });
  if (!result?.available) return null;
  return (
    <div inert aria-hidden data-slot="lake-behind" className="absolute inset-0 hidden md:block">
      <LakeSidebarView
        lake={result.body}
        bay={null}
        tab="reports"
        nav={nav}
        contourCredit={contourCredit}
      />
    </div>
  );
}
