/**
 * The community corpus as a **name source** for landmarks (D202) — the spellings skaters actually
 * write, and how often they write them. The corpus has no coordinates, so it cannot place anything:
 * a corpus name attaches to a landmark the catalogs already placed, or it goes on the unmatched list a
 * moderator works through (and, once the proposal lane exists, skaters fill).
 *
 * Input is the LLM mention inventory's aggregate, `mentions.csv` (gitignored under `training_data/`).
 * What crosses into the database is a **count and a spelling**, never text from a message (L5a).
 */

import { landmarkNameKey } from '@skating/core';
import type { MatchBody, PlacedLandmark } from './landmarkMatch';

/** One place the inventory names, reduced to what the landmark pass reads. */
export interface CorpusPlace {
  name: string;
  kind: string;
  messages: number;
  skatedMessages: number;
  states: string[];
  parentBody?: string;
  aliases: string[];
}

/**
 * RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. Enough for the
 * inventory's own output; not a general parser.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * The inventory kinds that can be a landmark: `other` (islands, points, beaches, stores…) and the bays
 * and coves the corpus names. A lake, pond or river is a body (or D4's deferred reach), never a label.
 */
const LANDMARK_CORPUS_KINDS = new Set(['other', 'bay', 'cove']);

/** The landmark kinds a corpus `bay` or `cove` can never be. */
const NOT_A_CORPUS_BAY: ReadonlySet<string> = new Set(['settlement', 'establishment']);

/** Read `mentions.csv` into the places that may be landmarks. The inventory's catch-all `unknown` is skipped. */
export function parseMentions(csv: string): CorpusPlace[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const col = (name: string) => header.indexOf(name);
  const c = {
    name: col('canonicalName'),
    kind: col('kind'),
    messages: col('messages'),
    skated: col('skatedMessages'),
    states: col('states'),
    parent: col('parentBody'),
    aliases: col('aliases'),
  };
  if (Object.values(c).some((i) => i < 0)) {
    throw new Error(
      `mentions.csv is missing a column the landmark pass reads: ${header.join(',')}`,
    );
  }
  const places: CorpusPlace[] = [];
  for (const row of rows) {
    const name = (row[c.name] ?? '').trim();
    const kind = (row[c.kind] ?? '').trim();
    if (!name || name.toLowerCase() === 'unknown' || !LANDMARK_CORPUS_KINDS.has(kind)) continue;
    const parent = (row[c.parent] ?? '').trim();
    places.push({
      name,
      kind,
      messages: Number(row[c.messages]) || 0,
      skatedMessages: Number(row[c.skated]) || 0,
      // "VT:8;unknown:26" → ['VT']
      states: (row[c.states] ?? '')
        .split(';')
        .map((s) => s.split(':')[0]?.trim() ?? '')
        .filter((s) => /^[A-Z]{2}$/.test(s)),
      ...(parent ? { parentBody: parent } : {}),
      aliases: (row[c.aliases] ?? '')
        .split(';')
        .map((a) => a.trim())
        .filter(Boolean),
    });
  }
  return places;
}

/** Words every landmark name shares — they say what a place is, not which one. */
const GENERIC = new Set([
  'bay',
  'cove',
  'island',
  'isle',
  'islands',
  'point',
  'beach',
  'lake',
  'pond',
  'the',
  'of',
  'and',
  'north',
  'south',
  'east',
  'west',
  'inner',
  'outer',
  'upper',
  'lower',
  'big',
  'little',
  'area',
  'harbor',
  'narrows',
  'river',
  'brook',
  'creek',
  'marina',
  'park',
  'state',
  'town',
  'rock',
]);

function distinctive(name: string): string[] {
  return landmarkNameKey(name)
    .split(' ')
    .filter((t) => t.length >= 3 && !GENERIC.has(t));
}

/** Edit distance, for the corpus's misspellings of a single word ("Missiquoi" for "Missisquoi"). */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const held = row[j] as number;
      row[j] = Math.min(
        held + 1,
        (row[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = held;
    }
  }
  return row[b.length] as number;
}

