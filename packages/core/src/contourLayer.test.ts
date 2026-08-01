import { describe, expect, it } from 'vitest';
import {
  CONTOUR_MIN_ZOOM,
  CONTOUR_SOURCE_TERMS,
  type ContourFeatureProperties,
  contourBodyKey,
  contourColorExpression,
  contourCredit,
  contourFilter,
  contourSourceSpec,
  contourWidthExpression,
  formatContourCredit,
  maxContourDepthFt,
} from './contourLayer';

const PALETTE = { shallow: '#bcd9ee', deep: '#0d3f66' };

function feature(over: Partial<ContourFeatureProperties> = {}): Partial<ContourFeatureProperties> {
  return {
    bodyId: 'way/123',
    depthFt: 10,
    lane: 'surveyed',
    agency: 'NH GRANIT',
    state: 'NH',
    intervalFt: 5,
    ...over,
  };
}

describe('contourFilter', () => {
  it('draws only the open lake', () => {
    expect(contourFilter('way/123')).toEqual(['==', ['get', 'bodyId'], 'way/123']);
  });

  it('draws NOTHING when no body is selected', () => {
    // The failure that would matter: falling back to "all contours" would put every surveyed lake in
    // the region onto the browse map, which is precisely the thing D81 removed.
    const filter = contourFilter(undefined);
    expect(filter).toEqual(['==', ['literal', true], ['literal', false]]);
    expect(filter).not.toEqual(['==', ['get', 'bodyId'], undefined]);
  });

  it('treats an empty id as no selection rather than matching empty-string bodies', () => {
    expect(contourFilter('')).toEqual(contourFilter(undefined));
  });

  it('takes the null both clients hold "no lake open" as', () => {
    expect(contourFilter(null)).toEqual(contourFilter(undefined));
  });
});

describe('contourColorExpression', () => {
  it('ramps within one hue from shallow to deep', () => {
    const expression = contourColorExpression(PALETTE, 40);
    expect(expression).toContain(PALETTE.shallow);
    expect(expression).toContain(PALETTE.deep);
  });

  it('scales the ramp to the lake on screen, not to the corpus', () => {
    // A 17 ft pond and a 400 ft lake both need to read as shallow-at-the-edge, deep-in-the-middle.
    // A corpus-wide ramp renders every shallow lake in one flat tint.
    const shallowLake = contourColorExpression(PALETTE, 17);
    const deepLake = contourColorExpression(PALETTE, 400);
    expect(shallowLake[shallowLake.length - 2]).toBe(17);
    expect(deepLake[deepLake.length - 2]).toBe(400);
  });

  it('never divides by a zero depth', () => {
    const expression = contourColorExpression(PALETTE, 0);
    expect(expression[expression.length - 2]).toBe(1);
  });

  it('reads the depth defensively — a tile without the property must not blank the layer', () => {
    expect(contourColorExpression(PALETTE, 40)).toContainEqual([
      'to-number',
      ['get', 'depthFt'],
      0,
    ]);
  });
});

describe('contourWidthExpression', () => {
  it('starts at the zoom floor and stays a hairline', () => {
    const expression = contourWidthExpression();
    expect(expression[3]).toBe(CONTOUR_MIN_ZOOM);
    // Under D82 the contour is what loses when anything competes for legibility. A hairline is that
    // rule expressed in a stylesheet rather than in a document nobody re-reads.
    const widths = expression.filter((v): v is number => typeof v === 'number' && v < 5);
    expect(Math.max(...widths)).toBeLessThanOrEqual(2);
  });
});

describe('contourSourceSpec', () => {
  it('range-reads the archive rather than asking a static host for a TileJSON', () => {
    // Without the scheme MapLibre GETs the `.pmtiles` URL expecting JSON, and the lake renders flat —
    // which is indistinguishable from a lake no agency ever surveyed.
    expect(contourSourceSpec('https://tiles.example/bathymetry.pmtiles')).toEqual({
      type: 'vector',
      url: 'pmtiles://https://tiles.example/bathymetry.pmtiles',
    });
  });
});

describe('contourBodyKey', () => {
  it('prefers the OSM id, which survives a re-import', () => {
    expect(contourBodyKey('way/123', 'k9abc')).toBe('way/123');
  });

  it('falls back to the Convex id rather than letting a body vanish', () => {
    expect(contourBodyKey(undefined, 'k9abc')).toBe('k9abc');
    expect(contourBodyKey('   ', 'k9abc')).toBe('k9abc');
  });
});

