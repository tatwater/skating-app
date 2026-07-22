import { hazardColorExpression } from '@skating/core';
import { describe, expect, it } from 'vitest';
import { HAZARD_PALETTE } from './hazardMap';

/**
 * The layer transforms themselves are tested in `@skating/core` (`hazardLayer.test.ts`), shared with
 * mobile. What's web-specific — and worth pinning here — is that the design tokens still resolve to a
 * usable, legible palette in both themes.
 */
describe('hazardColorExpression', () => {
  // Order matters: a passage marker is checked first, so `ridge_crossing` can never fall through to
  // the danger colour — "⚠" on a way *across* a ridge would be actively wrong (research §4).
  it('resolves passage before healing before danger', () => {
    const expr = hazardColorExpression(HAZARD_PALETTE.white);
    expect(expr).toEqual([
      'case',
      ['get', 'passage'],
      HAZARD_PALETTE.white.passage,
      ['get', 'healing'],
      HAZARD_PALETTE.white.healing,
      HAZARD_PALETTE.white.danger,
    ]);
  });

  // Danger / healing / passage mean three different things to someone standing on ice, so they must
  // never resolve to the same colour in either theme (D34).
  it('keeps danger, healing and passage visually distinct in both themes', () => {
    for (const palette of [HAZARD_PALETTE.white, HAZARD_PALETTE.dark]) {
      const { danger, healing, passage } = palette;
      expect(new Set([danger, healing, passage]).size).toBe(3);
    }
  });
});