/**
 * Does a corpus alias spell *this* place, rather than a place the inventory clustered with it? The
 * inventory's alias lists are an LLM's grouping and are noisy — Carry Bay's list carries "Carleton's
 * Prize" (the peninsula beside it), Malletts Bay's carries "inner bay", Wolfeboro Bay's "the bay".
 * An alias is kept when one of its distinctive words is a prefix of one of the name's ("Shelb" for
 * "Shelburne"), or one misspelling away ("Missiquoi"). Generic words never count, and a qualified
 * form ("…, Lake Champlain", "…(Carry Bay)") is a description rather than a name.
 */
export function aliasResembles(alias: string, name: string): boolean {
  // "Shelburne Bay, Lake Champlain" and "Lake Champlain (Stevenson Bay)" are a place *described*,
  // not a spelling of its name.
  if (/[(),]/.test(alias)) return false;
  const theirs = distinctive(name);
  const compact = (s: string) => landmarkNameKey(s).replace(/ /g, '');
  if (compact(alias) === compact(name)) return true;
  return distinctive(alias).some((a) =>
    theirs.some(
      (n) =>
        (a.length >= 4 && n.startsWith(a)) ||
        (n.length >= 4 && a.startsWith(n)) ||
        (Math.min(a.length, n.length) >= 5 && editDistance(a, n) <= 2),
    ),
  );
}

export interface CorpusOutcome {
  matched: number;
  /** Names that meet landmarks on more than one body and nothing narrowed them to one. */
  ambiguous: { place: CorpusPlace; bodies: string[] }[];
  /** Names no placed landmark answers to — the moderator's (and the proposal lane's) list. */
  unmatched: CorpusPlace[];
}

/**
 * Attach each corpus place to the landmark it names: the community's spellings become aliases and
 * its message count becomes `corpusMessages`. **Only an unambiguous match attaches** — "Long Point"
 * with no parent body and no state names half the lakes in the five states, and a count on the wrong
 * one would rank a stranger's point above the one skaters meant.
 *
 * Narrowing, in order and never relaxed: the parent body the inventory recorded (by name, when the
 * catalog holds a body of that name), the states it saw, and kind (a corpus bay is not a village).
 * What survives must be **one landmark** — or one river's several mouths, which are one reference.
 */
/** The name key with its spaces gone — "Isle LaMotte" and "Isle La Motte" are one spelling. */
function compactKey(name: string): string {
  return landmarkNameKey(name).replace(/ /g, '');
}

export function applyCorpus(
  byBody: Map<string, PlacedLandmark[]>,
  bodies: ReadonlyMap<string, MatchBody>,
  places: readonly CorpusPlace[],
): CorpusOutcome {
  // name key → the landmarks answering to it, across every body
  const index = new Map<string, PlacedLandmark[]>();
  for (const list of byBody.values()) {
    for (const l of list) {
      for (const n of [l.name, ...l.aliases]) {
        const key = compactKey(n);
        const hits = index.get(key);
        if (hits) {
          if (!hits.includes(l)) hits.push(l);
        } else index.set(key, [l]);
      }
    }
  }

  const parentKeys = new Set<string>();
  for (const body of bodies.values()) if (body.name) parentKeys.add(landmarkNameKey(body.name));

  const outcome: CorpusOutcome = { matched: 0, ambiguous: [], unmatched: [] };
  for (const place of places) {
    const keys = [place.name, ...place.aliases.filter((a) => aliasResembles(a, place.name))].map(
      compactKey,
    );
    let hits = [...new Set(keys.flatMap((k) => index.get(k) ?? []))];
    // A named parent the catalog knows is binding: Champlain's "Northwest Bay" must never lend its
    // count to Lake George's. Only a parent we hold no body for (a river, a Québec lake) falls through.
    if (place.parentBody) {
      const parent = landmarkNameKey(place.parentBody);
      if (parentKeys.has(parent)) {
        hits = hits.filter((l) => {
          const name = bodies.get(l.waterBodyId)?.name;
          return name !== undefined && landmarkNameKey(name) === parent;
        });
      }
    }
    if (place.states.length > 0) {
      hits = hits.filter((l) =>
        (bodies.get(l.waterBodyId)?.states ?? []).some((s) => place.states.includes(s)),
      );
    }
    // A bay or cove the corpus names is a place on the water (the inventory files "Leavitt Beach"
    // under `bay`), never the village or the business that shares its name.
    if (place.kind !== 'other') hits = hits.filter((l) => !NOT_A_CORPUS_BAY.has(l.kind));
    const onBodies = [...new Set(hits.map((l) => l.waterBodyId))];
    if (onBodies.length === 0) {
      outcome.unmatched.push(place);
      continue;
    }
    // One body, several landmarks: two Cedar Islands on Champlain are two places, and a count on
    // both would rank the one nobody meant. Only a river's several mouths are one reference.
    const oneReference =
      hits.length === 1 || hits.every((l) => l.kind === 'waterway' && l.name === hits[0]?.name);
    if (onBodies.length > 1 || !oneReference) {
      outcome.ambiguous.push({ place, bodies: onBodies });
      continue;
    }
    outcome.matched++;
    for (const l of hits) {
      l.corpusMessages = Math.max(l.corpusMessages ?? 0, place.messages);
      for (const alias of [place.name, ...place.aliases]) {
        if (!aliasResembles(alias, l.name)) continue;
        if (landmarkNameKey(alias) === landmarkNameKey(l.name)) continue;
        if (l.aliases.some((a) => landmarkNameKey(a) === landmarkNameKey(alias))) continue;
        l.aliases.push(alias);
      }
    }
  }
  return outcome;
}

