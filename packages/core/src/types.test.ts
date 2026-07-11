import { describe, expect, it } from 'vitest'
import {
  HAZARD_TYPES,
  ICE_TYPES,
  SKATE_QUALITIES,
  SURFACE_TAGS,
  USER_ROLES,
  USER_STATUSES,
  VISIBILITY_LEVELS,
  WATER_BODY_TYPES,
} from './types'

/**
 * Locks the shared vocabulary to the **confirmed** community/official terms
 * (06-data-model.md "VOCABULARY CONFIRMED"). These arrays are single-sourced into the
 * Convex schema, so a typo (`blak_ice`) or a silent drop would otherwise ship unnoticed
 * — top-level `as const` arrays report as "covered" merely by being imported. This test
 * pins the exact sets; changing vocabulary must be a deliberate edit here + in the doc.
 */
describe('shared vocabulary (06-data-model.md, confirmed terms)', () => {
  it('ice types match the confirmed list', () => {
    expect([...ICE_TYPES]).toEqual([
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
    ])
  })

  it('surface tags match the confirmed list', () => {
    expect([...SURFACE_TAGS]).toEqual([
      'glass',
      'smooth',
      'rough',
      'bumpy',
      'rubble',
      'cracked_surface',
      'snow_covered',
      'drifted',
      'slushy',
      'wet',
      'overflow',
      'frozen_chop',
      'windswept',
    ])
  })

  it('hazard types match the confirmed list', () => {
    expect([...HAZARD_TYPES]).toEqual([
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
    ])
  })

  it('water-body types match the confirmed list', () => {
    expect([...WATER_BODY_TYPES]).toEqual([
      'lake',
      'pond',
      'river',
      'stream',
      'reservoir',
      'bay',
      'marsh',
      'other',
    ])
  })

  it('visibility levels are ordered narrowest → widest (D13)', () => {
    expect([...VISIBILITY_LEVELS]).toEqual(['just_me', 'friends', 'followers', 'public'])
  })

  it('roles and statuses match the account model (D37/D33)', () => {
    expect([...USER_ROLES]).toEqual(['member', 'moderator', 'admin'])
    expect([...USER_STATUSES]).toEqual(['active', 'suspended', 'banned', 'deleted'])
    expect([...SKATE_QUALITIES]).toEqual(['great', 'good', 'fair', 'poor'])
  })
})
