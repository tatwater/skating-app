/**
 * One lake's freeze-up timeline, loaded progressively (N6e §C4).
 *
 * ## Why this renders before it has finished loading
 *
 * Three round trips separate a cold tab from an exact timeline: the season pointer, the season index,
 * then a manifest for each frame that covers this lake. Waiting for all of them would leave the
 * drawer empty for the length of the slowest fetch, on a control whose whole job is to look
 * scrubbable.
 *
 * So the hook publishes a timeline as soon as the *index* lands — coverage inferred from footprints,
 * which `buildBodyTimeline` marks as such — and republishes as manifests arrive and upgrade those
 * stops to `'measured'`. The stops that change are the ones a footprint got wrong: a pass covering
 * half a lake appears, a pass that never cut this body disappears.
 *
 * ⚠ **That means the stop list can shrink under the user**, which is worth knowing before it is
 * observed as a bug. It is bounded and it settles: only frames whose footprint reached the lake are
 * ever fetched, so an exact pass can only remove frames that were never going to render anything.
 */

import {
  type BodyTimeline,
  buildBodyTimeline,
  candidateFramesFor,
  type SeasonIndex,
  type TimelineBody,
} from '@skating/core';
import { useEffect, useState } from 'react';
import { env } from '../lib/env';
import {
  loadArchiveSeason,
  loadFrameStats,
  loadSeasonIndex,
  statsLookup,
} from '../lib/freezeUpArchive';

export interface FreezeUpTimeline {
  /** `null` until the season index has landed, or where the archive is not configured at all. */
  timeline: BodyTimeline | null;
  /** True while anything is still in flight — the index, or a manifest that would sharpen a stop. */
  loading: boolean;
  /** The season being shown, per D149's pointer. */
  season: string | null;
  /**
   * The season's table of contents, once it has landed.
   *
   * Exposed because a band selector must be built from what this season *published* rather than a
   * hardcoded list — the archive's bands have changed twice already. See `bandsIn`.
   */
  index: SeasonIndex | null;
}

/**
 * Load the timeline for one body and one band.
 *
 * `enabled` exists so the drawer can mount this hook unconditionally and still not fetch an archive
 * for a lake nobody has opened — the alternative is a conditional hook, which React forbids.
 */
export function useFreezeUpTimeline({
  body,
  band,
  enabled,
}: {
  body: TimelineBody | null;
  band: string;
  enabled: boolean;
}): FreezeUpTimeline {
  const baseUrl = env.imageryArchiveUrl;
  const [season, setSeason] = useState<string | null>(null);
  const [index, setIndex] = useState<SeasonIndex | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped as each manifest lands, purely to force a re-render against a fuller cache. The value is
  // never read — the stats live in the module cache, so this is a "something changed" signal rather
  // than state, and the recompute below is what turns it into a sharper timeline.
  const [, setStatsVersion] = useState(0);

  // The season and its index are per-archive, not per-lake, so this runs once and every subsequent
  // lake reuses it.
  useEffect(() => {
    if (!enabled || !baseUrl) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      const resolved = await loadArchiveSeason(baseUrl);
      if (cancelled || !resolved) {
        if (!cancelled) setLoading(false);
        return;
      }
      const loaded = await loadSeasonIndex(baseUrl, resolved);
      if (cancelled) return;
      setSeason(resolved);
      setIndex(loaded);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `baseUrl` is not a dependency: Vite inlines `import.meta.env` at build, so it cannot change
    // within a session. Listing it would only assert otherwise.
  }, [enabled]);

  // Manifests, for the frames that actually reach this lake. `candidateFramesFor` is what keeps this
  // from being 4,884 fetches: over a five-state region a given lake sits under a few dozen passes.
  useEffect(() => {
    if (!enabled || !baseUrl || !index || !season || !body) return;
    let cancelled = false;

    const candidates = candidateFramesFor(index, body, { band });
    if (candidates.length === 0) return;

    void (async () => {
      setLoading(true);
      // Sequential rather than a flood: a lake can sit under dozens of passes, and firing them all at
      // once buys nothing on an HTTP/2 connection while making the progressive upgrade jumpy.
      for (const frame of candidates) {
        if (cancelled) return;
        await loadFrameStats(baseUrl, season, frame.granuleId);
        if (cancelled) return;
        setStatsVersion((v) => v + 1);
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, index, season, body, band]);

  const timeline =
    index && body
      ? buildBodyTimeline(index, body, {
          band,
          // Re-read on every render; the version bump above is what makes that happen after a fetch.
          stats: season ? statsLookup(baseUrl, season) : undefined,
        })
      : null;

  return { timeline, loading, season, index };
}
