import { describe, expect, it } from 'vitest';
import {
  adminToken,
  bodyMapPalette,
  LINE_STYLES,
  LIT_STYLE,
  OUTLINE_STYLES,
  tokenVar,
} from './bodyMapPalette';
import {
  bandOf,
  DOT_SOURCE,
  glLayerIds,
  glLayers,
  LINE_SOURCE,
  MAP_BANDS,
  OUTLINE_SOURCE,
  rasterAnchor,
} from './glLayers';
import { BODY_MAP_LAYERS } from './mapDescriptors';

describe('glLayers', () => {
  const ids = glLayerIds();

  it('draws the hazards’ dot fields over the fills and under every line, each dot at its own strength', () => {
    const dots = ids.indexOf('body-console-field-dots');
    expect(dots).toBeGreaterThan(ids.indexOf('body-console-fill-body'));
    expect(dots).toBeLessThan(ids.indexOf('body-console-outline-bay'));
    const layer = glLayers(bodyMapPalette('dark')).find((l) => l.id === 'body-console-field-dots');
    expect(layer).toMatchObject({ type: 'circle', source: DOT_SOURCE });
    expect((layer as { paint: Record<string, unknown> }).paint['circle-opacity']).toEqual([
      'get',
      'opacity',
    ]);
  });

  it('draws the approach as a dashed line, and leaves the dimension line to the pixels', () => {
    expect(ids).toContain('body-console-line-approach');
    expect(ids).not.toContain('body-console-line-dimension');
    expect(LINE_STYLES.approach.dash).not.toBeNull();
  });

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

  it('reads only its three sources', () => {
    for (const l of glLayers(null)) {
      expect([OUTLINE_SOURCE, LINE_SOURCE, DOT_SOURCE]).toContain((l as { source: string }).source);
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

describe('the rack', () => {
  it('holds every layer the map draws, in the rack’s order', () => {
    expect(BODY_MAP_LAYERS).toHaveLength(10);
  });
});

describe('the layer contract — one order for the frame and every tab’s scene', () => {
  const ids = glLayerIds();
  const at = (id: string) => ids.indexOf(id);
  const band = (b: string) => MAP_BANDS.indexOf(b as never);

  it('adds every layer in its band’s place, bands in MAP_BANDS order, nothing outside a band', () => {
    const bands = ids.map((id) => bandOf(id));
    expect(bands.every((b) => b !== null)).toBe(true);
    for (let i = 1; i < bands.length; i++) {
      expect(band(bands[i] as string)).toBeGreaterThanOrEqual(band(bands[i - 1] as string));
    }
  });

  it('a pass (raster) lands over the body’s fill and under the fields, the shore and every line', () => {
    // As the map holds the console's layers: the pass is inserted before the first layer above it.
    const anchor = rasterAnchor(ids);
    expect(anchor).toBe('body-console-field-dots');
    expect(at(anchor as string)).toBeGreaterThan(at('body-console-fill-body'));
    expect(at(anchor as string)).toBeLessThanOrEqual(at('body-console-outline-body'));
    expect(at(anchor as string)).toBeLessThan(at('body-console-line-approach'));
    // Before the console's layers are in, no anchor of its own: the reveal's fallback stands.
    expect(rasterAnchor(['water', 'roads_minor'])).toBeUndefined();
    // Without the fields layer (a map mid-build), the next band's first layer still holds the line.
    expect(rasterAnchor(ids.filter((id) => id !== 'body-console-field-dots'))).toBe(
      'body-console-outline-bay',
    );
  });

  it.each([
    ['a hazard field', 'body-console-field-dots'],
    ['a footprint’s outline', 'body-console-outline-footprint'],
    ['a dimmed neighbor’s outline', 'body-console-outline-neighbor'],
    ['a bay’s outline', 'body-console-outline-bay'],
    ['the shore', 'body-console-outline-body'],
    ['an approach line', 'body-console-line-approach'],
    ['a town line', 'body-console-line-townLine'],
  ])('%s lands over the body’s opaque fill', (_kind, id) => {
    expect(at(id)).toBeGreaterThan(at('body-console-fill-body'));
    expect(at(id)).toBeGreaterThan(at('body-console-fill-footprint'));
  });

  it('a footprint’s fill shares the fills band, under every line and field', () => {
    expect(bandOf('body-console-fill-footprint')).toBe('fills');
    expect(at('body-console-fill-footprint')).toBeLessThan(at('body-console-field-dots'));
  });

  it('the lit item is over every other GL layer; points and labels are the DOM’s, over the canvas', () => {
    expect(ids.slice(-3).every((id) => bandOf(id) === 'lit')).toBe(true);
    expect(MAP_BANDS.at(-1)).toBe('marks');
  });

  it('paints the body’s fill opaque — which is why a pass must sit above it, never under', () => {
    const fill = glLayers(bodyMapPalette('dark')).find(
      (l) => l.id === 'body-console-fill-body',
    ) as {
      paint: Record<string, unknown>;
    };
    expect(fill.paint['fill-color']).toBeDefined();
    expect(fill.paint['fill-opacity']).toBeUndefined();
  });
});
