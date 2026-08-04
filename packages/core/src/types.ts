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

/** Water body kinds (D4/D14). **Superseded by `WATER_BODY_CLASSES`** — see there. */
export const WATER_BODY_TYPES = [
  'lake',
  'pond',
  'river',
  'stream',
  'reservoir',
  'bay',
  'marsh',
  'other',
] as const;
export type WaterBodyType = (typeof WATER_BODY_TYPES)[number];

/**
 * What kind of water this is — **the vocabulary the three catalogues get mapped into** (N7, D109).
 *
 * Five values, and each one earned its place by being a distinction some source actually draws and
 * some consumer actually needs:
 *
 * | | why it exists |
 * | --- | --- |
 * | `lakePond` | NHD's own class is `LakePond` and 3DHP's is `Lake`; **neither separates a lake from a pond**, and no evidence-based definition does either. The one published attempt ([Richardson et al. 2022](https://www.nature.com/articles/s41598-022-14569-0): < 5 ha, < 5 m, < 30% emergent) would rename 4,283 New England "Ponds" into lakes, Great Pond's 8,520 acres among them. The regional name is the local truth and the limnology is not, so we stopped drawing the line. |
 * | `wetland` | plain English for what NHD calls `SwampMarsh` and OSM spreads across eight `wetland=*` values. **The one class with teeth**: it is the only value `belongsInCorpus` reads, because unnamed wetland is held to a much higher area bar. |
 * | `reservoir` | kept **not** because the catalogues agree — NHD classes 1,717 of our reservoirs as LakePond — but because a reservoir may carry use restrictions, access rules and cleanliness expectations a lake does not. That is a product concern, so the product keeps the class. |
 * | `bay` | an arm of a larger body. Freshwater ones (Alton Bay, North Bay, Melvin Bay) are destinations; tidal ones are not water we cover at all. **A bay must have a parent we also hold** — Half Moon Cove is 0.00 contained in anything and is a wetland despite its name. |
 * | `river` | **a slow river reach, not a lake** — a Maine deadwater, a stillwater, a logan. See below; this is a safety distinction, not a taxonomic one. |
 * | `unclassified` | **the honest name for what used to be `other`.** `other` read as a decided category; it was 55% of the corpus and meant "nobody told us". Naming it accurately is what makes it a prompt for a moderator rather than a bucket that stops being looked at. |
 *
 * ## Why `river` exists, and why it holds so little
 *
 * **It is not "we import rivers now".** Flowing water is still dropped: 4,424 OSM `water=river`
 * polygons and 4,101 3DHP `River` polygons above an acre are refused, exactly as before. `river` holds
 * the narrow case the catalogues get wrong for our purposes — **a reach so slow it is published as a
 * waterbody**. NHD classes all 58 in-region deadwaters, stillwaters and logans as `LakePond`
 * (Debsconeag Deadwater at 537 acres, Nesowadnehunk at 183, Cassidy at 221), because hydrologically
 * that is what they are.
 *
 * **For a skater they are not.** There is current under that ice even when the surface reads as a
 * pond, and thickness varies with it. That is the same reason `reservoir` overrides the catalogue —
 * what matters here is not what USGS classes it as but what it does to a person standing on it — and
 * it is why a name asserting a deadwater outranks a catalogue calling it a lake.
 *
 * **`flow` and `flowage` are deliberately NOT in this class.** An Adirondack Flow is an impoundment
 * behind a dam — Cedar River Flow is NHD's own `Reservoir`, Crooked Brook Flowage is 1,254 acres —
 * and it behaves like a lake everywhere except at the dam. Only the reach words go here.
 *
 * **Migration.** `WATER_BODY_TYPES` above is the stored vocabulary until N7's re-import lands, and is
 * retained so nothing has to change in step with the ETL. `lake` and `pond` both fold into
 * `lakePond`, `marsh` into `wetland`, `other` into `unclassified`; `river` is re-purposed from a value
 * nothing ever wrote, and `stream` disappears.
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

/** Ice-thickness reading trust level (D22) — `estimated` is lower-trust than `measured`. */
export const THICKNESS_METHODS = ['measured', 'estimated'] as const;
export type ThicknessMethod = (typeof THICKNESS_METHODS)[number];

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
 * Conditions AT skate time (D19). Phase 2 stores these as optional **manual** entry
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
 * Canonicalized 2026-07-21 (Phase 9 kickoff): the slash-pairs that used to be *separate* keys collapse
 * to one key each, with the alias living in the display label (`HAZARD_TYPE_LABELS`) rather than in the
 * data — `open_water` absorbs `lead`, `ice_heave` absorbs `buckling`, and `spring_current` replaces
 * both `inlet_outlet_current` and `spring`. Two keys for one hazard could disagree about their own
 * decay tier, and `Record<HazardType, HazardDecay>` could not typecheck against the research table.
 *
 * Ordered by decay tier (A → D) so the table below reads top-to-bottom as volatile → permanent.
 * Evidence for every entry: `plans/phase-9-hazard-research.md`.
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
  // Renamed from `shallow_bay_early_thaw` (D53 amendment, N5c): there is no guarantee the spot is a
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
