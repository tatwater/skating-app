import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatSeason } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect } from 'react';
import { useMapSelection } from './MapSelectionContext';

/**
 * The season jump control (D63) — *This season · '25/'26 · '24/'25 …* — on one lake, never globally.
 *
 * **Why it's here and not on the map's chrome.** Browsing a past season is a curiosity ("what was this
 * bay like in December?"), not a safety surface. It belongs where you're already asking about one lake
 * and nowhere near the map's default state, which is always **this** season.
 *
 * **It governs the whole lake view** — the report list, the hazard pins and the aggregate tracks —
 * which is why the selection goes through `MapSelectionContext` rather than staying local: two of the
 * three things it changes are drawn by the map, and a control that moved the list to last December
 * while leaving this winter's ice on screen would put two seasons on one screen.
 *
 * **It is not the "show older" toggle**, and the two must never collapse into one control. "Show
 * older" answers *has anyone verified this lately?*; this answers *what did this lake look like last
 * winter?*. Conflating them would make the first silently mean the second come July.
 */
export function SeasonFilter({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const { browseSeason, setBrowseSeason } = useMapSelection();
  const options = useQuery(api.reports.seasonsForBody, { waterBodyId });

  // Reset to this season whenever the lake changes or the drawer closes. Carrying a past season
  // across lakes would silently answer a question nobody asked on the next lake — and worse, the map
  // is shared, so it would still be showing '24/'25 hazards under a lake you just opened.
  // `waterBodyId` is the point of this effect rather than an input to its body: the reset has to
  // re-run when the lake changes, and dropping it carries a past season onto the next lake you open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on the lake, not on the body's reads.
  useEffect(() => {
    setBrowseSeason(null);
    return () => setBrowseSeason(null);
  }, [waterBodyId, setBrowseSeason]);

  // One season means one option: this one. A control with nothing to switch to is noise.
  if (!options || options.seasons.length <= 1) return null;

  return (
    <label className="flex items-center gap-2 text-foreground-muted text-xs">
      <span>Season</span>
      <select
        className="rounded-md border border-border bg-surface px-2 py-1"
        value={browseSeason ?? ''}
        onChange={(e) => setBrowseSeason(e.target.value === '' ? null : Number(e.target.value))}
        aria-label="Show a past season on this lake"
      >
        <option value="">This season</option>
        {options.seasons
          .filter((s) => s !== options.current)
          .map((season) => (
            <option key={season} value={season}>
              {formatSeason(season)}
            </option>
          ))}
      </select>
    </label>
  );
}

/**
 * What the lake says when a season has nothing in it — including, every July, this one.
 *
 * The reset is correct and it will read as a bug unless the empty state says which season is empty
 * and points at the way back. There is no announcement anywhere else; this line is it.
 */
export function SeasonEmptyState({
  browseSeason,
  currentSeason,
}: {
  browseSeason: number | null;
  currentSeason: number | undefined;
}) {
  if (browseSeason !== null) {
    return (
      <p className="text-foreground-muted text-sm">
        Nothing was reported here in {formatSeason(browseSeason)}.
      </p>
    );
  }
  return (
    <p className="text-foreground-muted text-sm">
      No reports yet
      {currentSeason === undefined ? '' : ` this ${formatSeason(currentSeason)} season`} — be the
      first to say how it skates. Past seasons are under the season menu.
    </p>
  );
}
