import { describe, expect, it } from 'vitest';

import {
  classifyName,
  classifyNhd,
  classifyOsmTags,
  classifyThreeDhp,
  classifyWaterBody,
  nameAssertsReservoir,
  type SourceClaim,
} from './waterClass';

/** Shorthand: run the whole ladder for an OSM feature. */
const osm = (name: string, tags: Record<string, string | undefined>) =>
  classifyWaterBody({ name, claim: classifyOsmTags(tags) });

describe('classifyOsmTags', () => {
  it('maps the still-water subtags', () => {
    expect(classifyOsmTags({ natural: 'water', water: 'lake' })).toMatchObject({
      cls: 'lakePond',
    });
    expect(classifyOsmTags({ natural: 'water', water: 'pond' })).toMatchObject({
      cls: 'lakePond',
    });
    expect(classifyOsmTags({ natural: 'water', water: 'reservoir' })).toMatchObject({
      cls: 'reservoir',
    });
    expect(classifyOsmTags({ natural: 'bay' })).toMatchObject({ cls: 'bay' });
    expect(classifyOsmTags({ landuse: 'reservoir' })).toMatchObject({
      cls: 'reservoir',
    });
  });

  // The census found 24,452 `wetland=swamp` polygons that the old classifier accepted none of, while
  // NHD's SwampMarsh FTYPE — which we do accept — covers exactly the same ground. That asymmetry is
  // the thing D96 exists to close, so it gets a test rather than a comment.
  it('accepts every wetland value, not just marsh', () => {
    for (const wetland of ['marsh', 'swamp', 'bog', 'fen', 'wet_meadow', 'reedbed']) {
      expect(classifyOsmTags({ natural: 'wetland', wetland })).toMatchObject({
        cls: 'wetland',
      });
    }
  });

  it('refuses tidal wetland, which does not hold ice', () => {
    expect(classifyOsmTags({ natural: 'wetland', wetland: 'saltmarsh' }).outcome).toBe('drop');
    expect(classifyOsmTags({ natural: 'wetland', wetland: 'tidalflat' }).outcome).toBe('drop');
  });

  // 2,818 features, every one of which reached the corpus as `other` before this table existed.
  it('refuses salt pannes', () => {
    expect(classifyOsmTags({ natural: 'water', water: 'salt_pool' }).outcome).toBe('drop');
  });

  describe('semicolon multi-values', () => {
    // An exact-match lookup on `lake;pond` matches nothing and says nothing about it.
    it('resolves the list rather than matching the joined string', () => {
      expect(classifyOsmTags({ natural: 'water', water: 'lake;pond' })).toMatchObject({
        cls: 'lakePond',
      });
    });

    it('lets the strongest member win, in either order', () => {
      expect(classifyOsmTags({ natural: 'water', water: 'river;reservoir' })).toMatchObject({
        cls: 'reservoir',
      });
      expect(classifyOsmTags({ natural: 'water', water: 'reservoir;river' })).toMatchObject({
        cls: 'reservoir',
      });
    });

    it('drops when every member is a drop', () => {
      expect(classifyOsmTags({ natural: 'water', water: 'river;canal' }).outcome).toBe('drop');
    });
  });

  it('treats bare natural=water as silence, not as a class', () => {
    // 113,880 features. It is the single largest thing in the corpus and it means "nobody said".
    expect(classifyOsmTags({ natural: 'water' }).outcome).toBe('silent');
  });

  it('treats an unseen value as silence and names it, so the table can grow', () => {
    const out = classifyOsmTags({ natural: 'water', water: 'brand_new_value' });
    expect(out.outcome).toBe('silent');
    expect(out.token).toContain('brand_new_value');
  });
});

describe('classifyNhd', () => {
  it('maps the four in-region FTYPEs', () => {
    expect(classifyNhd(390)).toMatchObject({ cls: 'lakePond' });
    expect(classifyNhd(466)).toMatchObject({ cls: 'wetland' });
    expect(classifyNhd(493)).toMatchObject({ cls: 'bay' }); // estuary — filtered by elevation, not class
    expect(classifyNhd(436, 43600)).toMatchObject({ cls: 'reservoir' });
  });

  // The FCODE domain is the lever D96 found was missing for wetland but which does exist here.
  it('drops sewage, tailings, cooling and treatment reservoirs', () => {
    for (const fcode of [43612, 43624, 43604, 43609, 43608, 43611]) {
      expect(classifyNhd(436, fcode).outcome).toBe('drop');
    }
  });

  it('keeps water-storage reservoirs — the ones whose access rules are the point', () => {
    for (const fcode of [43613, 43614, 43615, 43617, 43621]) {
      expect(classifyNhd(436, fcode)).toMatchObject({ cls: 'reservoir' });
    }
  });

  it('keeps intermittent lake/pond rather than second-guessing the floor', () => {
    expect(classifyNhd(390, 39001)).toMatchObject({ cls: 'lakePond' });
  });

  it('drops sea, playa and ice mass', () => {
    for (const ftype of [445, 361, 378]) expect(classifyNhd(ftype).outcome).toBe('drop');
  });
});

