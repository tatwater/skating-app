/**
 * Shared domain enums/types, mirroring the data model in
 * `plans/06-data-model.md`. Declared as `as const` tuples so both the runtime
 * array (for validation / UI lists) and the literal-union type are available.
 */

/** Per-report visibility levels (D13). Ordered narrowest → widest. */
export const VISIBILITY_LEVELS = ['just_me', 'friends', 'followers', 'public'] as const
export type Visibility = (typeof VISIBILITY_LEVELS)[number]

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

/** Localized hazards that drive the lifecycle (D15). */
export const HAZARD_TYPES = [
  'open_water',
  'lead',
  'thin_ice',
  'pressure_ridge',
  'wet_crack',
  'overflow_slush',
  'ice_heave',
  'buckling',
  'drilled_hole',
  'inlet_outlet_current',
  'spring',
  'shell_area',
] as const
export type HazardType = (typeof HAZARD_TYPES)[number]