describe('maxContourDepthFt', () => {
  it('spans the rings that are actually drawn', () => {
    expect(maxContourDepthFt([feature({ depthFt: 5 }), feature({ depthFt: 35 })])).toBe(35);
  });

  it('is undefined when nothing is drawn, so the ramp is left alone', () => {
    expect(maxContourDepthFt([])).toBeUndefined();
  });

  it('ignores a feature whose depth did not survive the tile', () => {
    expect(
      maxContourDepthFt([
        { depthFt: undefined },
        { depthFt: Number.NaN },
        feature({ depthFt: 12 }),
      ]),
    ).toBe(12);
  });
});

describe('contourCredit', () => {
  it('is undefined when nothing is drawn, so the drawer renders no empty row', () => {
    expect(contourCredit([])).toBeUndefined();
    expect(contourCredit([feature({ agency: '' })])).toBeUndefined();
  });

  it('collects each agency once', () => {
    const credit = contourCredit(
      [feature(), feature(), feature({ agency: 'MassGIS' })],
      { 'NH GRANIT': { credit: 'NH GRANIT' } }, // MassGIS unregistered ⇒ falls back to its own label
    );
    expect(credit?.agencies).toEqual(['NH GRANIT', 'MassGIS']);
  });

  it('renders the wording the licence requires, not the label the tile carries', () => {
    // The one that matters: the Champlain tiles say "VCGI / NOAA", and that is precisely the credit
    // we may not render — VCGI's terms name UVM, and NOAA asks that we not imply its involvement.
    const credit = contourCredit([feature({ agency: 'VCGI / NOAA', lane: 'interpolated' })]);
    expect(credit?.agencies).toEqual([
      'Soundings digitised from NOAA nautical charts by University of Vermont and VCGI',
    ]);
    expect(credit?.notices).toEqual(['Not for navigation.']);
  });

  it('credits an unregistered agency by its own label rather than nobody', () => {
    const credit = contourCredit([feature({ agency: 'A New State Agency' })]);
    expect(credit?.agencies).toEqual(['A New State Agency']);
    expect(credit?.notices).toEqual([]);
  });

  it('separates the lanes, because they are different claims', () => {
    // A state's own isobaths and a surface we fitted through its soundings must never render as the
    // same thing (§Maine step 5, gate 3 of §6).
    expect(contourCredit([feature()])?.lane).toBe('surveyed');
    expect(contourCredit([feature({ lane: 'interpolated' })])?.lane).toBe('interpolated');
  });

  it('says "mixed" rather than taking credit for an agency survey', () => {
    // Two sources on one water body — a border lake filed by both states. The old single boolean
    // made ANY fitted line turn the whole body into "interpolated by us", over a credit list naming
    // the agency whose own survey was also drawn. Symmetric with `intervalFt` going null.
    const credit = contourCredit([feature(), feature({ lane: 'interpolated' })]);
    expect(credit?.lane).toBe('mixed');
  });

  it('reports the interval when the features agree and null when they do not', () => {
    expect(contourCredit([feature(), feature()])?.intervalFt).toBe(5);
    // Two sources overlapping one body. Saying nothing beats labelling one source's lines with the
    // other's spacing.
    expect(contourCredit([feature(), feature({ intervalFt: 10 })])?.intervalFt).toBeNull();
  });

  it('carries a required notice, once, for the agency that requires it', () => {
    const credit = contourCredit([
      feature({ agency: 'VCGI / NOAA' }),
      feature({ agency: 'VCGI / NOAA' }),
    ]);
    expect(credit?.notices).toEqual(['Not for navigation.']);
  });

  it('carries no notice for agencies that require none', () => {
    expect(contourCredit([feature()])?.notices).toEqual([]);
  });
});

