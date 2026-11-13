import { describe, expect, it } from 'vitest';
import { keyEntries, POINT_KEY_LABELS } from './BodyMapMarks';
import {
  adminToken,
  bodyMapPalette,
  LINE_STYLES,
  LIT_STYLE,
  OUTLINE_STYLES,
  tokenVar,
} from './bodyMapPalette';
import { glLayerIds, glLayers, LINE_SOURCE, OUTLINE_SOURCE } from './glLayers';
import { BODY_MAP_LAYERS } from './mapDescriptors';

describe('glLayers', () => {
  const ids = glLayerIds();

  it('draws fills first, bays under the shore, and the lit item last', () => {
    expect(ids[0]).toBe('body-console-fill-footprint');
    expect(ids[1]).toBe('body-console-fill-body');
    expect(ids.indexOf('body-console-outline-bay')).toBeLessThan(
      ids.indexOf('body-console-outline-body'),
    );
    expect(ids.slice(-3)).toEqual([
      'body-console-lit-fill',
      'body-console-lit-outline',
      'body-console-lit-line',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reads only its two sources', () => {
    for (const l of glLayers(null)) {
      expect([OUTLINE_SOURCE, LINE_SOURCE]).toContain((l as { source: string }).source);
    }
  });

  it('paints from the admin tokens, and the two modes differ', () => {
    const dark = glLayers(bodyMapPalette('dark'));
    const light = glLayers(bodyMapPalette('light'));
    const shore = (ls: typeof dark) =>
      (ls.find((l) => l.id === 'body-console-outline-body') as { paint: Record<string, unknown> })
        .paint;
    expect(shore(dark)['line-color']).toBe(adminToken('dark', 'fg1'));
    expect(shore(light)['line-color']).toBe(adminToken('light', 'fg1'));
    expect(shore(dark)['line-color']).not.toBe(shore(light)['line-color']);
    const bay = dark.find((l) => l.id === 'body-console-outline-bay') as {
      paint: Record<string, unknown>;
    };
    expect(bay.paint['line-dasharray']).toEqual([2, 3]);
  });
});

describe('the palette', () => {
  it('keeps color rationed: nothing on the map paints in ice, amber or red', () => {
    const specs = [...Object.values(OUTLINE_STYLES), ...Object.values(LINE_STYLES), LIT_STYLE];
    for (const s of specs) {
      for (const t of [s.line, s.fill]) {
        if (t === null) continue;
        expect(t).not.toMatch(/^(acc|warn|bad|star)/);
      }
    }
  });

  it('names real tokens in both modes', () => {
    for (const mode of ['dark', 'light'] as const) {
      const p = bodyMapPalette(mode);
      for (const s of [...Object.values(p.outline), ...Object.values(p.line), p.lit]) {
        expect(s.line).toMatch(/^(#|rgba)/);
      }
    }
    expect(tokenVar('fg1')).toBe('var(--fg1)');
  });
});

describe('the key', () => {
  it('lists access, then places, once per word', () => {
    expect(keyEntries(['island', 'lot', 'putIn', 'hazard', 'feature']).map((e) => e.label)).toEqual(
      ['Put-in', 'Lot', 'Island', 'Hazard'],
    );
    expect(keyEntries([])).toEqual([]);
  });

  it('has a word for every face, and none says anything about the ice', () => {
    for (const label of Object.values(POINT_KEY_LABELS)) {
      expect(label).not.toMatch(/safe|skateable|good|ok\b/i);
    }
    expect(BODY_MAP_LAYERS).toHaveLength(10);
  });
});
