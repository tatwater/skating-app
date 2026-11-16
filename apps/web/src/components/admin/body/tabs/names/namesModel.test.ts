import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FAILED_READ } from '@/components/admin/reads/readFailureFixtures';
import { townLinesShortWords } from '../../consoleWords';
import { MASCOMA_NAMES } from './namesFixtures';
import {
  aliasesOf,
  countryOf,
  nameRungs,
  namesFromBody,
  namesMapScene,
  namesWithPicks,
  otherClasses,
  stateName,
  townLinesFrom,
  townNames,
} from './namesModel';

describe('nameRungs', () => {
  it('folds catalogs that spell it alike onto one rung, in stored (authority) order', () => {
    expect(
      nameRungs('The Basin', [
        { source: 'nhd', value: 'The Basin' },
        { source: 'gnis', value: 'the basin ' },
        { source: 'osm', value: 'Lake Auburn' },
      ]),
    ).toEqual([
      { value: 'The Basin', sources: ['nhd', 'gnis'], now: true },
      { value: 'Lake Auburn', sources: ['osm'], now: false },
    ]);
  });

  it('never makes a rung of a moderator’s claim or a blank one', () => {
    expect(
      nameRungs('Lake Auburn', [
        { source: 'user', value: 'Lake Auburn' },
        { source: 'nhd', value: '  ' },
        { source: 'osm', value: 'Lake Auburn' },
      ]),
    ).toEqual([{ value: 'Lake Auburn', sources: ['osm'], now: true }]);
  });

  it('is empty for a body nobody named', () => {
    expect(nameRungs('', undefined)).toEqual([]);
  });
});

describe('aliasesOf', () => {
  it('keeps a moderator’s names that aren’t displayed, once each', () => {
    expect(
      aliasesOf('Lake Auburn', [
        { source: 'user', value: 'Lake Auburn' },
        { source: 'user', value: 'Auburn Lake' },
        { source: 'user', value: 'auburn lake' },
        { source: 'osm', value: 'The Basin' },
      ]),
    ).toEqual(['Auburn Lake']);
  });
});

