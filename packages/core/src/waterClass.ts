/**
 * **Every catalogue's vocabulary, mapped into ours** (N7, D109).
 *
 * Three publishers describe the same water in three languages, and until this file existed we spoke
 * only one of them — the OSM classifier in `./osm` — while silently dropping the rest into `other`.
 * A census over all three archives (2026-08-04) put numbers on what that cost:
 *
 * - **OSM ships 24,452 `wetland=swamp` polygons and we imported none of them**, because the
 *   classifier accepted `wetland=marsh` alone, while NHD lumps swamp and marsh into one FTYPE that we
 *   *do* accept. That is the D96 parity gap, measured: a factor of 2.4 on OSM's side by itself.
 * - **`water=salt_pool` is 2,818 features** — coastal salt pannes, never skateable — and every one of
 *   them landed in `other` rather than being refused.
 * - **`water=lake;pond` exists** (21 features), and an exact-match lookup on a semicolon-joined value
 *   matches nothing. Multi-valued OSM tags are ordinary and our reader could not read them.
 * - **NHD's Reservoir FTYPE has 23 FCODEs** distinguishing water storage from sewage treatment,
 *   tailings and cooling ponds. We were treating all of them as one thing.
 *
 * **The vocabularies are read from the sources, not from memory.** NHD's FCODE meanings below are
 * transcribed from the coded-value domains inside the geodatabase itself (`ogrinfo -json`, domains
 * `LakePond FCode` / `Reservoir FCode` / `SwampMarsh FCode`), and 3DHP's from its `featuretypelabel`
 * column. That matters because this file is where a plausible guess would survive longest: a wrong
 * FCODE label produces a wrong class on a handful of rows and no error anywhere.
 *
 * @see `WATER_BODY_CLASSES` in `./types` for why the target vocabulary is five values.
 */

import type { WaterBodyClass } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// The claim a source makes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one catalogue says about one feature.
 *
 * **Three outcomes, not two, and the third is the one that keeps being got wrong.** `silent` means
 * the source carries no opinion — `natural=water` with no subtag, which is 96% of our `other` — and
 * it is *not* the same as `drop`. Reading silence as a negative is how 3DHP, which has no wetland
 * class at all, would otherwise "disagree" with every wetland NHD publishes.
 */
export type SourceClaim =
  | {
      readonly outcome: 'class';
      readonly cls: WaterBodyClass;
      /** A stable token for the drop ledger and the dry-run funnel, e.g. `osm:water=lake`. */
      readonly token: string;
    }
  | { readonly outcome: 'drop'; readonly token: string }
  | { readonly outcome: 'silent'; readonly token: string };

const claim = (cls: WaterBodyClass, token: string): SourceClaim => ({
  outcome: 'class',
  cls,
  token,
});
const drop = (token: string): SourceClaim => ({ outcome: 'drop', token });
const silent = (token: string): SourceClaim => ({ outcome: 'silent', token });

/**
 * Which class wins when one feature carries two claims.
 *
 * **`reservoir` outranks `lakePond` on purpose** (founder call, 2026-08-04): the catalogues disagree
 * constantly — NHD calls 1,717 of our reservoirs `LakePond`, because it classes a dammed lake by what
 * it *is* — but the reason we keep the class at all is that a reservoir may carry use restrictions or
 * drinking-water concerns. Being wrong toward "treat this more carefully" is the safe direction.
 *
 * `lakePond` outranks `wetland` for the reason D96 already argues in the other direction: where two
 * sources disagree about whether something is open water or bog, the open-water reading keeps a body
 * that the unnamed-wetland area bar would otherwise delete. Bog Pond is a pond.
 */
const CLASS_RANK: Record<WaterBodyClass, number> = {
  reservoir: 0,
  lakePond: 1,
  bay: 2,
  wetland: 3,
  unclassified: 4,
};

