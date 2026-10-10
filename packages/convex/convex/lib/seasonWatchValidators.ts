/**
 * Validators for the season watch (A06i) — shared by `schema.ts` and the functions that write the
 * rows, so a stored shape and an argument shape cannot drift apart.
 */

import { v } from 'convex/values';

/** `SeasonWatchSettings` from `@skating/core`, field for field. Temperatures are °C. */
export const seasonWatchSettings = v.object({
  startMonthDay: v.string(),
  freezeC: v.number(),
  sentinelNights: v.number(),
  corpusFraction: v.number(),
  winterFraction: v.number(),
  imageryNudgeC: v.number(),
  thawC: v.number(),
  thawRunDays: v.number(),
  sampleSize: v.number(),
});

/**
 * A sentinel or a pinned site: the body's id, plus the name and state it had when it was chosen.
 * The snapshot is for display and for a body that has since been purged; the id is what is read.
 */
export const rosterSite = v.object({
  waterBodyId: v.id('waterBodies'),
  name: v.string(),
  state: v.optional(v.string()),
});

/** One site's low on the night a rule fired, named so an email never has to look it up later. */
export const namedSiteLow = v.object({
  waterBodyId: v.optional(v.id('waterBodies')),
  name: v.string(),
  state: v.optional(v.string()),
  lowC: v.number(),
});

/** What the opening night measured: the sentinels that fired, and the ordinary lakes' count. */
export const openingDetail = v.object({
  sentinels: v.array(namedSiteLow),
  corpus: v.object({ frozen: v.number(), reporting: v.number() }),
});

/**
 * One staff email waiting its turn (D212: never two on one day). Each carries what it reports, so
 * the copy is written from what was measured that night rather than re-derived from a rolling
 * 92-day window that may no longer hold it.
 */
export const seasonEmail = v.union(
  v.object({
    kind: v.literal('opened'),
    date: v.string(),
    sentinels: v.array(namedSiteLow),
    corpus: v.object({ frozen: v.number(), reporting: v.number() }),
    /** The notice a reset superseded, so the re-sent email can say what it replaces. */
    replaces: v.optional(v.object({ opensOn: v.string(), detectedAt: v.number() })),
  }),
  v.object({ kind: v.literal('imagery'), date: v.string(), sites: v.array(namedSiteLow) }),
  v.object({
    kind: v.literal('winter'),
    date: v.string(),
    frozen: v.array(namedSiteLow),
    reporting: v.number(),
  }),
  v.object({ kind: v.literal('closed'), date: v.string(), sitesSampled: v.number() }),
);

/**
 * Every field of an `imageryIngestSeasons` row, so the superseded table can hold a row whole.
 * Everything A06i added is optional: the one legacy row predates it (widen → deploy → backfill).
 */
export const seasonRecordFields = {
  season: v.string(), // `winter-YYYY-YY`, D63's July boundary
  /** Observed date the gate opened — from the weather series, not the date we noticed. */
  opensOn: v.string(),
  /** `sentinel` (the summit pond), `corpus` (the region-wide signal), or both on the same day. */
  openedBy: v.array(v.string()),
  /** First date the region itself froze, or `null` if winter had not established yet. */
  winterFrom: v.union(v.string(), v.null()),
  /**
   * Observed date the season closed — `thawRunDays` consecutive days on which every ordinary site
   * went without an overnight freeze (`ingestWindow`'s reluctant ice-out proxy). Absent while the
   * season is still open, which is the normal state from November to roughly May.
   *
   * ⚠ **This is the only "the season is over" signal in the system, and two very different
   * consumers read it**: imagery ingest stops cutting granules, and A06h's corpus-wide weather
   * sweep stops spending Open-Meteo calls. Both want the *same* reluctance — being late costs a
   * few granule reads and a few thousand weather calls, while being early truncates the melt-out
   * record and blinds discovery during the last skateable weeks of the season.
   */
  closesOn: v.optional(v.string()),
  /** When `closesOn` was recorded, so a re-open (it happens; see the module note) is auditable. */
  closedAt: v.optional(v.number()),
  /** How many sites actually returned observations — the honest denominator for `openedBy`. */
  sitesSampled: v.number(),
  detectedAt: v.number(),

  /** Which `seasonWatchSettings` version decided this row, and a copy of it (D213). */
  settingsVersion: v.optional(v.number()),
  settings: v.optional(seasonWatchSettings),
  /** The sentinels watched when it opened — a copy, so a later roster edit cannot rewrite why. */
  sentinels: v.optional(v.array(rosterSite)),
  /** What the opening night measured. */
  opening: v.optional(openingDetail),
  /** The first sentinel night at or below the imagery line, and the sentinels that reached it. */
  imageryNudgeOn: v.optional(v.string()),
  imageryNudgeSites: v.optional(v.array(namedSiteLow)),
  /** The ordinary lakes that froze the night winter set in, out of how many reported. */
  winter: v.optional(v.object({ frozen: v.array(namedSiteLow), reporting: v.number() })),

  /**
   * Staff emails waiting to go, oldest first, and the New York date the last one went (D212). Each
   * carries the settings that decided it: a fact found after the opening is found under that day's
   * settings, not the opening's, and its email has to state the rule that actually fired.
   */
  emailQueue: v.optional(
    v.array(
      v.object({
        email: seasonEmail,
        queuedAt: v.number(),
        settings: v.optional(seasonWatchSettings),
      }),
    ),
  ),
  emailsSent: v.optional(
    v.array(v.object({ kind: v.string(), sentOn: v.string(), sentAt: v.number() })),
  ),
  lastEmailOn: v.optional(v.string()),

  /** Live imagery (D214): who pressed *Start*, when, and whether it is paused. */
  imageryStartedAt: v.optional(v.number()),
  imageryStartedBy: v.optional(v.id('profiles')),
  imageryPausedAt: v.optional(v.number()),
  /** The last day a catalog poll searched through, so the next can start from it. */
  imageryWindowTo: v.optional(v.string()),
};
