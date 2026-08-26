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
  loadArchiveSeason,
  loadFrameStats,
  loadSeasonIndex,
  type SeasonIndex,
  statsLookup,
  type TimelineBody,
} from '@skating/core';
import { useEffect, useMemo, useState } from 'react';
import { env } from '../lib/env';

export interface FreezeUpTimeline {
  /** `null` until the season index has landed, or where the archive is not configured at all. */
  timeline: BodyTimeline | null;
  /** True while anything is still in flight — the index, or a manifest that would sharpen a stop. */
  loading: boolean;
  /** The season being shown, per D149's pointer. */
  season: string | null;
  /**
   * The archive is configured but could not be read.
   *
   * ⚠ **Distinct from "no timeline yet", and the difference is what a client may say.** A read that
   * failed is a fact about the *archive* — a bad base URL, a bucket without CORS, a network that
   * dropped — and never a fact about the lake. Kept separate so no caller can collapse them back
   * into a claim about water.
   */
  error: boolean;
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
  const [error, setError] = useState(false);
  // Bumped as each manifest lands, to force a recompute against a fuller cache. The stats live in
  // the module cache, so this is a "something changed" signal rather than state — but it is also the
  // memo key below, because a cache read is invisible to React and nothing else would invalidate.
  const [statsVersion, setStatsVersion] = useState(0);

  // The season and its index are per-archive, not per-lake, so this runs once and every subsequent
  // lake reuses it.
  useEffect(() => {
    if (!enabled || !baseUrl) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setError(false);
      const resolved = await loadArchiveSeason(baseUrl);
      if (cancelled) return;
      if (!resolved) {
        setError(true);
        setLoading(false);
        return;
      }
      const loaded = await loadSeasonIndex(baseUrl, resolved);
      if (cancelled) return;
      setSeason(resolved);
      setIndex(loaded);
      setError(loaded === null);
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
    // ⚠ **Clear it, never just skip.** A previous lake's manifest loop is cancelled mid-flight by
    // this effect re-running, so its own `setLoading(false)` never lands — and a bare `return` here
    // left `loading` stuck true forever. The scrubber then showed "Loading the freeze-up timeline…"
    // in place of "No satellite passes recorded over this lake this season", which is the one claim
    // it is allowed to make about a lake no pass ever cut.
    if (candidates.length === 0) {
      setLoading(false);
      return;
    }

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

  // ⚠ **Memoised, and the manifest counter is what invalidates it.** Rebuilt on every render this
  // folded ~4,900 index entries and ran a point-in-polygon per frame each time the map moved — and,
  // worse, handed back a fresh `stops` array, which made every consumer's `useMemo`/effect deps
  // change on renders that had nothing to do with the archive (the frame prefetch aborted and
  // restarted, the auto-select effect re-ran). `statsVersion` is bumped as each manifest lands, so
  // the progressive upgrade still happens — it just no longer happens for free.
  // `statsVersion` is the invalidation key for a module-level cache the analyser cannot see, and
  // `baseUrl` is what `statsLookup` composes its keys from — neither is inferable from the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above.
  const timeline = useMemo(
    () =>
      index && body
        ? buildBodyTimeline(index, body, {
            band,
            stats: season ? statsLookup(baseUrl, season) : undefined,
          })
        : null,
    [index, body, band, season, baseUrl, statsVersion],
  );

  return { timeline, loading, season, index, error };
}
