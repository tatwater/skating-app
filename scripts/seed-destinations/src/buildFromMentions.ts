/**
 * `pnpm --filter @skating/seed-destinations build-input --mentions=<path> --towns=<path> --out=<path>`
 * (A10). Turns the LLM mention inventory (`training_data/google_group/mentions/mentions.csv`,
 * gitignored, 745 rows) into a `seed --input=` shortlist — this REPLACES the earlier regex-based
 * `destinations.corpus.json` (moved to `training_data/google_group/seed/destinations.regex.json`),
 * which mined the mbox with keyword patterns rather than an LLM mention pass.
 *
 * **Two conversions, not one.** The mention inventory names towns, not coordinates, and `match.ts`'s
 * `near` disambiguator needs a point — so this also consumes a `towns.json` town→centroid export
 * (`adminAreas:listTownCentroids`, fetched separately via `pnpm exec convex run` against dev) to
 * resolve each row's most-mentioned town to a point, trying the top three towns in order and never
 * guessing when none resolves.
 *
 * Split into a pure half (this file's exported functions — the CSV parse, the inclusion rule, the
 * tercile grading, the town lookup) and a thin CLI `main()` at the bottom, guarded so importing the
 * pure functions in a test never runs it — the same shape `standingSeed.ts`/`standing.ts` use, kept
 * in one file here because the CLI is a handful of lines around a single conversion.
 */

import type { Destination } from './match';
import { splitCsvLine } from './standingSeed';

/** One row of `mentions.csv`, decoded — the columns this script actually reads. */
export interface MentionRow {
  canonicalName: string;
  kind: string;
  messages: number;
  mentions: number;
  skatedMessages: number;
  /** Raw `"VT:405;NY:17;unknown:4"` — decoded by {@link topState} / {@link allStates}. */
  states: string;
  /** Raw `"Charlotte(19); Burlington(15); North Hero(5)"` — decoded by {@link parseTowns}. */
  towns: string;
  parentBody: string;
}

/** A town-level admin area's representative point, as `adminAreas:listTownCentroids` returns it. */
export interface TownCentroid {
  name: string;
  state: string;
  lat: number;
  lng: number;
}

const REQUIRED_COLUMNS = [
  'canonicalName',
  'kind',
  'messages',
  'mentions',
  'skatedMessages',
  'states',
  'towns',
  'parentBody',
] as const;

/** Decode `mentions.csv` into rows, reusing the quote-aware splitter the gazetteer parser uses. */
export function parseMentionsCsv(csv: string): MentionRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines.shift() ?? '');
  const at: Record<(typeof REQUIRED_COLUMNS)[number], number> = {
    canonicalName: header.indexOf('canonicalName'),
    kind: header.indexOf('kind'),
    messages: header.indexOf('messages'),
    mentions: header.indexOf('mentions'),
    skatedMessages: header.indexOf('skatedMessages'),
    states: header.indexOf('states'),
    towns: header.indexOf('towns'),
    parentBody: header.indexOf('parentBody'),
  };
  for (const column of REQUIRED_COLUMNS) {
    if (at[column] < 0) throw new Error(`mentions.csv: missing expected column "${column}"`);
  }
  return lines.map((line) => {
    const cols = splitCsvLine(line);
    return {
      canonicalName: (cols[at.canonicalName] ?? '').trim(),
      kind: (cols[at.kind] ?? '').trim(),
      messages: Number(cols[at.messages] ?? 0) || 0,
      mentions: Number(cols[at.mentions] ?? 0) || 0,
      skatedMessages: Number(cols[at.skatedMessages] ?? 0) || 0,
      states: cols[at.states] ?? '',
      towns: cols[at.towns] ?? '',
      parentBody: (cols[at.parentBody] ?? '').trim(),
    };
  });
}

interface Count {
  code: string;
  count: number;
}

/** `"VT:405;NY:17;unknown:4"` → `[{code:'VT',count:405}, …]`. */
function parseCounts(field: string): Count[] {
  return field
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const [code, countStr] = part.split(':');
      return { code: (code ?? '').trim(), count: Number(countStr ?? 0) || 0 };
    });
}

/** The state with the most mentions, `unknown` ignored — `undefined` when nothing else is real. */
export function topState(statesField: string): string | undefined {
  const real = parseCounts(statesField).filter((c) => c.code !== 'unknown' && c.code.length > 0);
  if (real.length === 0) return undefined;
  return real.reduce((best, c) => (c.count > best.count ? c : best)).code;
}

/** Every state mentioned at least once, `unknown` excluded, ordered by count descending — always
 *  includes {@link topState}'s answer first (it is that same maximum). */
export function allStates(statesField: string): string[] {
  return parseCounts(statesField)
    .filter((c) => c.code !== 'unknown' && c.code.length > 0 && c.count >= 1)
    .sort((a, b) => b.count - a.count)
    .map((c) => c.code);
}