describe('namesFromBody', () => {
  it('reads the record: Now, the override, the class and the one state it holds', () => {
    const data = namesFromBody(
      {
        name: 'Lake Auburn',
        type: 'lakePond',
        nameClaims: [
          { source: 'user', value: 'Lake Auburn' },
          { source: 'nhd', value: 'The Basin' },
          { source: 'osm', value: 'Lake Auburn' },
        ],
        states: ['ME'],
      },
      null,
    );
    expect(data.overridden).toBe(true);
    expect(data.community).toBe(false);
    expect(data.rungs.map((r) => r.now)).toEqual([false, true]);
    expect(data.cls).toBe('lakePond');
    // Not recorded stays null — never zero, never "none".
    expect(data.classOptions).toBeNull();
    expect(data.perCatalogClaims).toBeNull();
    expect(data.place).toEqual({ admin: 'not-computed', states: ['ME'], townLines: null });
    expect(data.failures).toEqual([]);
  });

  it('calls a body with no catalog claim the community’s', () => {
    const data = namesFromBody({ name: '', type: 'lakePond' }, null);
    expect(data.community).toBe(true);
    expect(data.overridden).toBe(false);
    expect(data.place.states).toEqual([]);
    // Named by a moderator's claim alone: still the community's, its typo still fixable.
    const named = namesFromBody(
      {
        name: 'Low Plains',
        type: 'lakePond',
        nameClaims: [{ source: 'user', value: 'Low Plains' }],
      },
      null,
    );
    expect(named.community).toBe(true);
  });

  it('never calls a named body with no claim at all the community’s — the server won’t rename it', () => {
    // A body a skater drew: its author's name, and no claim to restore it from.
    const drawn = namesFromBody({ name: 'Back Cove Rink', type: 'lakePond' }, null);
    expect(drawn.community).toBe(false);
    expect(drawn.rungs).toEqual([]);
  });

  it('keeps the current class among the options, so Now always has a row', () => {
    const data = namesFromBody({ name: 'Mascoma Lake', type: 'reservoir' }, null, {
      classOptions: [{ cls: 'lakePond', sources: ['NHD'] }],
    });
    expect(data.classOptions?.map((o) => o.cls)).toEqual(['reservoir', 'lakePond']);
    const already = namesFromBody({ name: 'Mascoma Lake', type: 'reservoir' }, null, {
      classOptions: [{ cls: 'reservoir', sources: ['OSM'] }],
    });
    expect(already.classOptions).toHaveLength(1);
  });

  it('takes the towns and every county from the boundary read when it lands', () => {
    const body = { name: 'Mascoma Lake', type: 'reservoir' as const, states: ['NH'] };
    const data = namesFromBody(body, {
      towns: ['Enfield', 'Lebanon'],
      counties: ['Grafton County'],
      states: ['NH'],
      computedAt: 1,
    });
    expect(data.place.admin).toEqual({
      towns: ['Enfield', 'Lebanon'],
      counties: ['Grafton County'],
    });
    expect(
      namesFromBody(body, { towns: ['Enfield'], counties: [], states: [], computedAt: 1 }).place
        .admin,
    ).toEqual({ towns: ['Enfield'], counties: [] });
  });

  it('says the towns aren’t computed yet until the geometry is — never that it is in none', () => {
    const body = { name: 'Mascoma Lake', type: 'reservoir' as const };
    expect(namesFromBody(body, null).place.admin).toBe('not-computed');
    expect(
      namesFromBody(body, { towns: [], counties: [], states: [], computedAt: 1 }).place.admin,
    ).toEqual({ towns: [], counties: [] });
  });

  it('keeps the boundary read’s state: loading stays loading, a failure is named', () => {
    const body = { name: 'Mascoma Lake', type: 'reservoir' as const };
    expect(namesFromBody(body, undefined).place.admin).toBeUndefined();
    const failed = namesFromBody(body, FAILED_READ);
    expect(failed.place.admin).toBe(FAILED_READ);
    expect(failed.failures).toEqual(['the towns and county']);
  });

  it('names every state a border body is in', () => {
    const data = namesFromBody(
      { name: 'Lake Champlain', type: 'lakePond', states: ['VT', 'NY'] },
      null,
    );
    expect(data.place.states).toEqual(['VT', 'NY']);
  });
});

describe('the location’s words', () => {
  it('writes a corpus state out, and puts it in the United States', () => {
    expect(stateName('NH')).toBe('New Hampshire');
    expect(stateName('QC')).toBe('QC');
    expect(countryOf('VT')).toBe('United States');
    expect(countryOf('QC')).toBeNull();
    expect(countryOf(null)).toBeNull();
  });

  it('offers every class not already a row under Another class', () => {
    expect(otherClasses([{ cls: 'reservoir', sources: [] }], 'reservoir')).not.toContain(
      'reservoir',
    );
    expect(otherClasses(null, 'bay')).toEqual([
      'lakePond',
      'wetland',
      'reservoir',
      'river',
      'unclassified',
    ]);
  });
});

describe('namesMapScene', () => {
  it('draws each town line with its two towns either side, and lights the one named', () => {
    const scene = namesMapScene(MASCOMA_NAMES, 'townLine:lebanon-enfield');
    expect(scene.items.map((i) => [i.kind, i.id])).toEqual([
      ['line', 'townLine:canaan-enfield'],
      ['label', 'townName:canaan-enfield.l'],
      ['label', 'townName:canaan-enfield.r'],
      ['line', 'townLine:lebanon-enfield'],
      ['label', 'townName:lebanon-enfield.l'],
      ['label', 'townName:lebanon-enfield.r'],
    ]);
    expect(scene.items[1]).toMatchObject({ text: 'Canaan', style: 'town', layer: 'outline' });
    expect(scene.items[0]).toMatchObject({
      style: 'townLine',
      path: [[-72.0617, 43.62544], expect.anything(), expect.anything()],
    });
    expect(scene.lit).toBe('townLine:lebanon-enfield');
  });

  it('draws nothing until the boundary read lands; a lit row off the map is not lit there', () => {
    const scene = namesMapScene(
      { ...MASCOMA_NAMES, place: { ...MASCOMA_NAMES.place, townLines: null } },
      'alias:0',
    );
    expect(scene).toEqual({ items: [], lit: null });
  });
});

