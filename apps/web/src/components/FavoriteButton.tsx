import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar as faStarOutline } from '@fortawesome/sharp-light-svg-icons';
import { faStar as faStarSolid } from '@fortawesome/sharp-solid-svg-icons';
import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { useMutation, useQuery } from 'convex/react';
import { Button } from './ui/button';

/**
 * Favorite toggle (Phase 4, decision #1) — the place-based curation heart. Favoriting a lake makes its
 * reports notify by default, boost + badge in the feed, and highlight on the map. Optimistic-feeling
 * via the reactive `isFavorite` query; signed-out users see a disabled prompt (the mutation requires
 * auth). Compact `icon` variant for the map/drawer header; a labelled variant for a favorites list.
 *
 * Filled star = favorited, outline star = not — the same solid/regular pair mobile's `FavoriteButton`
 * uses, so a skater who moves between the two surfaces sees one control, not two.
 */
export function FavoriteButton({
  waterBodyId,
  showLabel = false,
}: {
  waterBodyId: Id<'waterBodies'>;
  showLabel?: boolean;
}) {
  const favorited = useQuery(api.waterBodyFavorites.isFavorite, { waterBodyId });
  const toggle = useMutation(api.waterBodyFavorites.toggle);
  const isFav = favorited === true;

  return (
    <Button
      type="button"
      variant={isFav ? 'secondary' : 'outline'}
      size={showLabel ? 'sm' : 'icon'}
      aria-pressed={isFav}
      aria-label={isFav ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => void toggle({ waterBodyId })}
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