describe('classifyThreeDhp', () => {
  it('maps Lake and refuses river, canal and ocean', () => {
    expect(classifyThreeDhp(3)).toMatchObject({ cls: 'lakePond' });
    expect(classifyThreeDhp(1).outcome).toBe('drop');
    expect(classifyThreeDhp(2).outcome).toBe('drop');
    expect(classifyThreeDhp(4).outcome).toBe('drop');
  });

  // 3DHP publishes no wetland at all, so an absent 3DHP feature must never read as 3DHP disagreeing.
  // If this ever returns `drop`, every NHD wetland in the corpus becomes "contested" overnight.
  it('has no wetland value, and an unknown type is silence rather than refusal', () => {
    expect(classifyThreeDhp(99).outcome).toBe('silent');
  });
});

describe('name keywords', () => {
  it('reads a keyword anywhere in the name, not only at the end', () => {
    expect(classifyName('Lake Fairlee')).toMatchObject({ cls: 'lakePond' });
    expect(classifyName('Lac des Canards')).toMatchObject({ cls: 'lakePond' });
  });

  it('speaks French, because Québec is next', () => {
    expect(classifyName('Étang Payeur')).toMatchObject({ cls: 'lakePond' });
    expect(classifyName('Lac Coulombe')).toMatchObject({ cls: 'lakePond' });
    expect(classifyName('Baie des Chaleurs')).toMatchObject({ cls: 'bay' });
    expect(classifyName('Ruisseau Cold')?.outcome).toBe('drop');
  });

  // Every one of these is a real body in the corpus, and a plain "sounds like moving water" drop list
  // would have deleted all of them. Higley Flow is a New York State Park.
  it.each([
    'Higley Flow',
    'Piercefield Flow',
    'Kings Flow',
  ])('keeps %s, a regional name for still water a drop-list would delete', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'lakePond' });
  });

  // The keep-beats-drop asymmetry, on the five real names that depend on it.
  it.each([
    'Basin Pond',
    'Little Dan Hole Pond',
    'Clay Pit Pond',
    'Windy Pitch Ponds',
    'Round Pond Rips',
  ])('keeps %s: a keep-word outranks a drop-word in the same name', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'lakePond' });
  });

  it('drops the ones with no keep-word to save them', () => {
    for (const name of [
      'Grand Pitch Rapids',
      'Push n’ Be Damned Rips',
      'Rochester Sewage Lagoons',
      'Water Treatment',
      'Fire Cistern',
      'Nassau County Basin #311',
      'Dolly Copp Campground',
    ]) {
      expect(classifyName(name)?.outcome).toBe('drop');
    }
  });

  it('prefers lakePond over wetland when a name carries both', () => {
    expect(classifyName('Bog Pond')).toMatchObject({ cls: 'lakePond' });
    expect(classifyName('Marsh Pond')).toMatchObject({ cls: 'lakePond' });
  });

  it('returns nothing for a name that says nothing', () => {
    expect(classifyName('Fort Eddy')).toBeUndefined();
    expect(classifyName('Half Moon Cove')).toMatchObject({ cls: 'bay' }); // `cove` does say something
    expect(classifyName('')).toBeUndefined();
  });
});

