import { describe, expect, it } from 'vitest';
import {
  CONDITION_SOURCES,
  HAZARD_TYPES,
  ICE_TYPES,
  PRECIP_TYPES,
  SKATE_QUALITIES,
  SKY_CONDITIONS,
  SURFACE_TAGS,
  THICKNESS_METHODS,
  USER_ROLES,
  USER_STATUSES,
  WATER_BODY_TYPES,
} from './types';

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
    ]);
  });

  it('thickness methods match the confirmed list', () => {
    expect([...THICKNESS_METHODS]).toEqual(['measured', 'estimated']);
  });

  it('conditions vocab matches the confirmed lists (D19)', () => {
    expect([...SKY_CONDITIONS]).toEqual(['clear', 'partly_cloudy', 'overcast', 'precip']);
    expect([...PRECIP_TYPES]).toEqual(['none', 'rain', 'snow', 'sleet']);
    expect([...CONDITION_SOURCES]).toEqual(['user', 'openmeteo']);
  });

  it('surface tags match the confirmed list', () => {
    expect([...SURFACE_TAGS]).toEqual([
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
    ]);
  });

  // Canonicalized 2026-07-21 (Phase 9): slash-pairs collapsed to one key each (`lead` → `open_water`,
  // `buckling` → `ice_heave`, `inlet_outlet_current`/`spring` → `spring_current`) and the research
  // taxonomy added. Ordered by decay tier. See plans/06-data-model.md + phase-9-hazard-research.md.
  it('hazard types match the confirmed list', () => {
    expect([...HAZARD_TYPES]).toEqual([
      'open_water',
      'thin_ice',
      'overflow_slush',
      'drain_hole',
      'wind_hole',
      'slush_hole',
      'thawed_rotten',
      'ridge_crossing',
      'wet_crack',
      'drilled_hole',
      'shell_area',
      'pressure_ridge',
      'ice_heave',
      'spring_current',
      'gas_hole',
      'reef_hole',
    ]);
  });

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
    ]);
  });

  it('roles and statuses match the account model (D37/D33)', () => {
    expect([...USER_ROLES]).toEqual(['member', 'moderator', 'admin']);
    expect([...USER_STATUSES]).toEqual(['active', 'suspended', 'banned', 'deleted']);
    expect([...SKATE_QUALITIES]).toEqual(['great', 'good', 'fair', 'poor']);
  });
});
