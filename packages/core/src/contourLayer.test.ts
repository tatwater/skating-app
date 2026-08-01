import { describe, expect, it } from 'vitest';
import {
  CONTOUR_MIN_ZOOM,
  type ContourFeatureProperties,
  contourColorExpression,
  contourCredit,
  contourFilter,
  contourWidthExpression,
  formatContourCredit,
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

describe('contourCredit', () => {
  it('is undefined when nothing is drawn, so the drawer renders no empty row', () => {
    expect(contourCredit([])).toBeUndefined();
    expect(contourCredit([feature({ agency: '' })])).toBeUndefined();
  });

  it('collects each agency once', () => {
    const credit = contourCredit([feature(), feature(), feature({ agency: 'MassGIS' })]);
    expect(credit?.agencies).toEqual(['NH GRANIT', 'MassGIS']);
  });

  it('flags an interpolated lane, because it is a different claim from a survey', () => {
    // A state's own isobaths and a surface we fitted through its soundings must never render as the
    // same thing (§Maine step 5, gate 3 of §6).
    expect(contourCredit([feature()])?.interpolated).toBe(false);
    expect(contourCredit([feature({ lane: 'interpolated' })])?.interpolated).toBe(true);
  });

  it('flags interpolation if ANY drawn line is ours', () => {
    const credit = contourCredit([feature(), feature({ lane: 'interpolated' })]);
    expect(credit?.interpolated).toBe(true);
  });

  it('reports the interval when the features agree and null when they do not', () => {
    expect(contourCredit([feature(), feature()])?.intervalFt).toBe(5);
    // Two sources overlapping one body. Saying nothing beats labelling one source's lines with the
    // other's spacing.
    expect(contourCredit([feature(), feature({ intervalFt: 10 })])?.intervalFt).toBeNull();
  });

  it('carries a required notice, once, for the agency that requires it', () => {
    const credit = contourCredit([feature({ agency: 'VCGI' }), feature({ agency: 'VCGI' })], {
      VCGI: 'Not for navigation.',
    });
    expect(credit?.notices).toEqual(['Not for navigation.']);
  });

  it('carries no notice for agencies that require none', () => {
    expect(contourCredit([feature()], { VCGI: 'Not for navigation.' })?.notices).toEqual([]);
  });
});

describe('formatContourCredit', () => {
  it('is empty when there is nothing to credit', () => {
    expect(formatContourCredit(undefined)).toBe('');
  });

  it('says surveyed for an agency lane', () => {
    const line = formatContourCredit(contourCredit([feature()]));
    expect(line).toBe('5 ft contours surveyed by NH GRANIT');
  });

  it('says interpolated for ours, naming who published the soundings', () => {
    const line = formatContourCredit(
      contourCredit([feature({ lane: 'interpolated', agency: 'Maine DEP / IF&W' })]),
    );
    expect(line).toContain('interpolated from soundings');
    expect(line).toContain('Maine DEP / IF&W');
  });

  it('appends a required notice', () => {
    const line = formatContourCredit(
      contourCredit([feature({ agency: 'VCGI', lane: 'interpolated' })], {
        VCGI: 'Not for navigation.',
      }),
    );
    expect(line).toMatch(/Not for navigation\.$/);
  });

  it('degrades to "depth contours" rather than lying about an interval', () => {
    const line = formatContourCredit(contourCredit([feature(), feature({ intervalFt: 10 })]));
    expect(line).toContain('depth contours');
    expect(line).not.toMatch(/\d+ ft contours/);
  });

  it('carries no interpretation — provenance only (D82)', () => {
    // Any sentence about what a depth MEANS for ice is a sentence a skater can act on, and D3 says
    // prediction is not ours to make. The line we can hold absolutely is the one with no copy behind it.
    const lines = [
      formatContourCredit(contourCredit([feature()])),
      formatContourCredit(contourCredit([feature({ lane: 'interpolated' })])),
    ];
    for (const line of lines) {
      expect(line).not.toMatch(/ice|safe|danger|thin|thick|shallow|deep|risk/i);
    }
  });
});
