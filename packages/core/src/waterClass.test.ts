import { describe, expect, it } from 'vitest';

import {
  assertsOceanOrGreatLake,
  classifyName,
  classifyNhd,
  classifyOsmTags,
  classifyThreeDhp,
  classifyWaterBody,
  nameAssertsReservoir,
  OCEAN_NAME_VETO_MIN_ACRES,
  type SourceClaim,
} from './waterClass';

/** Local, so this file needs no import for the one unit its area cases are written in. */
const SQ_M_PER_ACRE_TEST = 4046.8564224;

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

  it('lets a positive still-water tag beat a through-waterway tag', () => {
    // Legacy relation tagging leaves `waterway=river` on some reservoir and lake areas. A bare
    // `waterway` defers, but it must never delete a feature that also says plainly what it is —
    // this precedence used to live in `waterBodyTypeFromOsmTags` and moved here with D109.
    expect(
      classifyOsmTags({ natural: 'water', water: 'reservoir', waterway: 'river' }),
    ).toMatchObject({ cls: 'reservoir' });
    expect(classifyOsmTags({ natural: 'bay', waterway: 'river' })).toMatchObject({ cls: 'bay' });
    expect(classifyOsmTags({ landuse: 'reservoir', waterway: 'river' })).toMatchObject({
      cls: 'reservoir',
    });
    // …while bare flowing water, with nothing else asserted, still drops.
    expect(classifyOsmTags({ waterway: 'river' })).toMatchObject({ outcome: 'drop' });
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

describe('assertsOceanOrGreatLake (N7 audit)', () => {
  /** An area comfortably over the gate, so these cases test the *name* half of the rule. */
  const OCEANIC = 1_000_000 * SQ_M_PER_ACRE_TEST;

  it('names the Great Lakes New York borders', () => {
    // NHD publishes Erie as FTYPE 390 `LakePond`, so no class rule refuses it, and the merge's token
    // veto could only fire if 3DHP's counterpart matched geometrically. A name needs no match.
    expect(assertsOceanOrGreatLake('Lake Erie', OCEANIC)).toBe(true);
    expect(assertsOceanOrGreatLake('Lake Ontario', OCEANIC)).toBe(true);
  });

  it('names Long Island Sound and the Atlantic', () => {
    expect(assertsOceanOrGreatLake('Long Island Sound', OCEANIC)).toBe(true);
    expect(assertsOceanOrGreatLake('Atlantic Ocean', OCEANIC)).toBe(true);
    expect(assertsOceanOrGreatLake('Gulf of Maine', OCEANIC)).toBe(true);
  });

  it('is case- and accent-insensitive, because `\\b` is ASCII-only in JavaScript', () => {
    expect(assertsOceanOrGreatLake('LAKE ERIE', OCEANIC)).toBe(true);
  });

  it('does NOT refuse the many New England places named after the sea', () => {
    // A bare `ocean` would delete real bodies, which is why it is not in the pattern. Same asymmetry
    // `NAME_DROP` lives by: keeping one body nobody skates is cheap, deleting a real one is not.
    expect(assertsOceanOrGreatLake('Ocean Pond', OCEANIC)).toBe(false);
    expect(assertsOceanOrGreatLake('Ocean Point Cove', OCEANIC)).toBe(false);
    expect(assertsOceanOrGreatLake('Great Pond', OCEANIC)).toBe(false);
    expect(assertsOceanOrGreatLake('Sound Pond', OCEANIC)).toBe(false);
  });

  // ── The area gate (N7 second audit, 2026-08-06) ────────────────────────────
  //
  // The name-only rule was measured against the master list and it deleted **two real New York
  // lakes**. Both are in the region, both are the size of an ordinary pond, and the only trace either
  // would have left is `+2` on a `vetoed-name` counter.

  it('keeps Lake Superior, New York — a 179-acre lake in Sullivan County', () => {
    expect(assertsOceanOrGreatLake('Lake Superior', 179 * SQ_M_PER_ACRE_TEST)).toBe(false);
  });

  it('keeps Little Lake Erie, a 4-acre reservoir the substring rule matched', () => {
    expect(assertsOceanOrGreatLake('Little Lake Erie', 4 * SQ_M_PER_ACRE_TEST)).toBe(false);
  });

  it('still refuses the real Lake Erie, which is 6.4 million acres', () => {
    expect(assertsOceanOrGreatLake('Lake Erie', 6_400_000 * SQ_M_PER_ACRE_TEST)).toBe(true);
  });

  it('refuses to fire at all without an area, because the name is not the rule', () => {
    expect(assertsOceanOrGreatLake('Lake Erie')).toBe(false);
  });

  it('sits below the smallest body the list names', () => {
    // Long Island Sound, 801,802 ac, is the smallest entry — so the gate can never shield one of
    // them. It does not have to sit above the bodies we cover: Moosehead (75,416 ac) and Champlain
    // (~271,000) clear the gate and are refused by neither, because the **name** still has to match.
    expect(OCEAN_NAME_VETO_MIN_ACRES).toBeLessThan(801_802);
    expect(assertsOceanOrGreatLake('Moosehead Lake', 75_416 * SQ_M_PER_ACRE_TEST)).toBe(false);
    expect(assertsOceanOrGreatLake('Lake Champlain', 271_000 * SQ_M_PER_ACRE_TEST)).toBe(false);
  });
});

describe('the source token survives the classification ladder', () => {
  it('keeps the catalogue token when a name overrules the class', () => {
    // The veto is keyed on the catalogue's own token. Rung 1 returns early with `name:reservoir`,
    // which used to discard the only evidence that a feature was a tidal estuary — so a vetoed body
    // whose name happened to say "Reservoir" entered the corpus on a technicality.
    const v = classifyWaterBody({
      name: 'Tidewater Reservoir',
      claim: classifyNhd(493),
    });
    expect(v.cls).toBe('reservoir');
    expect(v.token).toBe('name:reservoir');
    expect(v.sourceToken).toBe('nhd:ftype=493');
  });

  it('keeps it when a name keyword decides a silent catalogue', () => {
    const v = classifyWaterBody({ name: 'Mud Pond', claim: classifyOsmTags({ natural: 'water' }) });
    expect(v.token).toBe('name:lakePond');
    expect(v.sourceToken).toBe('osm:natural=water');
  });

  it('keeps it on an ordinary source-class verdict, where the two agree', () => {
    const v = classifyWaterBody({ name: '', claim: classifyThreeDhp(4) });
    expect(v.sourceToken).toBe('3dhp:featuretype=4');
    expect(v.token).toBe(v.sourceToken);
  });
});