interface TownMention {
  name: string;
  count: number;
}

/** `"Charlotte(19); Burlington(15); North Hero(5)"` → ranked town mentions, highest count first. */
export function parseTowns(field: string): TownMention[] {
  return field
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = part.match(/^(.*)\((\d+)\)$/);
      return match
        ? { name: (match[1] ?? '').trim(), count: Number(match[2]) || 0 }
        : { name: part, count: 0 };
    })
    .sort((a, b) => b.count - a.count);
}

export interface NearResolution {
  near?: { lat: number; lng: number };
  /** Which ranked town (1-based) resolved it — absent when none did. */
  viaTownRank?: 1 | 2 | 3;
}

/**
 * Resolve a row's `near` from its top three mentioned towns, in order, against the town-centroid
 * export — matched on name (case-insensitive) *and* the row's own headline state, so a same-named
 * town in another state can't supply a wrong point. Never guesses: no match among the top three
 * means no `near`, not a fourth-choice fallback.
 */
export function resolveNear(
  townsField: string,
  state: string,
  townCentroids: readonly TownCentroid[],
): NearResolution {
  const byKey = new Map(
    townCentroids.map((t) => [`${t.state}:${t.name.trim().toLowerCase()}`, t] as const),
  );
  const ranked = parseTowns(townsField).slice(0, 3);
  for (let i = 0; i < ranked.length; i++) {
    const town = ranked[i];
    if (!town?.name) continue;
    const hit = byKey.get(`${state}:${town.name.toLowerCase()}`);
    if (hit) return { near: { lat: hit.lat, lng: hit.lng }, viaTownRank: (i + 1) as 1 | 2 | 3 };
  }
  return {};
}

export interface TercileThresholds {
  t1: number;
  t2: number;
}

/** Two cut points over `messages`, taken at the 1/3 and 2/3 rank of the *included* rows — not a
 *  percentile of the value range, which the long tail here would skew hard toward the bottom. */
export function tercileThresholds(messagesValues: readonly number[]): TercileThresholds {
  const sorted = [...messagesValues].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { t1: 0, t2: 0 };
  const last = sorted[n - 1] as number;
  const t1 = sorted[Math.floor(n / 3)] ?? last;
  const t2 = sorted[Math.floor((2 * n) / 3)] ?? last;
  return { t1, t2 };
}

/** The graded boost for one row's `messages`, against {@link tercileThresholds}' cut points. */
export function boostForMessages(messages: number, thresholds: TercileThresholds): 0.1 | 0.2 | 0.3 {
  if (messages <= thresholds.t1) return 0.1;
  if (messages <= thresholds.t2) return 0.2;
  return 0.3;
}

/** Kinds the corpus tags as a bay/cove/arm by construction — the other half of the sub-area rule is
 *  `parentBody` being set at all, checked separately in {@link subAreaInfo}. */
const SUBAREA_KINDS = new Set(['bay', 'cove']);

/**
 * Two rows this corpus already parents correctly through its own `parentBody` column — kept as a
 * defensive fallback for if a future re-run of the mention pass ever drops that link, not because
 * today's data needs it. "Inland Sea" → Lake Champlain matches the corpus's `parentBody`. **"The
 * Broads" is recorded here as → Lake Sunapee, not Winnipesaukee**: the corpus's own `parentBody`
 * for that row says Lake Sunapee (there is a separate, much smaller "Winnipesaukee Broads" row with
 * no parent set at all) — the data was trusted over the plan's parenthetical.
 */
const SUBAREA_NAME_OVERRIDES: Record<string, string> = {
  'inland sea': 'Lake Champlain',
  'the broads': 'Lake Sunapee',
};

/** Sub-area candidacy for one row: parented explicitly, parented by name override, or bay/cove-shaped
 *  with no known parent — `undefined` for anything else (an ordinary standalone body).
 *
 * **A row's own name in its own `parentBody` is not a parent.** Six rows carry this — Lake
 * Champlain, Lake Winnipesaukee, Lake Massabesic, Squam Lake, Sebago Lake, Kezar Lake — all `kind:
 * lake`, all major standalone bodies the mention pass self-referenced rather than left blank. Taken
 * literally it would enter each into the sub-area pool as its own sub-area, which is not a
 * relationship that exists; treated the same as no `parentBody` at all.
 */
function subAreaInfo(row: MentionRow): { kind: 'bay'; parent?: string } | undefined {
  const name = row.canonicalName.trim().toLowerCase();
  const parentBody = row.parentBody.trim().toLowerCase() === name ? '' : row.parentBody;
  const parent = parentBody || SUBAREA_NAME_OVERRIDES[name];
  if (parent) return { kind: 'bay', parent };
  if (SUBAREA_KINDS.has(row.kind)) return { kind: 'bay' };
  return undefined;
}

