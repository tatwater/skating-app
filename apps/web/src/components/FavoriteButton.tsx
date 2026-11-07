import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar as faStarOutline } from '@fortawesome/sharp-light-svg-icons';
import { faStar as faStarSolid } from '@fortawesome/sharp-solid-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { useAnalytics } from '../lib/analytics';
import { Button } from './ui/button';

/**
 * Favorite toggle (Phase 04, decision #1) — the place-based curation heart. Favoriting a lake makes its
 * reports notify by default, boost + badge in the feed, and highlight on the map. Optimistic-feeling
 * via the reactive `isFavorite` query; signed-out users see a disabled prompt (the mutation requires
 * auth). Compact `icon` variant for the map/drawer header; a labeled variant for a favorites list.
 *
 * Filled star = favorited, outline star = not — the same solid/regular pair mobile's `FavoriteButton`
 * uses, so a skater who moves between the two surfaces sees one control, not two.
 */
export function FavoriteButton({
  waterBodyId,
  subAreaId,
  showLabel = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  /** A bay's own heart (A09): favorites the bay, not the lake. The lake keeps its own button. */
  subAreaId?: Id<'waterBodySubAreas'>;
  showLabel?: boolean;
}) {
  const analytics = useAnalytics();
  const target = { waterBodyId, ...(subAreaId !== undefined ? { subAreaId } : {}) };
  const favorited = useQuery(api.waterBodyFavorites.isFavorite, target);
  const toggle = useMutation(api.waterBodyFavorites.toggle);
  const isFav = favorited === true;

  // Awaits the toggle before recording, so a mutation that fails records nothing — and names the
  // event from the mutation's **own** post-state rather than from `isFav`.
  //
  // `isFav` is this render's value, and the button is only disabled while the query is undefined
  // (first load). Two taps before the reactive query catches up therefore both read the same stale
  // `isFav` and would record two `water_body_favorited`s for a favorite-then-unfavorite — inflating
  // exactly the saved-place demand figure this event exists to measure. The server's return value
  // is never stale.
  const onToggle = async () => {
    const { favorited: nowFavorited } = await toggle(target);
    analytics.capture(nowFavorited ? 'water_body_favorited' : 'water_body_unfavorited', {
      target_type: subAreaId === undefined ? 'water_body' : 'sub_area',
    });
  };

  return (
    <Button
      type="button"
      variant={isFav ? 'secondary' : 'outline'}
      size={showLabel ? 'sm' : 'icon'}
      aria-pressed={isFav}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => {
        // A refused toggle is swallowed on purpose. `void toggle(target)` here previously left the
        // rejection unhandled, which both Sentry and PostHog's exception capture report as an app
        // error — and the common refusal is the expected one (`Water body not found` for a body
        // taken down since this view loaded), not a bug. The star needs no rollback either: the
        // reactive `isFavorite` query is the source of truth, so it simply stays where it was.
        void onToggle().catch(() => {});
      }}
      disabled={favorited === undefined}
    >
      <FontAwesomeIcon
        icon={isFav ? faStarSolid : faStarOutline}
        aria-hidden
        className={isFav ? 'text-primary' : ''}
      />
      {showLabel ? <span>{isFav ? 'Favorited' : 'Favorite'}</span> : null}
    </Button>
  );
}