/** One corpus name no landmark took, as `load-landmark-names` writes it (D202's moderator queue). */
export interface CorpusNameRecord {
  name: string;
  /** The spellings that resemble the name — the inventory's clusters, filtered as attachment is. */
  aliases: string[];
  messages: number;
  skatedMessages: number;
  states: string[];
  /** The lake the inventory said it was on, by name, when it said. */
  parentName?: string;
  /** That lake, when exactly one listed body answers to the name (in the states the corpus saw). */
  waterBodyId?: string;
  /** For a name that met landmarks on several lakes: those lakes, for the moderator to choose from. */
  candidateBodyIds?: string[];
}

/**
 * The corpus's leftovers as the moderator's queue: every unmatched name, and every ambiguous one
 * with the lakes it met. A named parent resolves to a body only when one listed body of that name
 * sits in the states the corpus saw — two "Long Pond"s are a choice for a person, not a guess.
 */
export function corpusNameRecords(
  outcome: CorpusOutcome,
  bodies: ReadonlyMap<string, MatchBody>,
): CorpusNameRecord[] {
  const byName = new Map<string, MatchBody[]>();
  for (const body of bodies.values()) {
    if (!body.name) continue;
    const key = landmarkNameKey(body.name);
    const list = byName.get(key);
    if (list) list.push(body);
    else byName.set(key, [body]);
  }
  const record = (place: CorpusPlace): CorpusNameRecord => ({
    name: place.name,
    aliases: place.aliases.filter(
      (a) => aliasResembles(a, place.name) && landmarkNameKey(a) !== landmarkNameKey(place.name),
    ),
    messages: place.messages,
    skatedMessages: place.skatedMessages,
    states: place.states,
    ...(place.parentBody ? { parentName: place.parentBody } : {}),
  });
  const out: CorpusNameRecord[] = [];
  for (const place of outcome.unmatched) {
    const rec = record(place);
    if (place.parentBody) {
      let hits = byName.get(landmarkNameKey(place.parentBody)) ?? [];
      if (place.states.length > 0) {
        hits = hits.filter((b) => (b.states ?? []).some((s) => place.states.includes(s)));
      }
      if (hits.length === 1) rec.waterBodyId = (hits[0] as MatchBody).id;
      else if (hits.length > 1) rec.candidateBodyIds = hits.map((b) => b.id);
    }
    out.push(rec);
  }
  for (const { place, bodies: ids } of outcome.ambiguous) {
    const rec = record(place);
    if (ids.length === 1) rec.waterBodyId = ids[0] as string;
    else rec.candidateBodyIds = [...ids];
    out.push(rec);
  }
  return out;
}
