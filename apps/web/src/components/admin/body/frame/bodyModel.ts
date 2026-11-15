import type { Doc } from '@skating/convex/dataModel';
import {
  type CompletenessField,
  sqMetersToAcres,
  standingOf,
  standingReasonLabel,
  waterBodyClassLabel,
  waterBodyDisplayName,
} from '@skating/core';

import { type AuditAction, type AuditTarget, actionLabel } from '../../shell/actionLabels';
import type { BodyTabKey } from './bodySearch';

/**
 * The Body console's left column, from the records — pure, so every rule is tested without a page:
 * the lockup's figures, the boost, the identity list, the outline's trust, what is asked of the
 * body, and its history. Completeness is never decided here: the console draws the answer the
 * server stores for the body (core's `bodyCompleteness`, read through `bodies.preview`). **`null`
 * means not recorded** and is drawn as absent, never as zero (a depth nobody measured is not a
 * depth of 0 m).
 */

/** The fields of a body the console reads. */
export type BodyRecord = Pick<
  Doc<'waterBodies'>,
  | '_id'
  | 'name'
  | 'nameClaims'
  | 'type'
  | 'source'
  | 'geometrySource'
  | 'osmId'
  | 'nhdId'
  | 'threeDhpId'
  | 'gnisId'
  | 'polygon'
  | 'surfaceAreaSqM'
  | 'shorelineM'
  | 'meanDepthM'
  | 'maxDepthM'
  | 'elevationM'
  | 'windRose'
  | 'fetchProfileM'
  | 'curatedBoost'
  | 'publicAccess'
  | 'accessKind'
  | 'reviewStatus'
  | 'dedupStatus'
  | 'removedAt'
  | 'removalReason'
  | 'dormant'
  | 'activatedAt'
  | 'createdAt'
>;

/**
 * An audit row as `bodyConsole.history` returns it — the fields the column reads. The history is the
 * body's whole family (its bays, landmarks, put-ins, lots, absorbed bodies…), so a row says whose.
 */
export interface HistoryAction {
  id: string;
  action: AuditAction;
  targetType: AuditTarget;
  targetId: string;
  createdAt: number;
  actor: { displayName: string; username: string } | null;
  /** The reason the actor gave, or the machine's own words. */
  reason?: string;
}

/** The geometry facts (towns, touching bodies) aren't computed for the body yet. */
export const NOT_COMPUTED = 'not-computed' as const;
/** How a fact not computed yet reads — never *Not recorded yet*, which says the record lacks it. */
export const NOT_COMPUTED_WORDS = 'Not computed yet';
/** How computed towns that came back empty read: the boundaries hold the body in none. */
export const IN_NO_TOWN_WORDS = 'In no town';

// ── Formats ──────────────────────────────────────────────────────────────────────────────────

const int = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** "1,143" — whole acres; under one, a tenth, so a small water never reads as none. */
export function acresFigure(sqm: number): string {
  const acres = sqMetersToAcres(sqm);
  return acres < 1 ? acres.toFixed(1) : int.format(acres);
}

/** "1,143 ac" — whole acres; under one, a tenth. */
export function acresText(sqm: number): string {
  return `${acresFigure(sqm)} ac`;
}

/** "9.4" under ten meters, "24" above. */
function meters(m: number): string {
  return m < 10 ? m.toFixed(1).replace(/\.0$/, '') : int.format(m);
}

