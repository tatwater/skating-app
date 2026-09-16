import { describe, expect, it } from 'vitest';
import { describeSubAreaHeader, windRoseCaption } from './subAreaPlace';

describe('describeSubAreaHeader (N9)', () => {
  const parent = { name: 'Lake Champlain', elevationM: 29 };

  it('names the parent, reports its own area, inherits elevation and says so', () => {
    const h = describeSubAreaHeader({ name: 'Malletts Bay', surfaceAreaSqM: 4.5e7 }, parent);
    expect(h.partOf).toBe('Part of Lake Champlain');
    expect(h.area).toMatch(/acres$/);
    expect(h.elevation).toBe('Elevation 95 ft — the lake’s');
    // No derived depth ⇒ nothing, never the parent's number (D3).
    expect(h.depth).toBeNull();
  });

  it('frames its own depth like a lake would, and a contour-lane depth as a floor', () => {
    const measured = describeSubAreaHeader(
      { name: 'Malletts Bay', surfaceAreaSqM: 1, maxDepthM: 18, maxDepthSource: 'state_agency' },
      parent,
    );
    expect(measured.depth?.text).toBe('max 59 ft');
    const floor = describeSubAreaHeader(
      {
        name: 'Malletts Bay',
        surfaceAreaSqM: 1,
        maxDepthM: 18,
        maxDepthSource: 'state_agency',
        depthUnderstatesMax: true,
      },
      parent,
    );
    expect(floor.depth?.text).toBe('max at least 59 ft');
    expect(floor.depth?.caption).toMatch(/true maximum may be deeper/);
  });

  it('a parent with no elevation contributes no line', () => {
    expect(
      describeSubAreaHeader({ name: 'x', surfaceAreaSqM: 1 }, { name: 'Lake Morey' }).elevation,
    ).toBeNull();
  });
});

describe('windRoseCaption (N9 call 6)', () => {
  it('says the rose is the cell’s on every body, and adds the fetch clause for a bay', () => {
    expect(windRoseCaption('body')).toBe(
      'Wind climate is the 2 km grid cell’s, not this water’s own.',
    );
    expect(windRoseCaption('subArea')).toBe(
      'Wind climate is the 2 km grid cell’s, not this water’s own; fetch is measured from this bay’s own outline.',
    );
  });
});
