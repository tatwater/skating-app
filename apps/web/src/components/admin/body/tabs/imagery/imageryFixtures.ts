import type { TimelineStop } from '@skating/core';

import { type PassOverride, passRows } from './imageryModel';

/**
 * Board 5.4.6's passes over Mascoma Lake this winter (the watch opened 3 Oct 2026), oldest first:
 * clear of cloud and in the pass, as fractions, and which gate hid each. One pass staff showed
 * anyway (Teagan, 12 Oct). Stories and tests only.
 */
const PASSES: ReadonlyArray<{
  day: number;
  clear: number;
  coverage: number;
  blockedBy?: 'cloud' | 'coverage';
}> = [
  { day: 3, clear: 0.92, coverage: 1 },
  { day: 5, clear: 0.09, coverage: 1, blockedBy: 'cloud' },
  { day: 6, clear: 1, coverage: 0.4, blockedBy: 'coverage' },
  { day: 8, clear: 0.97, coverage: 1 },
  { day: 10, clear: 0.36, coverage: 1, blockedBy: 'cloud' },
  { day: 11, clear: 0.28, coverage: 1, blockedBy: 'cloud' },
  { day: 13, clear: 0.98, coverage: 1 },
];

/** The granule id a fixture pass carries. */
export const granuleOf = (day: number) => `S2B_MSIL2A_202610${String(day).padStart(2, '0')}_T18TYP`;

export const MASCOMA_STOPS: TimelineStop[] = PASSES.map((p) => ({
  frame: {
    granuleId: granuleOf(p.day),
    // Mid-morning over New England: the same UTC day as the local one.
    capturedAt: `2026-10-${String(p.day).padStart(2, '0')}T15:42:00Z`,
    cloudCoverPct: Math.round((1 - p.clear) * 100),
    bodies: 412,
    band: 'visual',
    key: `frames/winter-2026-27/${granuleOf(p.day)}.webp`,
  },
  landable: p.blockedBy === undefined,
  ...(p.blockedBy !== undefined ? { blockedBy: p.blockedBy } : {}),
  basis: 'measured' as const,
  stats: { waterBodyId: 'mascoma', clearPct: p.clear, coveragePct: p.coverage, pixels: 46_200 },
}));

export const MASCOMA_OVERRIDES: Record<string, PassOverride> = {
  [granuleOf(11)]: { verdict: 'show', by: 'Teagan', at: new Date(2026, 9, 12, 12, 0).getTime() },
};

export const MASCOMA_PASSES = passRows(MASCOMA_STOPS, MASCOMA_OVERRIDES);

/** A pass whose manifest hasn't landed: coverage inferred, nothing measured. */
export const INFERRED_STOP: TimelineStop = {
  frame: {
    granuleId: 'S2A_MSIL2A_20261015_T18TYP',
    capturedAt: '2026-10-15T15:42:00Z',
    cloudCoverPct: 94,
    bodies: 380,
    band: 'visual',
    key: 'frames/winter-2026-27/S2A_MSIL2A_20261015_T18TYP.webp',
  },
  landable: true,
  basis: 'inferred',
};

export const SEASON = 'Winter 2026–27';

export const MASCOMA_SATELLITE = {
  mode: 'auto' as const,
  name: 'Mascoma Lake',
  areaSqM: 4_620_000,
  url: 'https://browser.dataspace.copernicus.eu/?zoom=13&lat=43.6174&lng=-72.136',
};
