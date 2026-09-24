/**
 * The corpus's destination bays as `name_bay` requests (D201) — the pure transform.
 *
 * Two corpus-derived inputs, both gitignored under `training_data/google_group/`:
 *
 *  - `mentions/mentions.csv` — the LLM mention inventory: one row per canonical name with
 *    `messages` and `skatedMessages` (the same file the boost seed reads, {@link MentionRow}).
 *  - `seed/bays/classification.csv` — the A10 seed's bay classification: for each community bay
 *    name, whether it exists as an OSM/GNIS **point** (`class b`) and where, and which spelling
 *    variants resolved to the same feature (`id`).
 *
 * A bay earns a request when the corpus **skates** it in at least two messages — D202's test for a
 * sub-area candidate, against a reference point people only steer by. Spelling variants that
 * resolved to one feature are one bay: the most-mentioned spelling is the name, the rest are
 * aliases, and the counts are summed. The note is a derived insight (L5a) — counts and the feature
 * id, never a post's text.
 *
 * Parent by name and state, resolved server-side (`corpusRequests.seedBayRequests`): the transform
 * takes the classification's own parent, and when the classification captured none, the
 * "nearest known parent lake" its note names. Nothing is guessed past that; a row with no parent
 * is emitted with an empty `parentName` for the founder to fill in by hand.
 */

import type { MentionRow } from './buildFromMentions';
import { splitCsvLine } from './standingSeed';

/** One row of `classification.csv` — the columns this transform reads. */
export interface BayPointRow {
  name: string;
  state: string;
  parent: string;
  messages: number;
  /** `b` = exists as a point; `c` = a variant, a landmark, or prose. Only `b` rows can be drawn. */
  cls: string;
  /** `node/…` or `gnis/…` — spelling variants share one. Empty for a `c` row. */
  id: string;
  lat: number;
  lng: number;
  note: string;
}

export function parseBayPointsCsv(csv: string): BayPointRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines.shift() ?? '');
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`classification.csv: missing expected column "${name}"`);
    return i;
  };
  const at = {
    name: col('name'),
    state: col('state'),
    parent: col('parent'),
    messages: col('messages'),
    cls: col('class'),
    id: col('id'),
    lat: col('lat'),
    lng: col('lng'),
    note: col('note'),
  };
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    return {
      name: (cols[at.name] ?? '').trim(),
      state: (cols[at.state] ?? '').trim(),
      parent: (cols[at.parent] ?? '').trim(),
      messages: Number(cols[at.messages] ?? 0) || 0,
      cls: (cols[at.cls] ?? '').trim(),
      id: (cols[at.id] ?? '').trim(),
      lat: numberOrNaN(cols[at.lat]),
      lng: numberOrNaN(cols[at.lng]),
      note: (cols[at.note] ?? '').trim(),
    };
  });
}

/** `Number('')` is 0, and a bay at 0°, 0° is a missing coordinate, not a place. */
function numberOrNaN(value: string | undefined): number {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

/** One request, as `corpusRequests.seedBayRequests` takes it. */
export interface BayRequestSeedRow {
  name: string;
  aliases?: string[];
  state: string;
  parentName: string;
  coord: { lat: number; lng: number };
  note: string;
}

/** Skated in at least this many messages: a place people go to, not one they steer by (D202). */
export const DESTINATION_MIN_SKATED = 2;

/** Up to the `;` that separates clauses in a classification note — a `.` is "Lake St. Catherine". */
const NEAREST_PARENT = /nearest known parent lake:\s*([^;]+)/i;

export interface BayRequestsBuild {
  rows: BayRequestSeedRow[];
  stats: {
    pointBays: number;
    destinations: number;
    referencePoints: number;
    /** Destinations emitted with an empty `parentName` — to fill by hand before seeding. */
    parentless: number;
  };
}

export function buildBayRequests(
  mentions: readonly MentionRow[],
  points: readonly BayPointRow[],
  campaign: string,
): BayRequestsBuild {
  const byName = new Map(mentions.map((m) => [m.canonicalName.toLowerCase(), m]));
  const groups = new Map<string, BayPointRow[]>();
  for (const p of points) {
    if (p.cls !== 'b' || !p.id || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) continue;
    groups.set(p.id, [...(groups.get(p.id) ?? []), p]);
  }

  const rows: (BayRequestSeedRow & { messages: number })[] = [];
  let referencePoints = 0;
  let parentless = 0;
  for (const [id, variants] of groups) {
    const counted = variants.map((v) => {
      const m = byName.get(v.name.toLowerCase());
      return { point: v, messages: m?.messages ?? v.messages, skated: m?.skatedMessages ?? 0 };
    });
    counted.sort((x, y) => y.messages - x.messages);
    const primary = counted[0] as (typeof counted)[number];
    const messages = counted.reduce((s, c) => s + c.messages, 0);
    const skated = counted.reduce((s, c) => s + c.skated, 0);
    if (skated < DESTINATION_MIN_SKATED) {
      referencePoints++;
      continue;
    }
    const parentName =
      primary.point.parent || primary.point.note.match(NEAREST_PARENT)?.[1]?.trim() || '';
    if (!parentName) parentless++;
    const aliases = counted.slice(1).map((c) => c.point.name);
    rows.push({
      name: primary.point.name,
      ...(aliases.length > 0 ? { aliases } : {}),
      state: primary.point.state,
      parentName,
      coord: { lat: primary.point.lat, lng: primary.point.lng },
      note: `Corpus: ${messages} messages, ${skated} skated (${campaign}). ${id}.`,
      messages,
    });
  }
  rows.sort((x, y) => y.messages - x.messages || x.name.localeCompare(y.name));
  return {
    rows: rows.map(({ messages: _messages, ...row }) => row),
    stats: { pointBays: groups.size, destinations: rows.length, referencePoints, parentless },
  };
}
