/**
 * Suggestions from other skaters' recent reports on the body (A10 §4.4 / D188): one collapsed line
 * per section — *"2 people said glass earlier today — same?"* — that expands to ghost chips. Ghosts
 * only: nothing here is ever pre-selected, and nothing here is stored until the author taps it,
 * because another skater's observation is a guess about this author's (D188, D56's independence).
 *
 * Pure over the cards the body page already loads (`listByWaterBody`, or the offline report cache),
 * so the sheet asks no new query. The window is the last day: a report from last week is history,
 * not a suggestion about today's ice.
 */

import type { FeedCardData } from './feed';
import { humanizeEnum } from './reportView';
import type { IceType, SkateQuality, Suitability, SurfaceTag } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far back a peer report counts as "recent" for the sheet. */
export const PEER_WINDOW_MS = DAY_MS;

export interface PeerValue<K extends string> {
  key: K;
  /** Distinct reporters who said it, in the window. */
  count: number;
}

export interface PeerSuggestions {
  /** Reports in the window by someone other than the author, after dedup per author. */
  reporters: number;
  iceTypes: PeerValue<IceType>[];
  surfaceTags: PeerValue<SurfaceTag>[];
  quality: PeerValue<SkateQuality>[];
  suitability: PeerValue<Suitability>[];
}

/** What the sheet needs of a card: enough to attribute and to count. */
export type PeerCard = Pick<
  FeedCardData,
  'skateEndTime' | 'iceTypes' | 'surfaceTags' | 'skateQuality' | 'suitability'
> & { author: Pick<FeedCardData['author'], 'username'> };

/**
 * Tally the body's recent reports, one vote per reporter per value (a skater who posted twice
 * today says *glass* once), the author's own excluded by username. Values sort by count, then by
 * first mention.
 */
export function peerSuggestions(
  cards: readonly PeerCard[],
  opts: { now: number; authorUsername?: string; windowMs?: number },
): PeerSuggestions {
  const from = opts.now - (opts.windowMs ?? PEER_WINDOW_MS);
  const recent = cards.filter(
    (c) =>
      c.skateEndTime >= from &&
      c.skateEndTime <= opts.now &&
      c.author.username !== opts.authorUsername,
  );
  const reporters = new Set(recent.map((c) => c.author.username));
  const tally = <K extends string>(pick: (c: PeerCard) => readonly K[]): PeerValue<K>[] => {
    const byKey = new Map<K, Set<string>>();
    for (const c of recent) {
      for (const key of pick(c)) {
        const set = byKey.get(key) ?? new Set<string>();
        set.add(c.author.username);
        byKey.set(key, set);
      }
    }
    return [...byKey.entries()]
      .map(([key, who]) => ({ key, count: who.size }))
      .sort((a, b) => b.count - a.count);
  };
  return {
    reporters: reporters.size,
    iceTypes: tally((c) => c.iceTypes),
    surfaceTags: tally((c) => c.surfaceTags),
    quality: tally((c) => (c.skateQuality === undefined ? [] : [c.skateQuality])),
    suitability: tally((c) => (c.suitability === undefined ? [] : [c.suitability])),
  };
}

/**
 * The collapsed line for a section — *"2 people said black ice, glass earlier today — same?"* —
 * or `null` when nobody said anything the section could offer. Names up to three values; the
 * chips carry the rest. "Earlier today" is the window in words; a 24-hour window reaching into
 * yesterday evening still reads as recent to a skater, and the chips carry no time.
 */
export function peerLine(values: readonly PeerValue<string>[], reporters: number): string | null {
  if (values.length === 0 || reporters === 0) return null;
  const said = values
    .slice(0, 3)
    .map((v) => humanizeEnum(v.key).toLowerCase())
    .join(', ');
  const who = reporters === 1 ? 'Someone' : `${reporters} people`;
  return `${who} said ${said} earlier today — same?`;
}