describe('townNames', () => {
  it('faces the two towns across the longest run, the left one north of a west–east line', () => {
    const t = must(
      townNames([
        { lat: 43, lng: -72.2 },
        { lat: 43, lng: -72.1 },
        { lat: 43.001, lng: -72.1 },
      ]),
    );
    expect(t.angle).toBeCloseTo(0, 5);
    expect(t.left[1]).toBeGreaterThan(43);
    expect(t.right[1]).toBeLessThan(43);
    expect(t.left[0]).toBeCloseTo(-72.15, 5);
  });

  it('reads a line left to right whichever way it was drawn, and gives up on a point', () => {
    const east = must(
      townNames([
        { lat: 43, lng: -72 },
        { lat: 43.01, lng: -72.01 },
      ]),
    );
    const west = must(
      townNames([
        { lat: 43.01, lng: -72.01 },
        { lat: 43, lng: -72 },
      ]),
    );
    expect(east.angle).toBeCloseTo(west.angle, 5);
    expect(east.angle).toBeGreaterThan(0);
    expect(townNames([{ lat: 1, lng: 1 }])).toBeNull();
    expect(
      townNames([
        { lat: 1, lng: 1 },
        { lat: 1, lng: 1 },
      ]),
    ).toBeNull();
  });

  it('reads a due north–south run the same whichever end it was drawn from, its left the west', () => {
    const north = must(
      townNames([
        { lat: 43, lng: -72 },
        { lat: 43.01, lng: -72 },
      ]),
    );
    const south = must(
      townNames([
        { lat: 43.01, lng: -72 },
        { lat: 43, lng: -72 },
      ]),
    );
    expect(south.angle).toBeCloseTo(north.angle, 5);
    expect(south.left[0]).toBeCloseTo(north.left[0], 9);
    expect(north.left[0]).toBeLessThan(-72);
    expect(south.left[0]).toBeLessThan(-72);
  });
});

function must<T>(v: T | null): T {
  if (v === null) throw new Error('missing');
  return v;
}

