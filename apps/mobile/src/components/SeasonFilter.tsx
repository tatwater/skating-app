import { api } from '@skating/convex/api';
import type { Id } from '@skating/convex/dataModel';
import { formatSeason } from '@skating/core';
import { useQuery } from 'convex/react';
import { useEffect } from 'react';
import { Paragraph, Text, XStack } from 'tamagui';
import { useMapSelection } from './MapSelectionContext';

/**
 * The season jump control (D63) — chips, like the bay filter beside it, because there are a handful
 * of seasons at most and a tap is cheaper than a modal on a phone someone is holding in a glove.
 *
 * On **one lake**, never globally: browsing a past season is a curiosity ("what was this bay like in
 * December?"), not a safety surface, so it lives where you're already asking about one lake and
 * nowhere near the map's default state.
 *
 * The selection goes through `MapSelectionContext` because it governs the whole lake view — this
 * list, the hazard pins and the aggregate tracks — and the last two are drawn by the map behind this
 * sheet. It is **not** the "show older" toggle: that one answers whether anyone has checked lately,
 * within whatever season is on screen.
 */
export function SeasonFilter({ waterBodyId }: { waterBodyId: Id<'waterBodies'> }) {
  const { browseSeason, setBrowseSeason } = useMapSelection();
  const options = useQuery(api.reports.seasonsForBody, { waterBodyId });

  // Back to this season whenever the lake changes or the sheet closes — the map is shared, so a
  // carried-over season would leave last winter's hazards under a lake you just opened.
  // `waterBodyId` is the point of this effect rather than an input to its body: the reset has to
  // re-run when the lake changes, and dropping it carries a past season onto the next lake you open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on the lake, not on the body's reads.
  useEffect(() => {
    setBrowseSeason(null);
    return () => setBrowseSeason(null);
  }, [waterBodyId, setBrowseSeason]);

  if (!options || options.seasons.length <= 1) return null;
  const chips = [
    { value: null as number | null, label: 'This season' },
    ...options.seasons
      .filter((s) => s !== options.current)
      .map((s) => ({ value: s as number | null, label: formatSeason(s) })),
  ];

  return (
    <XStack gap="$2" flexWrap="wrap">
      {chips.map((chip) => {
        const selected = browseSeason === chip.value;
        return (
          <Text
            key={chip.label}
            accessibilityRole="button"
            accessibilityLabel={`Show ${chip.label} on this lake`}
            accessibilityState={{ selected }}
            onPress={() => setBrowseSeason(chip.value)}
            paddingHorizontal="$2"
            paddingVertical="$1"
            borderRadius="$3"
            borderWidth={1}
            borderColor={selected ? '$primary' : '$border'}
            color={selected ? '$primary' : '$foregroundMuted'}
            fontSize={13}
          >
            {chip.label}
          </Text>
        );
      })}
    </XStack>
  );
}

/**
 * What a lake says when a season has nothing in it — including, every July, this one.
 *
 * The reset is correct and will read as a bug unless the empty state names the season and points at
 * the way back. There is no announcement anywhere else; this line is it.
 */
export function SeasonEmptyState({
  browseSeason,
  currentSeason,
}: {
  browseSeason: number | null;
  currentSeason: number | undefined;
}) {
  return (
    <Paragraph color="$foregroundMuted">
      {browseSeason !== null
        ? `Nothing was reported here in ${formatSeason(browseSeason)}.`
        : `No reports yet${
            currentSeason === undefined ? '' : ` this ${formatSeason(currentSeason)} season`
          } — be the first to say how it skates. Past seasons are in the season chips above.`}
    </Paragraph>
  );
}
