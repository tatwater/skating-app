import {
  BAND_EDGE_DEEP_COLD_F,
  BAND_EDGE_FREEZING_F,
  BAND_EDGE_THAW_F,
  TEMPERATURE_BANDS as CORE_BANDS,
} from '@skating/core';
import { describe, expect, it } from 'vitest';
import {
  emphasisColor,
  TEMPERATURE_BAND_EDGES_F,
  TEMPERATURE_BANDS,
  WEATHER_AUX_SCALE,
  WEATHER_PRECIPITATION_SCALE,
  WEATHER_TEMPERATURE_SCALE,
  weatherChartPalette,
} from './chartWeather';

/**
 * ## Why this test lives here and not in core
 *
 * The weather timeline's band edges are stated twice: once in `@skating/core`'s geometry (which
 * decides *where* the 32°F rule is drawn) and once here (which decides *what color* 32°F changes to).
 * They must agree, or the line changes color somewhere other than the rule it crosses — a defect that
 * looks like a rendering glitch and is actually a lie about the data.
 *
 * The duplication is deliberate: core is consumed by the Convex backend, which has no business
 * importing a color package, so there is no core→design edge to import across. The edge that *does*
 * exist is design→core (dev-only), which is why the pin is asserted from this side.
 */
describe('the band edges agree with core geometry', () => {
  it('pins every edge', () => {
    expect(TEMPERATURE_BAND_EDGES_F.deepCold).toBe(BAND_EDGE_DEEP_COLD_F);
    expect(TEMPERATURE_BAND_EDGES_F.freezing).toBe(BAND_EDGE_FREEZING_F);
    expect(TEMPERATURE_BAND_EDGES_F.thaw).toBe(BAND_EDGE_THAW_F);
  });

  it('pins the band names and their order', () => {
    // Order is load-bearing: the gradient walks these cold → warm, so a reordering here would invert
    // the scale without changing a single hex value.
    expect([...TEMPERATURE_BANDS]).toEqual([...CORE_BANDS]);
  });
});

describe('every theme defines every slot', () => {
  // A missing slot renders as `undefined`, which SVG treats as black — invisible on the dark surface
  // and, worse, indistinguishable from a deliberate mark on the light one.
  it.each(['light', 'dark'] as const)('%s', (mode) => {
    const palette = weatherChartPalette(mode);
    for (const band of TEMPERATURE_BANDS) {
      expect(palette.temperature[band]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(palette.precipitation.snow).toMatch(/^#[0-9a-f]{6}$/i);
    expect(palette.precipitation.rain).toMatch(/^#[0-9a-f]{6}$/i);
    for (const slot of ['trace', 'fill', 'control', 'sunLit'] as const) {
      expect(palette.aux[slot]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(palette.emphasis.cold).toMatch(/^#[0-9a-f]{6}$/i);
    expect(palette.emphasis.warm).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('the emphasis rails borrow the temperature poles', () => {
  // ⚠ The rule this pins: **cyan is the cold side and orange the warm side, in every lane.** Both
  // auxiliary emphases are conjunctions with temperature — wind is highlighted when calm *and below*
  // freezing, sun when bright *and above* — so they must wear the same poles the temperature line
  // does. An earlier version used one shared blue for both, which drew a sunny thaw (the condition
  // that softens a skating surface) in the same colour as the hard freeze that makes black ice.
  it.each(['light', 'dark'] as const)('%s', (mode) => {
    const palette = weatherChartPalette(mode);
    expect(palette.emphasis.cold).toBe(palette.temperature.deepCold);
    expect(palette.emphasis.warm).toBe(palette.temperature.warm);
    expect(emphasisColor(mode, 'cold')).not.toBe(emphasisColor(mode, 'warm'));
  });
});

describe('the scrubber colour is not a data colour', () => {
  it.each(['light', 'dark'] as const)('%s', (mode) => {
    // The thumb and the scrub crosshair are chrome. Chrome that borrows a scale's hue starts reading
    // as a measurement — a thumb sitting under the wind lane in a wind colour was already ambiguous.
    const p = weatherChartPalette(mode);
    const dataColors = [
      ...Object.values(p.temperature),
      ...Object.values(p.precipitation),
      p.aux.sunLit,
    ];
    expect(dataColors).not.toContain(p.aux.control);
  });
});

describe('the two themes are genuinely different palettes', () => {
  it('never reuses a temperature step across modes', () => {
    // Dark mode is *selected*, not an automatic flip of light mode (the design-system rule). A shared
    // value would mean one of the two was never checked against its own surface.
    for (const band of TEMPERATURE_BANDS) {
      expect(WEATHER_TEMPERATURE_SCALE.light[band]).not.toBe(WEATHER_TEMPERATURE_SCALE.dark[band]);
    }
    expect(WEATHER_PRECIPITATION_SCALE.light.rain).not.toBe(WEATHER_PRECIPITATION_SCALE.dark.rain);
    expect(WEATHER_AUX_SCALE.light.sunLit).not.toBe(WEATHER_AUX_SCALE.dark.sunLit);
    expect(WEATHER_AUX_SCALE.light.control).not.toBe(WEATHER_AUX_SCALE.dark.control);
  });

  it('keeps the two poles on opposite sides of the hue circle', () => {
    // Cyan against amber-orange. Two cool hues would fail the diverging rule — the poles have to read
    // as opposites, or "below freezing" and "above freezing" stop being distinguishable at a glance.
    for (const mode of ['light', 'dark'] as const) {
      const cold = WEATHER_TEMPERATURE_SCALE[mode].deepCold;
      const warm = WEATHER_TEMPERATURE_SCALE[mode].warm;
      // Blue channel dominant on the cold pole, red channel dominant on the warm one.
      const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
      const [coldR, , coldB] = rgb(cold) as [number, number, number];
      const [warmR, , warmB] = rgb(warm) as [number, number, number];
      expect(coldB).toBeGreaterThan(coldR);
      expect(warmR).toBeGreaterThan(warmB);
    }
  });
});