describe('town lines from each town’s outline', () => {
  // A square town, counter-clockwise or not, around the body at the origin.
  const square = (w: number, s: number, e: number, n: number, ccw: boolean) => {
    const ring = [
      [w, s],
      [e, s],
      [e, n],
      [w, n],
      [w, s],
    ];
    return ccw ? ring : [...ring].reverse();
  };
  const inside = ([lng = 0, lat = 0]: readonly number[], [w, s, e, n]: readonly number[]) =>
    lng > (w ?? 0) && lng < (e ?? 0) && lat > (s ?? 0) && lat < (n ?? 0);

  it('names each line on its own town’s side, whichever way the outline was drawn', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.2, noNaN: true }),
        fc.double({ min: 0.01, max: 0.2, noNaN: true }),
        fc.boolean(),
        (half, tall, ccw) => {
          const box = [-half, 43 - tall, half, 43 + tall] as const;
          const { lines } = townLinesFrom(
            {
              towns: [
                { name: 'Enfield', state: 'NH', ring: square(box[0], box[1], box[2], box[3], ccw) },
              ],
              capped: false,
              computedAt: 1,
            },
            null,
          );
          for (const line of lines) {
            const at = townNames(line.path);
            if (at === null) continue;
            const named = line.faces[0] === 'Enfield' ? at.left : at.right;
            expect(line.faces).toContain('');
            expect(inside(named, box)).toBe(true);
          }
        },
      ),
    );
  });

  it('draws only where an outline passes near the body, and counts a town with none stored', () => {
    const { lines, missing } = townLinesFrom(
      {
        towns: [
          // Its east side runs past the body; the rest lies far off.
          { name: 'Canaan', state: 'NH', ring: square(-1, 42, 0.001, 44, true) },
          { name: 'Lebanon', state: 'NH', ring: null },
        ],
        capped: false,
        computedAt: 1,
      },
      [0, 42.99, 0.01, 43.01],
    );
    expect(missing).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path.every((p) => p.lng === 0.001)).toBe(true);
    expect(townLinesFrom(null, null)).toEqual({ lines: [], missing: 0 });
  });

  it('draws a stretch that runs through the ring’s start as one line, named once', () => {
    // The square starts at its south-west corner; the body sits there, so the stretch near it is the
    // ring's last side and its first — one line, never two pieces each named.
    const { lines } = townLinesFrom(
      {
        towns: [{ name: 'Canaan', state: 'NH', ring: square(0, 43, 1, 44, true) }],
        capped: false,
        computedAt: 1,
      },
      [-0.001, 42.999, 0.001, 43.001],
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.path.map((p) => [p.lng, p.lat])).toEqual([
      [0, 44],
      [0, 43],
      [1, 43],
    ]);
  });

  it('says what the map leaves out, and nothing when it leaves out nothing', () => {
    expect(townLinesShortWords(undefined)).toBeNull();
    expect(townLinesShortWords({ unstored: 0, capped: false })).toBeNull();
    expect(townLinesShortWords({ unstored: 1, capped: false })).toBe(
      'On the map, 1 town’s line isn’t stored yet',
    );
    expect(townLinesShortWords({ unstored: 2, capped: true })).toBe(
      'On the map, 2 towns’ lines aren’t stored yet; more towns than one read returns: some lines aren’t drawn',
    );
  });

  it('carries the read into the data, a failed read said and never drawn as no lines', () => {
    const body = {
      name: 'Mascoma Lake',
      type: 'reservoir' as const,
      bbox: { minLng: 0, minLat: 42.99, maxLng: 0.01, maxLat: 43.01 },
    };
    const read = {
      towns: [{ name: 'Lebanon', state: 'NH', ring: null }],
      capped: false,
      computedAt: 1,
    };
    const data = namesFromBody(body, null, { townLinesRead: read });
    expect(data.place.townLines).toEqual([]);
    expect(data.place.townLinesShort).toEqual({ unstored: 1, capped: false });
    const failed = namesFromBody(body, null, { townLinesRead: FAILED_READ });
    expect(failed.place.townLines).toBeNull();
    expect(failed.failures).toContain('the town lines');
  });
});

describe('namesWithPicks', () => {
  const body = {
    name: 'Lake Auburn',
    type: 'reservoir' as const,
    nameClaims: [
      { source: 'user' as const, value: 'Lake Auburn' },
      { source: 'nhd' as const, value: 'The Basin' },
      { source: 'osm' as const, value: 'Lake Auburn' },
    ],
  };
  const data = namesFromBody(body, null, {
    identity: {
      bodyClass: 'reservoir',
      classClaims: [{ source: 'osm', value: 'lakePond' }],
      moderatorClass: 'reservoir',
      baseClass: 'lakePond',
      moderatorAliases: [],
    },
  });

  it('keeps the data itself when the server already holds both picks', () => {
    expect(namesWithPicks(data, { name: 'Lake Auburn', cls: 'reservoir' })).toBe(data);
  });

  it('a name chosen wears Now; the ranking puts its first rung back', () => {
    const chosen = namesWithPicks(data, { name: 'The Basin', cls: 'reservoir' });
    expect(chosen.name).toBe('The Basin');
    expect(chosen.rungs.map((r) => r.now)).toEqual([true, false]);
    const ranked = namesWithPicks(data, { name: null, cls: 'reservoir' });
    expect(ranked).toMatchObject({ name: 'The Basin', overridden: false });
  });

  it('a clear shows the class it puts back, or keeps the record’s when the read can’t say', () => {
    expect(namesWithPicks(data, { name: 'Lake Auburn', cls: null })).toMatchObject({
      cls: 'lakePond',
      moderatorClass: null,
    });
    const unknown = { ...data, baseClass: null };
    expect(namesWithPicks(unknown, { name: 'Lake Auburn', cls: null }).cls).toBe('reservoir');
  });

  it('a class the catalogs never gave still has a row to sit on', () => {
    const picked = namesWithPicks(data, { name: 'Lake Auburn', cls: 'wetland' });
    expect(picked.classOptions?.map((o) => o.cls)).toContain('wetland');
  });
});