describe('CONTOUR_SOURCE_TERMS', () => {
  it('gives every agency something to render', () => {
    // `scripts/bathymetry` holds the other half of this contract — a test there asserts every
    // source's `attribution`/`notice` matches this table verbatim.
    for (const entry of Object.values(CONTOUR_SOURCE_TERMS)) {
      expect(entry.credit.trim()).not.toBe('');
    }
  });

  it('names the actual copyright holder on Champlain, and does not lead with NOAA', () => {
    // The whole reason this table exists. VCGI's `copyrightText` names the University of Vermont;
    // NOAA asks that attribution not imply its endorsement or that modified data is unaltered NOAA
    // data — and our Champlain surface is doubly derived (NOAA chart → UVM/VCGI → our fit).
    const champlain = CONTOUR_SOURCE_TERMS['VCGI / NOAA'];
    expect(champlain?.credit).toContain('University of Vermont');
    expect(champlain?.credit).not.toMatch(/^NOAA/);
    expect(champlain?.notice).toBe('Not for navigation.');
  });
});

describe('formatContourCredit', () => {
  it('is empty when there is nothing to credit', () => {
    expect(formatContourCredit(undefined)).toBe('');
  });

  it('says surveyed for an agency lane', () => {
    const line = formatContourCredit(contourCredit([feature()]));
    expect(line).toBe(
      '5 ft contours, surveyed by NH Department of Environmental Services · NH Fish and Game (NH GRANIT).',
    );
  });

  it('says interpolated for ours, naming who published the soundings', () => {
    const line = formatContourCredit(
      contourCredit([feature({ lane: 'interpolated', agency: 'Maine DEP / MaineIF&W' })]),
    );
    expect(line).toContain('interpolated by us');
    expect(line).toContain('Maine Department of Environmental Protection');
  });

  it('leaves a sentence-shaped licence credit standing on its own', () => {
    // Champlain's required wording IS a sentence about where the soundings came from. Splicing it
    // into "…published by X" would be ungrammatical, and worse, an alteration of licence text.
    const line = formatContourCredit(
      contourCredit([feature({ agency: 'VCGI / NOAA', lane: 'interpolated' })]),
    );
    expect(line).toContain(
      '. Soundings digitised from NOAA nautical charts by University of Vermont and VCGI.',
    );
    expect(line).not.toContain('by Soundings');
  });

  it('appends a required notice', () => {
    const line = formatContourCredit(
      contourCredit([feature({ agency: 'VCGI / NOAA', lane: 'interpolated' })]),
    );
    expect(line).toMatch(/Not for navigation\.$/);
  });

  it('degrades to "depth contours" rather than lying about an interval', () => {
    const line = formatContourCredit(contourCredit([feature(), feature({ intervalFt: 10 })]));
    expect(line).toContain('depth contours');
    expect(line).not.toMatch(/\d+ ft contours/);
  });

  it('names both claims when two sources drew one lake', () => {
    // Neither "surveyed by" (which credits the agency with our fit) nor "interpolated by us" (which
    // takes credit for the agency's survey) is available, so the line says both.
    const line = formatContourCredit(
      contourCredit([
        feature(),
        feature({ lane: 'interpolated', agency: 'Maine DEP / MaineIF&W' }),
      ]),
    );
    expect(line).toContain('part surveyed and part interpolated by us');
    expect(line).toContain('NH Department of Environmental Services');
    expect(line).toContain('Maine Department of Environmental Protection');
  });

  it('carries no interpretation — provenance only (D82)', () => {
    // Any sentence about what a depth MEANS for ice is a sentence a skater can act on, and D3 says
    // prediction is not ours to make. The line we can hold absolutely is the one with no copy behind it.
    //
    // Swept across EVERY registered agency and every lane rather than a hand-picked pair: the credit
    // is an agency's legal name and we do not choose those, so the next source added is the one that
    // could quietly put a forbidden word into drawer copy.
    const lines = Object.keys(CONTOUR_SOURCE_TERMS).flatMap((agency) => [
      formatContourCredit(contourCredit([feature({ agency })])),
      formatContourCredit(contourCredit([feature({ agency, lane: 'interpolated' })])),
      formatContourCredit(
        contourCredit([feature({ agency }), feature({ agency, lane: 'interpolated' })]),
      ),
    ]);
    // Whole words: an agency's legal name is not our copy, and "Department of Environmental
    // Serv*ice*s" is the credit rendering correctly rather than a claim about ice.
    for (const line of lines) {
      expect(line, line).not.toMatch(/\b(ice|safe|danger|thin|thick|shallow|deep|risk)\b/i);
    }
  });
});
