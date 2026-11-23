import {
  type FeedSection,
  feedSectionForTime,
  feedSectionRank,
  groupFeedSections,
  type PostCardData,
  withoutRecommended,
} from './feed';
import { type BodyResultData, interleaveLatest, type LatestItem } from './weatherDiscovery';

/** One row of Latest: a Post, or a lake the weather filter matched (D165). */
export type LatestRow = LatestItem<PostCardData>;

/**
 * The most favorite Posts lifted per recency section (D292): what `posts.listFavoritePosts`
 * returns per section, and the cap {@link carryFavorites} reads to tell a favorite pushed out by a
 * newer one from one that left.
 */
export const FAVORITE_LIFT_PER_SECTION = 5;

const sectionRankAt = (t: number, now: number) => feedSectionRank(feedSectionForTime(t, now).key);

/** A Post shows a favorite member: what lifts it, after the recommended strip took its own. */
const showsFavorite = (post: PostCardData) => post.reports.some((r) => r.isFavorite === true);

/**
 * The up-front favorites to lift this render: the server's current set, plus any from the previous
 * render it dropped only because a newer favorite filled that section's cap (D292). Without the
 * carry, a favorite already drawn at the top of its section would vanish while the reader looked at
 * it, until its page arrived. A favorite is carried only while its section is full, it is older than
 * every current favorite there, and the pages haven't reached its time. One that left for any other
 * reason (hidden, unfavorited, filtered out) is gone at once, and once the pages cover its time the
 * pages are the truth. Pure, and idempotent for the same inputs.
 */
export function carryFavorites(
  previous: readonly PostCardData[],
  current: readonly PostCardData[],
  posts: readonly PostCardData[],
  exhausted: boolean,
  now: number,
): PostCardData[] {
  const last = posts[posts.length - 1];
  if (exhausted || previous.length === 0) return [...current];
  const inCurrent = new Set(current.map((p) => p.postId));
  const loaded = new Set(posts.map((p) => p.postId));
  const kept = [...current];
  for (const fav of previous) {
    if (inCurrent.has(fav.postId) || loaded.has(fav.postId)) continue;
    if (last !== undefined && fav.latestSkateEndTime >= last.latestSkateEndTime) continue;
    const rank = sectionRankAt(fav.latestSkateEndTime, now);
    const peers = current.filter((p) => sectionRankAt(p.latestSkateEndTime, now) === rank);
    if (peers.length < FAVORITE_LIFT_PER_SECTION) continue;
    if (peers.some((p) => p.latestSkateEndTime <= fav.latestSkateEndTime)) continue;
    kept.push(fav);
  }
  return kept.sort((a, b) => b.latestSkateEndTime - a.latestSkateEndTime);
}

export interface LatestFeedInput {
  /** The paginated feed (`posts.listFeed`), newest first. */
  posts: readonly PostCardData[];
  /**
   * The viewer's favorite Posts read up front (`posts.listFavoritePosts`), newest first: the only
   * Posts lifted to the top of their section. Empty for a list that promises newest first.
   */
  favorites: readonly PostCardData[];
  /** The lakes the weather filter matched (`weatherDiscovery.listBodyResults`), newest first. */
  bodies: readonly BodyResultData[];
  /** The pages are all read. */
  exhausted: boolean;
  now: number;
  /** Reports the recommended strip already shows (D50): out of the feed, so none shows twice. */
  recommendedIds: ReadonlySet<string>;
  /** Lift favorites at all. Off for a list whose line says "newest first" (search, one skater). */
  lift: boolean;
}

/**
 * Latest's sections, for web and mobile alike (D292): the paginated Posts with the matched lakes
 * slotted in by time (`interleaveLatest`), the recommended reports taken out, and the viewer's
 * favorites leading each recency section.
 *
 * **Only a favorite known before its section draws is lifted.** A favorite paged in later would
 * land at the top of a section the reader had already scrolled past, unseen, so the lifted set is
 * what the up-front read returned (`favorites`), each admitted once the scroll reaches its section
 * (the oldest loaded Post's section and every newer one). A favorite Post outside that set keeps
 * its time slot and its star. A matched lake is in the lake list from the start, so a favorite lake
 * is admitted the same way, ahead of the time floor that holds the other lakes back. A Post is
 * lifted only while a member it still shows is a favorite: one whose favorite member went to the
 * recommended strip is not.
 */
export function latestFeedSections(input: LatestFeedInput): FeedSection<LatestRow>[] {
  const { posts, favorites, bodies, exhausted, now, recommendedIds, lift } = input;
  const shown = withoutRecommended(posts, recommendedIds);
  // The matched lakes' time floor comes from the paginated Posts alone: a favorite admitted below
  // it must not let older lakes in ahead of the pages.
  const rows: LatestRow[] = interleaveLatest(shown, (p) => p.latestSkateEndTime, bodies, exhausted);
  const rankOf = (t: number) => sectionRankAt(t, now);
  const last = posts[posts.length - 1];
  const reached = exhausted
    ? Number.POSITIVE_INFINITY
    : last === undefined
      ? -1
      : rankOf(last.latestSkateEndTime);

  const lifted = new Set<string>();
  if (lift) {
    const loaded = new Set(shown.map((p) => p.postId));
    const seenBodies = new Set(
      rows.flatMap((r) => (r.kind === 'body' ? [r.data.waterBodyId] : [])),
    );
    for (const fav of withoutRecommended(favorites, recommendedIds)) {
      // One whose favorite member is in the recommended strip is an ordinary Post now: it waits
      // for its page, in its time slot.
      if (!showsFavorite(fav) || rankOf(fav.latestSkateEndTime) > reached) continue;
      lifted.add(fav.postId);
      if (!loaded.has(fav.postId)) rows.push({ kind: 'report', data: fav });
    }
    for (const body of bodies) {
      if (!body.isFavorite || seenBodies.has(body.waterBodyId)) continue;
      if (rankOf(body.eventMs) <= reached) rows.push({ kind: 'body', data: body });
    }
  }
  const time = (row: LatestRow) =>
    row.kind === 'report' ? row.data.latestSkateEndTime : row.data.eventMs;
  // Stable, so the interleave's order holds wherever times tie.
  rows.sort((a, b) => time(b) - time(a));
  return groupFeedSections(
    rows,
    time,
    now,
    (row) =>
      lift &&
      (row.kind === 'report'
        ? lifted.has(row.data.postId) && showsFavorite(row.data)
        : row.data.isFavorite),
  );
}