describe('classifyWaterBody', () => {
  const silentClaim: SourceClaim = {
    outcome: 'silent',
    token: 'osm:natural=water',
  };

  it('lets a name asserting reservoir outrank the catalogue', () => {
    // NHD calls all three of these LakePond; we call them reservoirs, because the concern is use.
    for (const name of [
      'Sugar Hill Reservoir',
      'Gulf Brook Reservoir',
      'Therman W. Dix Reservoir',
    ]) {
      expect(classifyWaterBody({ name, claim: classifyNhd(390) })).toMatchObject({
        cls: 'reservoir',
        basis: 'name-reservoir',
      });
    }
    expect(nameAssertsReservoir('Upper Artichoke Reservoir')).toBe(true);
  });

  it('prefers the catalogue over a name keyword', () => {
    expect(osm('Mud Pond', { natural: 'wetland', wetland: 'bog' })).toMatchObject({
      cls: 'wetland',
      basis: 'source-class',
    });
  });

  it('falls back to the name only when the catalogue is silent', () => {
    expect(classifyWaterBody({ name: 'Occom Pond', claim: silentClaim })).toMatchObject({
      cls: 'lakePond',
      basis: 'name-keyword',
    });
  });

  it('separates the two unresolved cases, because they need different answers', () => {
    // A named body a moderator can actually adjudicate…
    expect(classifyWaterBody({ name: 'Fort Eddy', claim: silentClaim })).toMatchObject({
      cls: 'unclassified',
      basis: 'unresolved-named',
    });
    // …versus one where there is nothing for a human to go on either.
    expect(classifyWaterBody({ name: '', claim: silentClaim })).toMatchObject({
      cls: 'unclassified',
      basis: 'unresolved-unnamed',
    });
  });

  it('never returns `other`, and unclassified is a class rather than a drop', () => {
    const verdict = classifyWaterBody({ name: '', claim: silentClaim });
    expect(verdict.cls).toBe('unclassified');
    expect(verdict.cls).not.toBeNull();
  });
});

describe('the long tail of free-text tag values', () => {
  // OSM's type slot is free text and mappers describe rather than classify. Reading an unmapped value
  // the way we read a name resolves a third of them without a table entry each.
  it.each([
    ['beaver_pond', 'lakePond'],
    ['michawanic_pond', 'lakePond'],
    ['campton_bog', 'wetland'],
    ['string_bog', 'wetland'],
    ["roger's_pond", 'lakePond'],
    ['estuary', 'bay'],
  ])('reads water=%s as %s', (value, cls) => {
    expect(classifyOsmTags({ natural: 'water', water: value })).toMatchObject({
      cls,
    });
  });

  it('still refuses a loose value that names something we drop', () => {
    expect(classifyOsmTags({ natural: 'water', water: 'vernal_pools' }).outcome).toBe('drop');
    expect(classifyOsmTags({ natural: 'water', water: 'penniman_basin' }).outcome).toBe('drop');
  });

  it('marks a loose read so the funnel can tell it from an exact one', () => {
    expect(classifyOsmTags({ natural: 'water', water: 'beaver_pond' }).token).toMatch(/~$/);
  });

  it('leaves a genuine typo as silence for the name to answer', () => {
    expect(classifyOsmTags({ natural: 'water', water: 'sream' }).outcome).toBe('silent');
  });
});

describe('regional vocabulary found by reading the unresolved list', () => {
  // Hudson-Valley Dutch for a marshy meadow. 11 real bodies in New York; nothing else catches them.
  it.each(['Hillabrandt Vly', 'Archer Vly', 'The Vly', 'The Old Fly'])('%s is wetland', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'wetland' });
  });

  it.each([
    'Loch Sheldrake',
    'Lily Mere',
    'The Oxbow',
    'Dorset Quarry',
    'Benson Mines',
    'Streeter Fishpond',
  ])('%s is lakePond', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'lakePond' });
  });

  // A reach so slow the catalogues publish it as a waterbody. NHD calls every one of these
  // `LakePond`; for a skater there is current under the ice, which is the distinction that matters.
  it.each([
    'Debsconeag Deadwater',
    'Nesowadnehunk Deadwater',
    'Cassidy Deadwater',
    'Lower Stillwater',
    'Long Logan',
    'Moose Bogan',
    'Soper Logan',
    'Dead River',
  ])('%s is river', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'river' });
  });

  it('resolves a name carrying both words to the cautious reading', () => {
    // Six real names do this. `river` is checked before `lakePond`, matching CLASS_RANK.
    expect(classifyName('Sewall Deadwater Pond')).toMatchObject({ cls: 'river' });
    expect(classifyName('Stillwater Pond')).toMatchObject({ cls: 'river' });
    // …but `reservoir` still outranks it: Stillwater Reservoir is a 6,233-acre impoundment.
    expect(classifyName('Stillwater Reservoir')).toMatchObject({ cls: 'reservoir' });
  });

  // An Adirondack Flow is a dammed impoundment, not a reach. Cedar River Flow is NHD's own Reservoir.
  it.each([
    'Higley Flow',
    'Crooked Brook Flowage',
    'Kings Flow',
    'Goodnow Flowage',
  ])('%s is lakePond, not river', (name) => {
    expect(classifyName(name)).toMatchObject({ cls: 'lakePond' });
  });

  it.each([
    'Barnstable Marina',
    'Francis Lobster Pound',
    'Fountain of the Continents',
  ])('%s is dropped', (name) => {
    expect(classifyName(name)?.outcome).toBe('drop');
  });
});