/** "18.3 km", or meters under one. */
export function lengthText(m: number): string {
  return m < 1000 ? `${int.format(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "17 Sep" — the boards' three-letter month. Not `Intl`'s `en-GB` short month, which ICU now
 * writes "Sept" for September.
 */
export function dayMonth(at: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    timeZone,
  }).formatToParts(at);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const month = Number(parts.find((p) => p.type === 'month')?.value ?? '1');
  return `${day} ${MONTHS[month - 1] ?? ''}`;
}

/** The calendar day `at` falls on in `timeZone`, as days since the epoch. */
function dayNumber(at: number, timeZone?: string): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  })
    .format(at)
    .split('-')
    .map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / 86_400_000;
}

/**
 * A History row's time, as the boards write it: the clock today ("14:41"), the weekday this past
 * week ("Sat"), the day and month before that ("29 Sep") — rows keep day-month, never the year
 * (Review 13 #7). The shell's `historyWhen`, with the boards' three-letter month.
 */
export function historyTime(at: number, now: number, timeZone?: string): string {
  const daysAgo = dayNumber(now, timeZone) - dayNumber(at, timeZone);
  if (daysAgo === 0) {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone,
    }).format(at);
  }
  if (daysAgo > 0 && daysAgo <= 6) {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone }).format(at);
  }
  return dayMonth(at, timeZone);
}

/** A status date in the left panel carries its year: "17 Sep 2026" (Review 13 #7). */
export function statusDate(at: number, timeZone?: string): string {
  const year = new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(at);
  return `${dayMonth(at, timeZone)} ${year}`;
}

/** Staff are named by first name on the console (the founder's cast). */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

// ── The lockup ───────────────────────────────────────────────────────────────────────────────

export interface Figure {
  label: string;
  /** The boxed value; `null` is not recorded, and the figure is left out. */
  value: string | null;
}

export function bodyFigures(b: BodyRecord): Figure[] {
  const depth =
    b.meanDepthM !== undefined && b.maxDepthM !== undefined
      ? { label: 'Depth avg / max', value: `${meters(b.meanDepthM)} / ${meters(b.maxDepthM)} m` }
      : b.maxDepthM !== undefined
        ? { label: 'Depth max', value: `${meters(b.maxDepthM)} m` }
        : b.meanDepthM !== undefined
          ? { label: 'Depth avg', value: `${meters(b.meanDepthM)} m` }
          : { label: 'Depth', value: null };
  return [
    { label: 'Area', value: b.surfaceAreaSqM === undefined ? null : acresText(b.surfaceAreaSqM) },
    depth,
    {
      label: 'Elevation',
      value: b.elevationM === undefined ? null : `${int.format(b.elevationM)} m`,
    },
  ];
}

// ── Completeness ─────────────────────────────────────────────────────────────────────────────

/** The Body console tab that holds each of core's ten — where its amber square goes. */
export const COMPLETENESS_TABS: Record<
  CompletenessField,
  'shape' | 'names' | 'places' | 'access' | 'water'
> = {
  outline: 'shape',
  name: 'names',
  access: 'access',
  depth: 'water',
  elevation: 'water',
  wind: 'water',
  putIns: 'access',
  lots: 'access',
  landmarks: 'places',
  bathymetry: 'water',
};

/**
 * The tabs whose part of the record is missing something, from the stored answer's `missing`: each
 * wears the amber square.
 */
export function attentionTabs(missing: readonly CompletenessField[]): ReadonlySet<BodyTabKey> {
  return new Set(missing.map((field) => COMPLETENESS_TABS[field]));
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────

export interface Person {
  name: string;
}

export interface BodyIdentity {
  id: string;
  name: string;
  kind: string;
  figures: Figure[];
  boost: { value: number; note: string | null };
  standing: { badge: string; tone: 'lit' | 'dim'; since: string | null; note: string | null };
  /** The public-access ruling; `null` when nobody has ruled. */
  access: { badge: string; ruled: string; by: Person | null } | null;
  shoreline: string | null;
  names: { primary: string; tag: string | null; aliases: string[] };
  ids: { tag: string; value: string }[];
  outline: { tag: string; rings: string };
}

/** The catalog a source reads as, in caps (Review 11 #2). */
const SOURCE_TAG: Record<string, string> = {
  osm: 'OSM',
  nhd: 'NHD',
  '3dhp': '3DHP',
  gnis: 'GNIS',
  user: 'User',
  name: 'Name',
};

/** "The shore and 3 islands", "The shore", "2 shores" — what a polygon's rings are. */
export function ringsText(geom: GeoJSON.Polygon | GeoJSON.MultiPolygon): string {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  const shores = polys.length;
  const islands = polys.reduce((n, p) => n + Math.max(0, p.length - 1), 0);
  const shore = shores === 1 ? 'The shore' : `${shores} shores`;
  if (islands === 0) return shore;
  return `${shore} and ${islands} ${islands === 1 ? 'island' : 'islands'}`;
}

/**
 * The latest row of one verb **on the body itself**, newest first in `history` — which holds the
 * whole family's rows, so a bay's or an absorbed body's row of the same verb is never taken for the
 * body's own.
 */
export function latestOnBody(
  history: readonly HistoryAction[],
  bodyId: string,
  action: AuditAction,
): HistoryAction | null {
  return (
    history.find(
      (h) => h.action === action && h.targetType === 'waterbody' && h.targetId === bodyId,
    ) ?? null
  );
}

/**
 * The identity list, from the body and its history (newest first; the family's rows). Who ruled on
 * public access and who set the boost come from the body's own latest row of each verb; when no row
 * read says, nobody is named — never a guess.
 */
export function bodyIdentity(
  b: BodyRecord,
  {
    history,
    timeZone,
  }: {
    history: readonly HistoryAction[];
    timeZone?: string;
  },
): BodyIdentity {
  const standing = standingOf(b);
  const standingView: BodyIdentity['standing'] =
    standing.standing === 'active'
      ? {
          badge: 'Active',
          tone: 'lit',
          since:
            b.activatedAt === undefined ? null : `Since ${statusDate(b.activatedAt, timeZone)}`,
          note: null,
        }
      : standing.standing === 'unlisted'
        ? { badge: 'Unlisted', tone: 'dim', since: null, note: null }
        : {
            badge: standing.standing === 'removed' ? 'Removed' : 'Dormant',
            tone: 'dim',
            since: `Since ${statusDate(standing.since, timeZone)}`,
            note: standingReasonLabel(standing.reason),
          };

  const ruling = b.publicAccess;
  const ruledBy = latestOnBody(history, b._id, 'set_public_access')?.actor ?? null;
  const access: BodyIdentity['access'] =
    ruling === undefined
      ? null
      : {
          badge: ruling.verdict === 'none' ? 'No public access' : 'Accessible',
          ruled: `Ruled ${statusDate(ruling.decidedAt, timeZone)}`,
          by: ruledBy ? { name: firstName(ruledBy.displayName) } : null,
        };

  const boostRow = latestOnBody(history, b._id, 'set_curated_boost');
  const boostNote = boostRow
    ? `Set ${statusDate(boostRow.createdAt, timeZone)} by ${boostRow.actor ? firstName(boostRow.actor.displayName) : 'the system'}.`
    : null;

  const claims = b.nameClaims ?? [];
  const primaryTag = claims.find((c) => c.value === b.name && c.source !== 'user')?.source;
  const aliases = [...new Set(claims.filter((c) => c.value !== b.name).map((c) => c.value))];

  const ids = (
    [
      ['OSM', b.osmId],
      ['NHD', b.nhdId],
      ['3DHP', b.threeDhpId],
      ['GNIS', b.gnisId],
    ] as const
  ).flatMap(([tag, value]) => (value === undefined ? [] : [{ tag, value }]));

  return {
    id: b._id,
    name: waterBodyDisplayName(b.name),
    kind: waterBodyClassLabel(b.type),
    figures: bodyFigures(b),
    boost: { value: b.curatedBoost ?? 0, note: boostNote },
    standing: standingView,
    access,
    shoreline: b.shorelineM === undefined ? null : lengthText(b.shorelineM),
    names: {
      primary: waterBodyDisplayName(b.name),
      tag: primaryTag === undefined ? null : (SOURCE_TAG[primaryTag] ?? primaryTag.toUpperCase()),
      aliases,
    },
    ids,
    outline: {
      tag: SOURCE_TAG[b.geometrySource ?? b.source] ?? (b.geometrySource ?? b.source).toUpperCase(),
      rings: ringsText(b.polygon as GeoJSON.Polygon | GeoJSON.MultiPolygon),
    },
  };
}

// ── Asked of this body ───────────────────────────────────────────────────────────────────────

export interface BodyAsk {
  /** The lit address: `ask:<requestId>`, `placeName:<id>`, `landmarkAsk:<requestId>`. */
  id: string;
  kicker: string;
  /** The words asked for, as asked. */
  name: string;
  sub: string | null;
  /** The tab that handles it, which a press opens with the ask lit. */
  tab: BodyTabKey;
  createdAt: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function bodyAsks({
  bays,
  placeNames,
  landmarks,
}: {
  bays: readonly {
    requestId: string;
    name: string;
    askers: number;
    createdAt: number;
    notes: string[];
  }[];
  placeNames: readonly { _id: string; name: string; messages: number }[];
  landmarks: readonly { requestId: string; name: string; askers: number; createdAt: number }[];
}): BodyAsk[] {
  return [
    ...bays.map((r) => ({
      id: `ask:${r.requestId}`,
      kicker: `Bay request · ${plural(r.askers, 'skater', 'skaters')}`,
      name: r.name,
      sub: r.notes[0] ?? null,
      tab: 'shape' as const,
      createdAt: r.createdAt,
    })),
    ...placeNames.map((p) => ({
      id: `placeName:${p._id}`,
      kicker: `Place name · ${plural(p.messages, 'email', 'emails')}`,
      name: p.name,
      sub: null,
      tab: 'places' as const,
      createdAt: 0,
    })),
    ...landmarks.map((r) => ({
      id: `landmarkAsk:${r.requestId}`,
      kicker: `Landmark proposal · ${plural(r.askers, 'skater', 'skaters')}`,
      name: r.name,
      sub: null,
      tab: 'places' as const,
      createdAt: r.createdAt,
    })),
  ];
}

// ── History ──────────────────────────────────────────────────────────────────────────────────

export interface HistoryEntry {
  id: string;
  at: number;
  /** Who, by first name; `null` for a row no person wrote. */
  who: string | null;
  /** What, from the operator's side ("Set the curated boost"). */
  what: string;
}

export function bodyHistory(rows: readonly HistoryAction[]): HistoryEntry[] {
  return rows.map((r) => ({
    id: r.id,
    at: r.createdAt,
    who: r.actor ? firstName(r.actor.displayName) : null,
    what: actionLabel(r.action, r.targetType),
  }));
}

/**
 * The History section's rows, and whether more exist than were read (`capped`: the read stopped at
 * its budget, a kind of the family ran past its bound, or more rows exist than it returned — on a
 * very large lake, always).
 */
export interface BodyHistoryView {
  entries: readonly HistoryEntry[];
  capped: boolean;
}

/**
 * The History head's words: an exact count only when the read was whole ("31 changes"); a capped
 * read says how many it shows, never a total ("Latest 50"), and nothing when it shows none.
 */
export function historyHead(view: BodyHistoryView): string | null {
  const n = view.entries.length;
  if (view.capped) return n === 0 ? null : `Latest ${int.format(n)}`;
  return `${int.format(n)} ${n === 1 ? 'change' : 'changes'}`;
}

// ── The frame's extras ───────────────────────────────────────────────────────────────────────

/** When the outline was last vouched for, and how. */
export interface OutlineTrust {
  /** "Since 12 Oct 2026". */
  since: string;
  /** "A moderator approved it", "An import re-affirmed it". */
  via: string;
}

/**
 * The outline's trust, from `bodyConsole.consoleExtras`: a person's approval of a drawn body, else
 * the import campaign that last re-affirmed it. `null` when neither is recorded — drawn as absent,
 * never as "untrusted".
 */
export function outlineTrust(
  extras: {
    outlineTrustedSince: number | null;
    outlineTrustedVia: 'approved' | 'campaign' | null;
  },
  timeZone?: string,
): OutlineTrust | null {
  if (extras.outlineTrustedSince === null || extras.outlineTrustedVia === null) return null;
  return {
    since: `Since ${statusDate(extras.outlineTrustedSince, timeZone)}`,
    via:
      extras.outlineTrustedVia === 'approved'
        ? 'A moderator approved it'
        : 'An import re-affirmed it',
  };
}

// ── A body the console can't open ────────────────────────────────────────────────────────────

/** How a body left: rejected by a moderator, or merged into another. */
export interface Removal {
  /** "Rejected", "Merged". */
  verb: string;
  /** "12 Oct 2026". */
  when: string;
  /** Who, by first name; `null` for the machine or an erased account. */
  who: string | null;
  /** The reason the row gives, as written; `null` when it gives none. */
  reason: string | null;
}

/**
 * How the body left, from its own latest rejection or merge row in the history read (newest
 * first). `null` when the rows read hold neither — the caller says the history shown doesn't say,
 * never that nothing happened.
 */
export function removalOf(
  history: readonly HistoryAction[],
  bodyId: string,
  timeZone?: string,
): Removal | null {
  const row = history.find(
    (h) =>
      (h.action === 'reject_waterbody' || h.action === 'merge_waterbody') &&
      h.targetType === 'waterbody' &&
      h.targetId === bodyId,
  );
  if (row === undefined) return null;
  const reason = row.reason?.trim() ?? '';
  return {
    verb: row.action === 'reject_waterbody' ? 'Rejected' : 'Merged',
    when: statusDate(row.createdAt, timeZone),
    who: row.actor ? firstName(row.actor.displayName) : null,
    reason: reason === '' ? null : reason,
  };
}