/** Kinds the seed considers at all — `other` (landmarks) and anything unlisted are never candidates. */
export const SEED_KINDS = new Set(['lake', 'pond', 'reservoir', 'bay', 'cove', 'marsh', 'river']);

export interface BuildStats {
  totalRows: number;
  included: number;
  /** `kind === 'other'` (landmarks) or an unrecognized kind. */
  excludedKindOrLandmark: number;
  /** `canonicalName === 'unknown'` — the generic-reference bucket. */
  excludedUnknownName: number;
  /** Neither `skatedMessages >= 1` nor `messages >= 2`. */
  excludedBelowThreshold: number;
  /** Every state tally was `unknown` — no usable `state` to seed with at all. */
  excludedNoState: number;
  tercileThresholds: TercileThresholds;
  boostCounts: Record<'0.1' | '0.2' | '0.3', number>;
  subAreaCandidates: number;
  /** Top state resolved to `QC` (Québec) — kept, marked "outside catalog footprint". */
  qcRows: number;
  nearResolved: number;
  nearResolvedByRank: Record<1 | 2 | 3, number>;
  nearUnresolved: number;
}

export interface BuildResult {
  destinations: Destination[];
  stats: BuildStats;
}

/**
 * The whole conversion: `mentions.csv` rows + a town-centroid export → a `seed --input=` shortlist.
 *
 * Inclusion: kind ∈ {@link SEED_KINDS} and (`skatedMessages ≥ 1` or `messages ≥ 2}`), `canonicalName`
 * not `"unknown"`, and a resolvable non-`unknown` top state (a handful of rows — foreign lakes like
 * "Lake Siljan", "Potomac River" — carry no real state tally at all and are dropped here; there is
 * no rule in the plan for them because the plan didn't anticipate them).
 */
export function buildDestinationsFromMentions(
  rows: readonly MentionRow[],
  townCentroids: readonly TownCentroid[],
): BuildResult {
  let excludedUnknownName = 0;
  let excludedKindOrLandmark = 0;
  let excludedBelowThreshold = 0;
  let excludedNoState = 0;

  const eligible: { row: MentionRow; state: string; states: string[]; qc: boolean }[] = [];
  for (const row of rows) {
    if (row.canonicalName.trim().toLowerCase() === 'unknown') {
      excludedUnknownName++;
      continue;
    }
    if (!SEED_KINDS.has(row.kind)) {
      excludedKindOrLandmark++;
      continue;
    }
    if (!(row.skatedMessages >= 1 || row.messages >= 2)) {
      excludedBelowThreshold++;
      continue;
    }
    const state = topState(row.states);
    if (!state) {
      excludedNoState++;
      continue;
    }
    eligible.push({ row, state, states: allStates(row.states), qc: state === 'QC' });
  }

  const thresholds = tercileThresholds(eligible.map((e) => e.row.messages));
  const boostCounts: Record<'0.1' | '0.2' | '0.3', number> = { '0.1': 0, '0.2': 0, '0.3': 0 };
  const nearResolvedByRank: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
  let nearResolved = 0;
  let nearUnresolved = 0;
  let subAreaCandidates = 0;
  let qcRows = 0;

  const destinations: Destination[] = eligible.map(({ row, state, states, qc }) => {
    const boost = boostForMessages(row.messages, thresholds);
    boostCounts[String(boost) as '0.1' | '0.2' | '0.3']++;
    if (qc) qcRows++;

    const { near, viaTownRank } = resolveNear(row.towns, state, townCentroids);
    if (near) {
      nearResolved++;
      if (viaTownRank) nearResolvedByRank[viaTownRank]++;
    } else {
      nearUnresolved++;
    }

    const subArea = subAreaInfo(row);
    if (subArea) subAreaCandidates++;

    const notesBase = `corpus: ${row.messages} messages, ${row.mentions} mentions, ${row.skatedMessages} skated`;

    return {
      name: row.canonicalName,
      state,
      ...(states.length > 1 ? { states } : {}),
      sources: ['community' as const],
      notes: qc ? `outside catalog footprint; ${notesBase}` : notesBase,
      curatedBoost: boost,
      ...(near ? { near } : {}),
      ...(subArea ?? {}),
    };
  });

  return {
    destinations,
    stats: {
      totalRows: rows.length,
      included: eligible.length,
      excludedKindOrLandmark,
      excludedUnknownName,
      excludedBelowThreshold,
      excludedNoState,
      tercileThresholds: thresholds,
      boostCounts,
      subAreaCandidates,
      qcRows,
      nearResolved,
      nearResolvedByRank,
      nearUnresolved,
    },
  };
}
