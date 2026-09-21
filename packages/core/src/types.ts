/**
 * Shared domain enums/types, mirroring the data model in
 * `plans/06-data-model.md`. Declared as `as const` tuples so both the runtime
 * array (for validation / UI lists) and the literal-union type are available.
 */

// Reports have no visibility field — every report is public (D13). The only privacy switch is the
// profile's discoverability, below.

/** Profile discoverability (D13): `public` = searchable + browsable; `private` = neither. */
export const PROFILE_VISIBILITIES = ['public', 'private'] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/** Account roles; admin ⊇ moderator (D37). */
export const USER_ROLES = ['member', 'moderator', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Account lifecycle state (D33/D37).
 *
 * `deleting` is the finalization lock (PR #29 review), and it is **not** the same thing as "has
 * requested deletion". A pending request gates nothing — that's the whole point of the 30-day window,
 * and it's why the request is its own timestamp field rather than a status. `deleting` is set when the
 * staged job actually starts, and it gates everything: the stages run in separate transactions, so
 * without it a still-active account can write a favorite or connect Strava *after* the pass that
 * erased those tables and have the row outlive its own deletion.
 */
export const USER_STATUSES = ['active', 'suspended', 'banned', 'deleting', 'deleted'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * Water body kinds (D4/D14) — **retired as the stored vocabulary by A07a's D109 amendment.**
 *
 * `waterBodies.type` now stores `WATER_BODY_CLASSES`. This list survives for exactly one job: the
 * backfill that rewrites the rows written before the migration needs to name what it is reading.
 * It is not a validator anywhere any more, nothing produces it, and no UI renders it.
 *
 * **Do not add a value here.** If a distinction is missing, it is missing from `WATER_BODY_CLASSES`.
 */
export const LEGACY_WATER_BODY_TYPES = [
  'lake',
  'pond',
  'river',
  'stream',
  'reservoir',
  'bay',
  'marsh',
  'other',
] as const;
export type LegacyWaterBodyType = (typeof LEGACY_WATER_BODY_TYPES)[number];

/**
 * The one-way map from the retired vocabulary into the stored one (D109 amendment).
 *
 * **`lake` and `pond` both become `lakePond`, and that is the migration's only lossy step** — which
 * is the point rather than a regret: the distinction was never evidence-based, and 4,283 New England
 * "Ponds" would have to be renamed lakes to make it so. `stream` maps to `unclassified` rather than
 * `river` because nothing ever wrote it and `river` now means something specific and narrow (a slow
 * reach, a deadwater), which a stream polygon is not evidence of.
 */
export const LEGACY_TYPE_TO_CLASS: Readonly<Record<LegacyWaterBodyType, WaterBodyClass>> = {
  lake: 'lakePond',
  pond: 'lakePond',
  reservoir: 'reservoir',
  bay: 'bay',
  marsh: 'wetland',
  river: 'river',
  stream: 'unclassified',
  other: 'unclassified',
};

/**
 * What kind of water this is — **the vocabulary the three catalogs get mapped into** (A07a, D109).
 *
 * Five values, and each one earned its place by being a distinction some source actually draws and
 * some consumer actually needs:
 *
 * | | why it exists |
 * | --- | --- |
 * | `lakePond` | NHD's own class is `LakePond` and 3DHP's is `Lake`; **neither separates a lake from a pond**, and no evidence-based definition does either. The one published attempt ([Richardson et al. 2022](https://www.nature.com/articles/s41598-022-14569-0): < 5 ha, < 5 m, < 30% emergent) would rename 4,283 New England "Ponds" into lakes, Great Pond's 8,520 acres among them. The regional name is the local truth and the limnology is not, so we stopped drawing the line. |
 * | `wetland` | plain English for what NHD calls `SwampMarsh` and OSM spreads across eight `wetland=*` values. **The one class with teeth**: it is the only value `belongsInCorpus` reads, because unnamed wetland is held to a much higher area bar. |
 * | `reservoir` | kept **not** because the catalogs agree — NHD classes 1,717 of our reservoirs as LakePond — but because a reservoir may carry use restrictions, access rules and cleanliness expectations a lake does not. That is a product concern, so the product keeps the class. |
 * | `bay` | an arm of a larger body. Freshwater ones (Alton Bay, North Bay, Melvin Bay) are destinations; tidal ones are not water we cover at all. **A bay must have a parent we also hold** — Half Moon Cove is 0.00 contained in anything and is a wetland despite its name. |
 * | `river` | **a slow river reach, not a lake** — a Maine deadwater, a stillwater, a logan. See below; this is a safety distinction, not a taxonomic one. |
 * | `unclassified` | **the honest name for what used to be `other`.** `other` read as a decided category; it was 55% of the corpus and meant "nobody told us". Naming it accurately is what makes it a prompt for a moderator rather than a bucket that stops being looked at. |
 *
 * ## Why `river` exists, and why it holds so little
 *
 * **It is not "we import rivers now".** Flowing water is still dropped: 4,424 OSM `water=river`
 * polygons and 4,101 3DHP `River` polygons above an acre are refused, exactly as before. `river` holds
 * the narrow case the catalogs get wrong for our purposes — **a reach so slow it is published as a
 * waterbody**. NHD classes all 58 in-region deadwaters, stillwaters and logans as `LakePond`
 * (Debsconeag Deadwater at 537 acres, Nesowadnehunk at 183, Cassidy at 221), because hydrologically
 * that is what they are.
 *
 * **For a skater they are not.** There is current under that ice even when the surface reads as a
 * pond, and thickness varies with it. That is the same reason `reservoir` overrides the catalog —
 * what matters here is not what USGS classes it as but what it does to a person standing on it — and
 * it is why a name asserting a deadwater outranks a catalog calling it a lake.
 *
 * **`flow` and `flowage` are deliberately NOT in this class.** An Adirondack Flow is an impoundment
 * behind a dam — Cedar River Flow is NHD's own `Reservoir`, Crooked Brook Flowage is 1,254 acres —
 * and it behaves like a lake everywhere except at the dam. Only the reach words go here.
 *
 * **Migration — done, 2026-08-05 (D109 amendment).** This is the stored vocabulary. `lake` and `pond`
 * both folded into `lakePond`, `marsh` into `wetland`, `other` and `stream` into `unclassified`;
 * `river` was re-purposed from a value nothing ever wrote. The retired list survives as
 * `LEGACY_WATER_BODY_TYPES` for the backfill's benefit and nothing else, with `LEGACY_TYPE_TO_CLASS`
 * as the one-way map.
 *
 * **`unclassified` is not offered to a user.** It is what we say when the catalogs did not tell us,
 * which is a fine thing for a moderator to see and a meaningless thing to ask a skater to pick. See
 * `USER_SELECTABLE_WATER_BODY_CLASSES`.
 */
export const WATER_BODY_CLASSES = [
  'lakePond',
  'wetland',
  'reservoir',
  'bay',
  'river',
  'unclassified',
] as const;
export type WaterBodyClass = (typeof WATER_BODY_CLASSES)[number];

/**
 * What a person is shown for each class.
 *
 * A table rather than `humanizeEnum`, which only swaps underscores and capitalizes a first letter —
 * it renders `lakePond` as "LakePond", and would have done so in five places across web and mobile.
 * The labels are also not just de-camel-cased spellings: **`lakePond` reads "Lake or pond"** because
 * the whole reason the class exists is that we decline to say which, and `unclassified` reads "Water"
 * because a person looking at a lake does not need to be told we have no opinion about it.
 */
export const WATER_BODY_CLASS_LABELS: Readonly<Record<WaterBodyClass, string>> = {
  lakePond: 'Lake or pond',
  wetland: 'Wetland',
  reservoir: 'Reservoir',
  bay: 'Bay',
  river: 'Slow river reach',
  unclassified: 'Water',
};

/**
 * What to call a water body on screen — its name, or "Unnamed water" when it hasn't got one.
 *
 * A great deal of the corpus is nameless: the catalogs carry thousands of ponds no publisher ever
 * labeled, and `name` is a required field storing `''` for every one of them. Rendering that raw
 * gives a heading that is simply absent — a drawer whose title line is blank, a sentence reading
 * "Report on ." — which looks like the page failed to load rather than like the pond has no name.
 *
 * Here rather than in each client because there are four surfaces that need it (both searches, the
 * lake drawer, mobile's new-water prompt) and they were each holding their own copy of the string.
 *
 * **This is a display fallback, never a value.** Nothing derived from it is stored, matched, or
 * searched: a body with no name still has no name, and the day someone names it, this stops showing.
 */
export function waterBodyDisplayName(name: string | undefined): string {
  return name?.trim() ? name : 'Unnamed water';
}

/** The display label for a stored class, falling back to the raw value for an unmigrated row. */
export function waterBodyClassLabel(value: string): string {
  return WATER_BODY_CLASS_LABELS[value as WaterBodyClass] ?? value;
}

/**
 * The classes a person may choose when they draw a body themselves (D37 / Phase 08).
 *
 * **`unclassified` is deliberately absent.** It is the honest answer when *the catalogs* said
 * nothing, and offering it in a picker would invite a skater to select "we don't know" about water
 * they are standing on — which is not a thing they can know on our behalf and not a thing we should
 * record as if they had. Someone who cannot place their water picks the closest class; a moderator
 * fixes it if it matters.
 */
export const USER_SELECTABLE_WATER_BODY_CLASSES = [
  'lakePond',
  'reservoir',
  'bay',
  'river',
  'wetland',
] as const satisfies readonly WaterBodyClass[];

/** Coarse overall skating quality (D23) — never a safety verdict (D3). */
export const SKATE_QUALITIES = ['great', 'good', 'fair', 'poor'] as const;
export type SkateQuality = (typeof SKATE_QUALITIES)[number];

/** What the ice *is* (community vocabulary, D23 / nordicskaters.squarespace.com). */
export const ICE_TYPES = [
  'black_ice',
  'snow_ice',
  'white_ice',
  'gray_ice',
  'shell_ice',
  'sandwich_ice',
  'crust_ice',
  'pack_ice',
  'plate_ice',
  'candled_ice',
] as const;
export type IceType = (typeof ICE_TYPES)[number];

/**
 * Ice-thickness reading trust level (D22, widened in A10 / D195) — `estimated` is lower-trust than
 * `measured`, and `poke` is the community's own lowest rung: a pole-test count that is person- and
 * pole-relative, kept beside the skater's own inch estimate rather than converted into one.
 *
 * `observed_others` was proposed and dropped: whose eyes saw it is `observedFrom`'s job (D191), and
 * "the fishing holes were 4 inches" is `estimated` with a note. **Only `measured` feeds D160's
 * calibration instrument** (`iceCalibration.ts`); `poke` is excluded exactly like `estimated`.
 */
export const THICKNESS_METHODS = ['measured', 'estimated', 'poke'] as const;
export type ThicknessMethod = (typeof THICKNESS_METHODS)[number];

/**
 * The scope of a thickness section (D195): the quick-path chip row asks *everywhere I tested* or
 * *at this spot*; the latter carries a `where` on the reading itself, so the scope is the one bit
 * that says whether the readings characterize the body or a point on it.
 */
export const THICKNESS_SCOPES = ['everywhere_tested', 'at_spot'] as const;
export type ThicknessScope = (typeof THICKNESS_SCOPES)[number];

/**
 * How the author saw the ice (A10 / D191) — provenance the reader sees, never a report *kind*.
 * `on_ice` is the default; `shore` is the corpus's 15% drive-by / scouting reports; `secondhand`
 * is the 9% relayed from someone else, shown so a relayed thickness never reads as the poster's own.
 */
export const OBSERVED_FROM = ['on_ice', 'shore', 'secondhand'] as const;
export type ObservedFrom = (typeof OBSERVED_FROM)[number];

/**
 * Who the ice is for (A10 / D190) — the second axis of *How was it?*, independent of `skateQuality`.
 * **`dont_go` lives here and not at the bottom of the quality scale**: it is a claim about *who*
 * should be out there, which D3 makes first-class, whereas a quality scale with "don't go" at one end
 * would make "great" read as "safe". In display order, most cautious first.
 */
export const SUITABILITIES = [
  'dont_go',
  'experienced_only',
  'not_for_beginners',
  'beginner_friendly',
] as const;
export type Suitability = (typeof SUITABILITIES)[number];

/**
 * What a shore observer saw (A10 / D189 / D191) — the scouting substitute for the ice-or-surface
 * term of the minimum set, because someone on the bank cannot honestly offer a surface chip.
 * **Valid only off the ice** (`observedFrom !== 'on_ice'`); the validator enforces it.
 */
export const SIGHTINGS = ['open', 'skim', 'frozen', 'snow_covered'] as const;
export type Sighting = (typeof SIGHTINGS)[number];

/**
 * How exact `skateEndTime` is (A10 / D192): `gps` from a track, `minute` when the sheet's pinned
 * open-time chip was taken, `half_hour` from the ladder or the picker. **No part-of-day value on
 * purpose** — "afternoon" is vaguer than the answer the freshness sort wants, and the half-hour
 * ladder is nearly as cheap.
 */
export const SKATE_END_PRECISIONS = ['gps', 'minute', 'half_hour'] as const;
export type SkateEndPrecision = (typeof SKATE_END_PRECISIONS)[number];

/**
 * Snow, as the corpus describes it (A10 / D194): coverage first, whether it mattered second, drifts
 * third, and a depth only when someone measured one. Each row is in display order; `coverage` and
 * `drifts` run none → everywhere so a chip row reads as a scale.
 */
export const SNOW_COVERAGES = ['none', 'patches', 'lanes', 'mostly', 'everywhere'] as const;
export type SnowCoverage = (typeof SNOW_COVERAGES)[number];
export const SNOW_IMPEDIMENTS = ['didnt_matter', 'slowed_me', 'avoided_areas'] as const;
export type SnowImpediment = (typeof SNOW_IMPEDIMENTS)[number];
export const SNOW_DRIFTS = ['none', 'avoidable', 'everywhere'] as const;
export type SnowDrift = (typeof SNOW_DRIFTS)[number];

/**
 * The `where` of a located chip or reading (A10 / D193): how much of the scope it covers. `whole`
 * is the plain claim; `mostly` and `patches` qualify it. Composes with a bay, a sector or a point —
 * "patches, north end" is `{ extent: 'patches', sector: 'N' }`.
 */
export const WHERE_EXTENTS = ['whole', 'mostly', 'patches'] as const;
export type WhereExtent = (typeof WHERE_EXTENTS)[number];

/**
 * The compass sectors a `where` may name (A10 / D193, amended 2026-09-21).
 *
 * The **eight wedges plus `middle` partition the outline** — cast from the body's interior point
 * (never `centroid`, which sits on the shoreline for a concave lake — see `fetchOrigin`) and clipped
 * to it; `sectorGeometry.ts` holds the fast-check property. `near_shore` is a ninth value that
 * **overlaps** them: it is a ring, orthogonal to bearing, and a chip at the north end near the bank
 * is honestly both `N` and `near_shore`, so it cannot be in the partition. `middle` rather than
 * "center" (founder, 2026-09-21): center sounds precise, middle just means not-near-shore.
 *
 * `head` and `mouth` are the bay-relative pair — the back of the bay and its seaward opening — and
 * are **valid only with a `subAreaId`**, computed from the bay's mouth line once the chord editor
 * stores one. "Inner / outer", "the back of Malletts" is a locative grammar, not a name.
 */
export const SECTORS = [
  'N',
  'NE',
  'E',
  'SE',
  'S',
  'SW',
  'W',
  'NW',
  'middle',
  'near_shore',
  'head',
  'mouth',
] as const;
export type Sector = (typeof SECTORS)[number];

/** The eight compass wedges — the bearing-derived subset of `SECTORS`, in clockwise order from N. */
export const COMPASS_SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;
export type CompassSector = (typeof COMPASS_SECTORS)[number];

/** The bay-relative sectors — legal only when the `where` also names a `subAreaId`. */
export const BAY_SECTORS = ['head', 'mouth'] as const;
export type BaySector = (typeof BAY_SECTORS)[number];

/** How the ice *skates* (community vocabulary, D23). */
export const SURFACE_TAGS = [
  'glass',
  'smooth',
  'rough',
  'bumpy',
  'orange_peel',
  'rubble',
  'cracked_surface',
  'snow_covered',
  'drifted',
  'slushy',
  'wet',
  'overflow',
  'frozen_chop',
  'windswept',
] as const;
export type SurfaceTag = (typeof SURFACE_TAGS)[number];

/**
 * Conditions AT skate time (D19). Phase 02a stores these as optional **manual** entry
 * (`source: 'user'`); Open-Meteo auto-fill (`source: 'openmeteo'`) arrives in Phase 10.
 */
export const SKY_CONDITIONS = ['clear', 'partly_cloudy', 'overcast', 'precip'] as const;
export type SkyCondition = (typeof SKY_CONDITIONS)[number];
export const PRECIP_TYPES = ['none', 'rain', 'snow', 'sleet'] as const;
export type PrecipType = (typeof PRECIP_TYPES)[number];
export const CONDITION_SOURCES = ['user', 'openmeteo'] as const;
export type ConditionSource = (typeof CONDITION_SOURCES)[number];

/**
 * Localized hazards that drive the lifecycle (D15/D52). **Exactly one per hazard** — per-type decay,
 * geometry-per-type (D51) and the `ridge_crossing` verdict relabeling all need an unambiguous type.
 *
 * Canonicalized 2026-07-21 (Phase 09a kickoff): the slash-pairs that used to be *separate* keys collapse
 * to one key each, with the alias living in the display label (`HAZARD_TYPE_LABELS`) rather than in the
 * data — `open_water` absorbs `lead`, `ice_heave` absorbs `buckling`, and `spring_current` replaces
 * both `inlet_outlet_current` and `spring`. Two keys for one hazard could disagree about their own
 * decay tier, and `Record<HazardType, HazardDecay>` could not typecheck against the research table.
 *
 * Ordered by decay tier (A → D) so the table below reads top-to-bottom as volatile → permanent.
 * Evidence for every entry: `plans/research/hazard-decay-calibration-and-behavior.md`.
 */
export const HAZARD_TYPES = [
  // Tier A — volatile: refreeze/re-open within a day.
  'open_water',
  'thin_ice',
  'overflow_slush',
  'drain_hole',
  'wind_hole',
  'slush_hole',
  // Tier A* — very volatile: same-day information only.
  'thawed_rotten',
  'ridge_crossing',
  // Tier B — semi-persistent: re-skins, but the weak spot lingers days.
  'wet_crack',
  'drilled_hole',
  'shell_area',
  // Tier C — structural: don't heal within a season; often grow.
  'pressure_ridge',
  'ice_heave',
  // Tier D — effectively permanent: `bodyFeatures` candidates (D53).
  'spring_current',
  'gas_hole',
  'reef_hole',
] as const;
export type HazardType = (typeof HAZARD_TYPES)[number];

/**
 * Display labels. The slash-pairs the enum collapsed keep both words here, so a skater still sees the
 * vocabulary they use ("Open water / lead") even though the stored key is singular.
 */
export const HAZARD_TYPE_LABELS: Record<HazardType, string> = {
  open_water: 'Open water / lead',
  thin_ice: 'Thin ice',
  overflow_slush: 'Overflow / slush',
  drain_hole: 'Drain hole',
  wind_hole: 'Wind hole',
  slush_hole: 'Slush / mush hole',
  thawed_rotten: 'Thawed / rotten ice',
  ridge_crossing: 'Ridge crossing',
  wet_crack: 'Wet / working crack',
  drilled_hole: 'Drilled hole',
  shell_area: 'Shell ice',
  pressure_ridge: 'Pressure ridge',
  ice_heave: 'Ice heave / buckling',
  spring_current: 'Spring / inlet-outlet current',
  gas_hole: 'Gas hole',
  reef_hole: 'Reef hole',
};

/**
 * The three types that account for ~80% of real hazard mentions in the regional corpus (research §6) —
 * surfaced as one-tap presets, with everything else behind "more".
 */
export const HAZARD_TYPE_PRESETS = ['open_water', 'pressure_ridge', 'thin_ice'] as const;

/**
 * `ridge_crossing` is a **passage marker, not a danger** (D51 research §4): it marks where a pressure
 * ridge was crossable. It reuses the hazard machinery (geometry, decay, confirm loop) but must never
 * render as a danger halo or fire a "hazard ahead" alert — see `hazardCopy.ts` for its relabeled
 * verdicts and `hazardProximity.ts` for its exclusion from warnings.
 */
export function isPassageMarker(type: HazardType): boolean {
  return type === 'ridge_crossing';
}

/**
 * Persistent, non-decaying known features of a water body (D53) — always shown, never re-marked, no
 * confirmation loop. Moving water at springs, constrictions and bridges is weaker *every* season
 * regardless of cold, and some ridges reform in the same place annually.
 *
 * **Lives here rather than in the backend enums, and that move has a scar behind it.** It was
 * backend-only while the only way to reach one of these was `bodyFeatures.promote`, which takes the
 * type from a hazard. D79 gives moderators a form that authors one directly, which made this the
 * third place needing the list — and a hand-written third copy is precisely how D65's new verdict
 * reached the validator and the schema while a test that iterated "every verdict" went on iterating
 * three. `lib/enums.ts` re-exports it, exactly as it re-exports `HAZARD_VERDICTS`.
 */
export const BODY_FEATURE_TYPES = [
  'spring_current',
  'constriction',
  'bridge_narrows',
  'recurring_pressure_ridge',
  'gas_hole',
  'reef_hole',
  'delta',
  // Renamed from `shallow_bay_early_thaw` (D53 amendment, A05c): there is no guarantee the spot is a
  // bay — it may be an island's lee, a sandbar, a reef or a shallow delta.
  'shallow_early_thaw',
  'other',
] as const;
export type BodyFeatureType = (typeof BODY_FEATURE_TYPES)[number];

/** Display labels, in the vocabulary an operator would use for the thing itself. */
export const BODY_FEATURE_TYPE_LABELS: Record<BodyFeatureType, string> = {
  spring_current: 'Spring / current',
  constriction: 'Constriction',
  bridge_narrows: 'Bridge narrows',
  recurring_pressure_ridge: 'Recurring pressure ridge',
  gas_hole: 'Gas hole',
  reef_hole: 'Reef hole',
  delta: 'Delta',
  shallow_early_thaw: 'Shallow water (early thaw)',
  other: 'Other',
};
