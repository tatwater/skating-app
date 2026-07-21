/**
 * Shared domain enums/types, mirroring the data model in
 * `plans/06-data-model.md`. Declared as `as const` tuples so both the runtime
 * array (for validation / UI lists) and the literal-union type are available.
 */

// Reports have no visibility field — every report is public (D13). The only privacy switch is the
// profile's discoverability, below.

/** Profile discoverability (D13): `public` = searchable + browsable; `private` = neither. */
export const PROFILE_VISIBILITIES = ['public', 'private'] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number]

/** Account roles; admin ⊇ moderator (D37). */
export const USER_ROLES = ['member', 'moderator', 'admin'] as const
export type UserRole = (typeof USER_ROLES)[number]

/** Account lifecycle state (D33/D37). */
export const USER_STATUSES = ['active', 'suspended', 'banned', 'deleted'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/** Water body kinds (D4/D14). */
export const WATER_BODY_TYPES = [
  'lake',
  'pond',
  'river',
  'stream',
  'reservoir',
  'bay',
  'marsh',
  'other',
] as const
export type WaterBodyType = (typeof WATER_BODY_TYPES)[number]

/** Coarse overall skating quality (D23) — never a safety verdict (D3). */
export const SKATE_QUALITIES = ['great', 'good', 'fair', 'poor'] as const
export type SkateQuality = (typeof SKATE_QUALITIES)[number]

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
] as const
export type IceType = (typeof ICE_TYPES)[number]

/** Ice-thickness reading trust level (D22) — `estimated` is lower-trust than `measured`. */
export const THICKNESS_METHODS = ['measured', 'estimated'] as const
export type ThicknessMethod = (typeof THICKNESS_METHODS)[number]

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
] as const
export type SurfaceTag = (typeof SURFACE_TAGS)[number]

/**
 * Conditions AT skate time (D19). Phase 2 stores these as optional **manual** entry
 * (`source: 'user'`); Open-Meteo auto-fill (`source: 'openmeteo'`) arrives in Phase 10.
 */
export const SKY_CONDITIONS = ['clear', 'partly_cloudy', 'overcast', 'precip'] as const
export type SkyCondition = (typeof SKY_CONDITIONS)[number]
export const PRECIP_TYPES = ['none', 'rain', 'snow', 'sleet'] as const
export type PrecipType = (typeof PRECIP_TYPES)[number]
export const CONDITION_SOURCES = ['user', 'openmeteo'] as const
export type ConditionSource = (typeof CONDITION_SOURCES)[number]

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
] as const
export type HazardType = (typeof HAZARD_TYPES)[number]

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
}

/**
 * The three types that account for ~80% of real hazard mentions in the regional corpus (research §6) —
 * surfaced as one-tap presets, with everything else behind "more".
 */
export const HAZARD_TYPE_PRESETS = ['open_water', 'pressure_ridge', 'thin_ice'] as const

/**
 * `ridge_crossing` is a **passage marker, not a danger** (D51 research §4): it marks where a pressure
 * ridge was crossable. It reuses the hazard machinery (geometry, decay, confirm loop) but must never
 * render as a danger halo or fire a "hazard ahead" alert — see `hazardCopy.ts` for its relabeled
 * verdicts and `hazardProximity.ts` for its exclusion from warnings.
 */
export function isPassageMarker(type: HazardType): boolean {
  return type === 'ridge_crossing'
}