/** The stronger of two claims: a class beats a drop, and `CLASS_RANK` breaks a class-vs-class tie. */
function strongerClaim(a: SourceClaim, b: SourceClaim): SourceClaim {
  if (a.outcome === 'class' && b.outcome === 'class') {
    return CLASS_RANK[a.cls] <= CLASS_RANK[b.cls] ? a : b;
  }
  if (a.outcome === 'class') return a;
  if (b.outcome === 'class') return b;
  // Two non-classes: a drop is a decision and silence is not, so the drop carries more information.
  return a.outcome === 'drop' ? a : b;
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenStreetMap
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `water=*` → our class, over **every value present in the five-state extracts** (196,393 polygons,
 * censused 2026-08-04). Anything absent from this table is genuinely unseen, not merely unhandled.
 */
const OSM_WATER: Readonly<Record<string, SourceClaim>> = {
  // Still water we cover.
  lake: claim('lakePond', 'osm:water=lake'),
  pond: claim('lakePond', 'osm:water=pond'),
  fishpond: claim('lakePond', 'osm:water=fishpond'),
  // An oxbow is a cut-off river bend — still water by the time it is one, and it freezes like a pond.
  oxbow: claim('lakePond', 'osm:water=oxbow'),
  // Flooded quarries are deep, sheltered and genuinely skated (founder call, 2026-08-04).
  quarry_lake: claim('lakePond', 'osm:water=quarry_lake'),
  reservoir: claim('reservoir', 'osm:water=reservoir'),
  bay: claim('bay', 'osm:water=bay'),
  cove: claim('bay', 'osm:water=cove'),
  harbour: claim('bay', 'osm:water=harbour'),
  sound: claim('bay', 'osm:water=sound'),
  wetland: claim('wetland', 'osm:water=wetland'),

  // Flowing water — deferred since Phase 1, and `rapids` was never in the list.
  river: drop('osm:water=river'),
  stream: drop('osm:water=stream'),
  creek: drop('osm:water=creek'),
  canal: drop('osm:water=canal'),
  ditch: drop('osm:water=ditch'),
  drain: drop('osm:water=drain'),
  lock: drop('osm:water=lock'),
  moat: drop('osm:water=moat'),
  tidal_channel: drop('osm:water=tidal_channel'),
  rapids: drop('osm:water=rapids'),
  waterfall: drop('osm:water=waterfall'),
  fish_pass: drop('osm:water=fish_pass'),
  stream_pool: drop('osm:water=stream_pool'),

  // Salt water. The largest single miss in the old classifier: 2,818 `salt_pool` polygons, mostly
  // Massachusetts salt pannes, all of which reached the corpus as `other`.
  salt_pool: drop('osm:water=salt_pool'),
  saltpool: drop('osm:water=saltpool'),
  salt_panne: drop('osm:water=salt_panne'),

  // Built infrastructure and things that are not a place.
  wastewater: drop('osm:water=wastewater'),
  basin: drop('osm:water=basin'),
  slip: drop('osm:water=slip'),
  pool: drop('osm:water=pool'),
  reflecting_pool: drop('osm:water=reflecting_pool'),
  'reflecting pool': drop('osm:water=reflecting pool'), // yes, with a space — it is in the data
  fountain: drop('osm:water=fountain'),
  faucet: drop('osm:water=faucet'),
  handpump: drop('osm:water=handpump'),

  // Hydrographic qualifiers wearing the type slot. They say *how* the water behaves, not what it is,
  // so they are silence rather than a class — the name gets its turn next.
  yes: silent('osm:water=yes'),
  shallow: silent('osm:water=shallow'),
  intermittent: silent('osm:water=intermittent'),
  // Coastal lagoon or sewage lagoon, and the tag does not say which. 45 features; left for a human.
  lagoon: silent('osm:water=lagoon'),
};

/**
 * `wetland=*` → our class. **Eight values, of which the old classifier accepted one.**
 *
 * Salt marsh and tidal flat are refused rather than admitted as wetland: they are tidal, they do not
 * hold ice, and admitting them would put 4,771 coastal polygons into a class whose area bar is the
 * only thing standing between the corpus and every bog in New England.
 */
const OSM_WETLAND: Readonly<Record<string, SourceClaim>> = {
  marsh: claim('wetland', 'osm:wetland=marsh'),
  swamp: claim('wetland', 'osm:wetland=swamp'),
  wooded_swamp: claim('wetland', 'osm:wetland=wooded_swamp'),
  bog: claim('wetland', 'osm:wetland=bog'),
  peat_bog: claim('wetland', 'osm:wetland=peat_bog'),
  fen: claim('wetland', 'osm:wetland=fen'),
  wet_meadow: claim('wetland', 'osm:wetland=wet_meadow'),
  wet_marsh: claim('wetland', 'osm:wetland=wet_marsh'),
  reedbed: claim('wetland', 'osm:wetland=reedbed'),
  marsh_wetland: claim('wetland', 'osm:wetland=marsh_wetland'),
  'freshwater_forested/shrub_wetland': claim('wetland', 'osm:wetland=freshwater_forested'),
  wetland: claim('wetland', 'osm:wetland=wetland'),
  yes: claim('wetland', 'osm:wetland=yes'),
  mud: claim('wetland', 'osm:wetland=mud'),
  pond: claim('lakePond', 'osm:wetland=pond'),

  // Tidal.
  saltmarsh: drop('osm:wetland=saltmarsh'),
  tidalflat: drop('osm:wetland=tidalflat'),

  // A vernal pool is dry for most of the year and tiny; the area floor would take it anyway, but
  // saying so here means the drop is counted rather than inferred.
  vernal_pool: drop('osm:wetland=vernal_pool'),
  vernalpool: drop('osm:wetland=vernalpool'),
};

/** A raw OSM feature's tag bag. Re-declared rather than imported so this file stands alone. */
export type OsmTagBag = Record<string, string | undefined>;

/**
 * Read one OSM tag value, honouring **semicolon multi-values** (`water=lake;pond`).
 *
 * OSM's convention for "both of these apply" is a semicolon list, and an exact-match lookup on the
 * joined string matches nothing — silently, which is the failure mode this whole phase keeps finding.
 * `river;canal` drops, `lake;pond` is a lake/pond, and `river;reservoir` is a reservoir, because
 * `strongerClaim` resolves the list rather than the first element winning by accident.
 */
function readTag(
  value: string | undefined,
  table: Readonly<Record<string, SourceClaim>>,
  key: string,
): SourceClaim | undefined {
  if (value === undefined) return undefined;
  const parts = value
    .split(';')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return undefined;
  let out: SourceClaim | undefined;
  for (const part of parts) {
    const found = table[part] ?? looseValue(part, key);
    if (!found) continue;
    out = out === undefined ? found : strongerClaim(out, found);
  }
  // A value present but unknown to the table is not silence — it is a value we have never seen, and
  // the dry run needs to surface it by name so the table can grow.
  return out ?? silent(`${key}=${parts.join(';')}?`);
}

/**
 * Read an **unmapped** tag value the way we read a name.
 *
 * OSM's type slot is free text, and mappers put descriptions in it: `water=beaver_pond`,
 * `wetland=campton_bog`, `wetland=roger's_pond`, `water=michawanic_pond`, `wetland=string_bog`,
 * `water=vernal_pools`. None of these is a documented value and all of them say plainly what the
 * feature is — so the keyword table we already have for names answers them, and one rule replaces a
 * long tail of one-off table entries that would need adding again next extract.
 *
 * The token keeps a `~` so the funnel can tell a loose read from an exact one; a loose read that
 * starts producing volume is a sign the strict table is missing a value that has become common.
 */
function looseValue(value: string, key: string): SourceClaim | undefined {
  const guess = classifyName(value.replace(/[_-]+/g, ' '));
  if (guess === undefined) return undefined;
  return guess.outcome === 'class'
    ? claim(guess.cls, `${key}=${value}~`)
    : drop(`${key}=${value}~`);
}

/** What OpenStreetMap says this feature is. */
export function classifyOsmTags(tags: OsmTagBag): SourceClaim {
  const claims: SourceClaim[] = [];

  const water = readTag(tags.water, OSM_WATER, 'osm:water');
  if (water) claims.push(water);

  const wetland = readTag(tags.wetland, OSM_WETLAND, 'osm:wetland');
  if (wetland) claims.push(wetland);

  if (tags.landuse === 'reservoir') claims.push(claim('reservoir', 'osm:landuse=reservoir'));
  if (tags.natural === 'bay') claims.push(claim('bay', 'osm:natural=bay'));

  if (claims.length > 0) return claims.reduce(strongerClaim);

  // No positive signal. A `waterway` polygon with nothing else is flowing water; `natural=water` and
  // `natural=wetland` are the two big silences — 113,880 and 81,762 features respectively — where the
  // mapper drew water and never said what kind.
  if (tags.natural === 'wetland') return claim('wetland', 'osm:natural=wetland');
  if (tags.waterway !== undefined) return drop(`osm:waterway=${tags.waterway}`);
  if (tags.natural === 'water') return silent('osm:natural=water');
  return drop('osm:not-water');
}

// ─────────────────────────────────────────────────────────────────────────────
// NHD
// ─────────────────────────────────────────────────────────────────────────────

/** NHD FTYPE → our class. Counts are distinct features ≥ 1 acre across the five archived states. */
const NHD_FTYPE: Readonly<Record<number, WaterBodyClass | null>> = {
  390: 'lakePond', // LakePond   62,809
  436: 'reservoir', // Reservoir     771 — but see NHD_RESERVOIR_DROP_FCODES
  466: 'wetland', // SwampMarsh 44,295
  // An estuary is a tidal arm, which is the same shape of thing as a bay and is filtered the same
  // way — by elevation, not by class. 115 features.
  493: 'bay', // Estuary       115
  445: null, // SeaOcean        0 in-region
  361: null, // Playa           0 in-region
  378: null, // IceMass         0 in-region
};

/**
 * Reservoir FCODEs that are **infrastructure rather than water anyone goes to**.
 *
 * Transcribed from the geodatabase's own `Reservoir FCode` domain. Roughly 43% of NHD's in-region
 * reservoirs above an acre carry one of these — sewage treatment ponds are the single largest group.
 *
 * The complement is the interesting half and the reason the class survives at all: 43613 / 43614 /
 * 43615 / 43617 / 43621 are *Water Storage*, i.e. the drinking-water reservoirs whose access rules
 * are exactly the concern that keeps `reservoir` in the enum.
 */
const NHD_RESERVOIR_DROP_FCODES: ReadonlySet<number> = new Set([
  43603, // Decorative Pool
  43604, // Tailings Pond; Earthen
  43605, // Tailings Pond
  43606, // Disposal
  43607, // Evaporator
  43608, // Swimming Pool
  43609, // Cooling Pond
  43610, // Filtration Pond
  43611, // Settling Pond
  43612, // Sewage Treatment Pond
  43623, // Evaporator; Earthen
  43624, // Treatment
  43625, // Disposal; Earthen
  43626, // Disposal; Nonearthen
]);

/**
 * LakePond FCODEs meaning the water **is not always there**.
 *
 * Kept, not dropped — an intermittent pond is still a pond, and D91's floor plus a name are better
 * evidence than a hydrographic qualifier. Recorded so the dry run can count them and so a future
 * "why did we ship a dry lakebed" question has an answer waiting.
 */
export const NHD_INTERMITTENT_FCODES: ReadonlySet<number> = new Set([
  39001, // Hydrographic Category = Intermittent
  39005, // Intermittent; Stage = High Water Elevation
  39006, // Intermittent; Stage = Date of Photography
]);

/** What NHD says this feature is, given its FTYPE and FCODE. */
export function classifyNhd(ftype: number, fcode?: number): SourceClaim {
  const mapped = NHD_FTYPE[ftype];
  if (mapped === undefined) return silent(`nhd:ftype=${ftype}?`);
  if (mapped === null) return drop(`nhd:ftype=${ftype}`);
  if (mapped === 'reservoir' && fcode !== undefined && NHD_RESERVOIR_DROP_FCODES.has(fcode)) {
    return drop(`nhd:fcode=${fcode}`);
  }
  return claim(mapped, `nhd:ftype=${ftype}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3DHP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 3DHP `featuretype` → our class. **Four values in the whole layer**, and the gap is the finding:
 *
 * | | in the Northeast clip | ≥ 1 acre |
 * | --- | --- | --- |
 * | 3 Lake | 269,622 | 60,823 |
 * | 1 River | 5,203 | 4,101 |
 * | 2 Canal | 150 | 129 |
 * | 4 Ocean or Great Lake | 19 | 19 |
 *
 * **There is no wetland class.** NHD publishes 44,295 SwampMarsh features above an acre in the same
 * region and 3DHP carries none of them, while its Lake count tracks NHD's LakePond almost exactly.
 * So 3DHP saying nothing about a body is *not* 3DHP disagreeing — a distinction that decides whether
 * every NHD wetland gets scored as contested. This is why `SourceClaim` has a `silent` outcome.
 */
const THREE_DHP_FEATURETYPE: Readonly<Record<number, WaterBodyClass | null>> = {
  3: 'lakePond',
  1: null, // River
  2: null, // Canal
  4: null, // Ocean or Great Lake
};

/** What 3DHP says this feature is. */
export function classifyThreeDhp(featureType: number): SourceClaim {
  const mapped = THREE_DHP_FEATURETYPE[featureType];
  if (mapped === undefined) return silent(`3dhp:featuretype=${featureType}?`);
  return mapped === null
    ? drop(`3dhp:featuretype=${featureType}`)
    : claim(mapped, `3dhp:featuretype=${featureType}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Name keywords, **English and French** (N7; Québec is a planned region, founder 2026-08-04).
 *
 * Order is precedence and the first match wins, so `reservoir` is checked before everything and
 * `lakePond` before `wetland` — Bog Pond is a pond, and Sugar Hill Reservoir is a reservoir whatever
 * NHD calls it.
 *
 * **A keyword is matched anywhere in the name, not at the end.** "Lake Fairlee" and "Lac des Canards"
 * both lead with theirs, and an earlier draft of this analysis only looked at the last word — which
 * made the unresolved set look tidier than it was.
 */
const NAME_KEEP: readonly (readonly [RegExp, WaterBodyClass])[] = [
  [/\breservoirs?\b/, 'reservoir'],
  [
    // `flow`, `flowage`, `deadwater`, `logan` and `bogan` are the ones a plain "sounds like moving
    // water" reading would delete, and every one is a regional word for still water. See NAME_DROP.
    /\blacs?\b|\betangs?\b|\blakes?\b|\bponds?\b|\bfishponds?\b|\bmill ?ponds?\b|\bflowages?\b|\bflows?\b|\bdeadwaters?\b|\bimpoundments?\b|\btarns?\b|\blochs?\b|\bmeres?\b|\boxbows?\b|\blogans?\b|\bbogans?\b|\bquarry\b|\bquarries\b|\bmines?\b/,
    'lakePond',
  ],
  [/\bbaies?\b|\bbays?\b|\bcoves?\b|\banses?\b|\bharbou?rs?\b|\bestuar(?:y|ies)\b/, 'bay'],
  [
    // `vly` and `fly` are Hudson-Valley Dutch (from *vallei*) for a marshy meadow, and they name 11
    // real bodies in New York — Hillabrandt Vly, Archer Vly, The Old Fly. Nothing else would catch them.
    /\bmarais\b|\btourbieres?\b|\bmarsh(?:es)?\b|\bswamps?\b|\bbogs?\b|\bfens?\b|\bmires?\b|\bsloughs?\b|\bvlys?\b|\bvlies\b|\bflys?\b|\bwetlands?\b|\bmoors?\b/,
    'wetland',
  ],
];

/**
 * Names that say this is **not** still water, or not a place.
 *
 * **Only consulted when no keep-word matched**, which is the whole safety of the list: "Basin Pond",
 * "Little Dan Hole Pond", "Clay Pit Pond", "Windy Pitch Ponds" and "Round Pond Rips" all survive
 * because `pond` is checked first. The asymmetry is deliberate and it is the one this phase keeps
 * re-learning — keeping a rapid costs one row nobody skates, and dropping a Flow deletes a state park.
 */
const NAME_DROP =
  /\bcreeks?\b|\bbrooks?\b|\bstreams?\b|\brivers?\b|\brivieres?\b|\bruisseaux?\b|\brapids?\b|\brips\b|\bfalls\b|\bchutes?\b|\bpitch(?:es)?\b|\bcanals?\b|\bditch(?:es)?\b|\bdrains?\b|\bsluices?\b|\bspillways?\b|\bflumes?\b|\bweirs?\b|\bsewage\b|\btreatment\b|\bcisterns?\b|\bhydrants?\b|\bcampgrounds?\b|\bwastewater\b|\bbasins?\b|\bpools?\b|\bpits?\b|\bholes?\b|\bslips?\b|\bmarinas?\b|\blobster pounds?\b|\bfountains?\b/;

/**
 * Lower-case and strip diacritics, so every pattern above can be plain ASCII.
 *
 * **Not a tidiness measure — `\b` is ASCII-only in JavaScript.** There is no word boundary between
 * the start of a string and `É`, so `/\bétang\b/` matches "Étang Payeur" **never**, silently, which
 * is the exact failure shape this phase has hit four times on identifier formats. Folding to `etang`
 * makes the boundary real, and it collapses the accented and unaccented spellings of every French
 * term into one pattern instead of two alternatives that can drift apart.
 */
function fold(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** What a name says, if anything. `undefined` means the name was no help. */
export function classifyName(name: string): SourceClaim | undefined {
  const folded = fold(name);
  if (folded.length === 0) return undefined;
  for (const [pattern, cls] of NAME_KEEP) {
    if (pattern.test(folded)) return claim(cls, `name:${cls}`);
  }
  return NAME_DROP.test(folded) ? drop('name:flowing-or-built') : undefined;
}

/** Does this name assert a reservoir? The one case where a name outranks a catalogue's own class. */
export function nameAssertsReservoir(name: string): boolean {
  return /\breservoirs?\b/.test(fold(name));
}

// ─────────────────────────────────────────────────────────────────────────────
// The decision
// ─────────────────────────────────────────────────────────────────────────────

/** Where a verdict's class came from — the axis the dry-run funnel is reported along. */
export type ClassBasis =
  | 'name-reservoir' // a name said "reservoir" and outranked the catalogue
  | 'source-class' // the catalogue named a class we map
  | 'name-keyword' // the catalogue was silent; a name keyword decided it
  | 'dropped-by-class' // the catalogue named something we refuse
  | 'dropped-by-name' // the catalogue was silent and the name refused it
  | 'unresolved-named' // named, and neither the catalogue nor the name resolved it
  | 'unresolved-unnamed'; // nothing said anything at all

export interface ClassVerdict {
  /** `null` means **drop** — this is not water we cover. */
  readonly cls: WaterBodyClass | null;
  readonly basis: ClassBasis;
  /** Stable token for the ledger, e.g. `osm:water=wastewater` or `name:lakePond`. */
  readonly token: string;
}

/**
 * Classify one incoming feature from one catalogue.
 *
 * The ladder, in order, and every rung was a founder call on 2026-08-04:
 *
 * 1. **A name containing "reservoir" wins outright.** Overrides the catalogue in ~407 measured cases,
 *    deliberately: NHD classes a dammed lake by what it is, and we class it by what it is *used for*,
 *    because that is what carries access rules.
 * 2. **The catalogue's own class**, where it has one we map.
 * 3. **A name keyword**, where the catalogue is silent.
 * 4. **`unclassified`** — and this is a real answer, not a failure. It is the prompt that puts a body
 *    in front of a moderator, which is why it is named for what it is rather than called `other`.
 *
 * Cross-source reconciliation is **not** here: this answers "what does *this* catalogue say", one
 * feature at a time. Combining two catalogues' verdicts happens at merge time, where the evidence for
 * a confidence score also lives.
 */
export function classifyWaterBody(input: { name: string; claim: SourceClaim }): ClassVerdict {
  const { name, claim: sourceClaim } = input;

  if (nameAssertsReservoir(name))
    return {
      cls: 'reservoir',
      basis: 'name-reservoir',
      token: 'name:reservoir',
    };

  if (sourceClaim.outcome === 'class') {
    return {
      cls: sourceClaim.cls,
      basis: 'source-class',
      token: sourceClaim.token,
    };
  }
  if (sourceClaim.outcome === 'drop') {
    return { cls: null, basis: 'dropped-by-class', token: sourceClaim.token };
  }

  const fromName = classifyName(name);
  if (fromName?.outcome === 'class') {
    return { cls: fromName.cls, basis: 'name-keyword', token: fromName.token };
  }
  if (fromName?.outcome === 'drop') {
    return { cls: null, basis: 'dropped-by-name', token: fromName.token };
  }

  return {
    cls: 'unclassified',
    basis: name.trim().length > 0 ? 'unresolved-named' : 'unresolved-unnamed',
    token: sourceClaim.token,
  };
}
