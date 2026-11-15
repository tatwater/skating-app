import {
  ACCESS_REASON_LABELS,
  type AccessReason,
  describePostedAccess,
  describePublicAccess,
  haversineMeters,
  type PostedAccess,
  type PublicAccess,
  type PublicAccessVerdict,
} from '@skating/core';
import { isFailed, type Loadable } from '@/components/admin/reads/consoleReads';
import type { BodyMapScene, MapItem } from '../../map/mapDescriptors';

type LatLng = { lat: number; lng: number };

/**
 * The Access tab's data: the public-access ruling with what stood before it, the put-ins by who
 * vouches for them, the posted rules and any live alerts. Pure. An access ruling is about whether
 * the public may lawfully get there — never about the ice (D3). `null` means not recorded; a part
 * read on its own is in its read's state ({@link Loaded}).
 */

export type Person = { name: string; handle: string };

export type Ruling = {
  verdict: PublicAccessVerdict | null;
  /** The skater-facing line, as the app says it; `null` with no ruling. */
  statement: string | null;
  decidedAt: number | null;
  /** Who ruled, when the audit row says. */
  decidedBy: Person | null;
  /** What stood before this ruling; `undefined` when the history isn't known. */
  before: PublicAccessVerdict | null | undefined;
  /**
   * The ruling's history read (`bodyConsole.history`, `set_public_access`): how many rulings came
   * before this one, and whether the read stopped short (`capped`: more may exist, so the number is
   * a floor). `hidden` for a viewer who can't read the audit trail; loading or failed as a read.
   */
  history: Loadable<{ earlier: number; capped: boolean }> | 'hidden';
};

export type PutInRow = {
  id: string;
  name: string;
  /** No source named it: `name` is the placeholder, words to read — never a name to store. */
  unnamed?: boolean;
  source: 'official' | 'osm' | 'derived';
  at: LatLng;
  /**
   * The walk from its lot, whole meters; `null` with no lot linked. `atLeast`: a straight line from
   * the lot (`approachRouted: false` — what a moderator's link stores until the ETL routes it).
   * Trails weave, so the real walk is at least this and can be much longer; it is never drawn as a
   * measured route.
   */
  walk: { meters: number; atLeast: boolean } | null;
  /** The routed walk, to draw. */
  approach: LatLng[] | null;
  /** Where it is, by the nearest landmark's name; `null` when none is close. */
  where: Loadable<string | null>;
};

export type LotRow = { id: string; name: string | null; at: LatLng };

export type AlertRow = {
  id: string;
  label: string;
  /** The put-in or lot it is on, by name. */
  on: string | null;
  /** Pinned by a moderator, not filed by a skater. */
  official: boolean;
};

/**
 * The Access tab's data. **What its reads return and the tab doesn't keep, and why** (nothing is
 * dropped by accident):
 * - `accessPoints.accessForBody`: a lot's `amenities`, `capacity` and `fee`, and a put-in's
 *   `approachAscentM`, `approachKindOverride` and `postedAccess`: the skater's
 *   sheet says these; the console's tab is about who rules and who vouches, and the board draws
 *   none of them. `blockedIds` is drawn through the alerts that block.
 * - `landmarks.listForBody`: only the name and point, for where each launch is.
 * - `bodyConsole.history`: each row's `id`, `action` (the read asks for rulings only), `reason`,
 *   `via`, `undoesActionId` and `undo`: the ruling's statement is the record's own, and the full
 *   rows — what made each write, its undo — are History's, on the left.
 * - `waterBodies.get`: everything but `publicAccess` is the frame's or another tab's.
 */
export type AccessData = {
  ruling: Ruling;
  putIns: PutInRow[];
  lots: LotRow[];
  /** The body's posted rule, in words; `null` when none is set. */
  postedRule: string | null;
  alerts: AlertRow[];
  /** What couldn't be read, in words ("who ruled", "where each launch is"). */
  failures: string[];
};

/** "Accessible to the public": a one-clause status carries no period (Review 14 #9). */
export function rulingStatement(access: PublicAccess | undefined): string | null {
  const line = describePublicAccess(access);
  if (line === null) return null;
  return access?.verdict === 'open' ? line.replace(/\.$/, '') : line;
}

/** An audit row of `set_public_access`, as `moderation.listActions` returns it. */
export type RulingAction = {
  createdAt: number;
  actor: { displayName: string; username: string } | null;
  metadata?: unknown;
};

/** What a ruling's audit row says stood before it. */
function priorVerdict(action: RulingAction): PublicAccessVerdict | null {
  const prev = (action.metadata as { prev?: { publicAccess?: { verdict?: unknown } | null } })?.prev
    ?.publicAccess;
  const v = prev?.verdict;
  return v === 'open' || v === 'none' ? v : null;
}

/**
 * The ruling from the body's record and the newest `set_public_access` row. The row speaks for the
 * ruling only when it is the one that made it (its time is the ruling's): otherwise who ruled and
 * what stood before are not known, and drawn as absent.
 */
export function rulingOf(
  access: PublicAccess | undefined,
  latest: RulingAction | null | undefined,
): Omit<Ruling, 'history'> {
  const matches =
    latest != null &&
    (access === undefined ? true : Math.abs(latest.createdAt - access.decidedAt) < 60_000);
  return {
    verdict: access?.verdict ?? null,
    statement: rulingStatement(access),
    decidedAt: access?.decidedAt ?? null,
    decidedBy:
      matches && access !== undefined && latest.actor !== null
        ? {
            name: latest.actor.displayName.trim() || latest.actor.username,
            handle: latest.actor.username,
          }
        : null,
    before: matches ? priorVerdict(latest) : undefined,
  };
}

/** A row of `bodyConsole.history`, trimmed to what the ruling reads. */
export type HistoryRow = {
  targetType: string;
  targetId: string;
  createdAt: number;
  actor: { displayName: string; username: string } | null;
  metadata?: unknown;
};

/** How many rulings a history read asks for: the newest, and enough before it to count. */
export const RULING_HISTORY_LIMIT = 20;

/**
 * The ruling from the body's record and its history read (`bodyConsole.history`, filtered to
 * `set_public_access`). History covers the body's whole family; only the body's own rows are its
 * rulings — the newest says who ruled and what stood before, the rest count as earlier. A read that
 * stopped short (`capped`) makes that count a floor.
 */
export function rulingFrom(
  access: PublicAccess | undefined,
  bodyId: string,
  history: Loadable<{ entries: readonly HistoryRow[]; capped: boolean }> | 'hidden',
): Ruling {
  if (history === 'hidden' || history === undefined || isFailed(history)) {
    return { ...rulingOf(access, undefined), history };
  }
  const own = history.entries.filter((e) => e.targetType === 'waterbody' && e.targetId === bodyId);
  const ruling = rulingOf(access, own[0] ?? null);
  // The newest row counts as this ruling's only when it made it; otherwise every row came earlier.
  const made = ruling.before !== undefined ? 1 : 0;
  return { ...ruling, history: { earlier: own.length - made, capped: history.capped } };
}

/** The earlier rulings, in words: "1 earlier ruling", "19+ earlier rulings"; nothing when none. */
export function earlierWords(history: Ruling['history']): string | null {
  if (typeof history !== 'object' || isFailed(history)) return null;
  const { earlier, capped } = history;
  if (capped) {
    return earlier === 0
      ? 'Earlier rulings may exist past what this read shows'
      : `${earlier.toLocaleString('en-US')}+ earlier rulings`;
  }
  if (earlier === 0) return null;
  return `${earlier.toLocaleString('en-US')} earlier ${earlier === 1 ? 'ruling' : 'rulings'}`;
}

/** A state's words on the strip. */
export function verdictWords(v: PublicAccessVerdict | null): string {
  if (v === 'open') return 'Ruled accessible';
  if (v === 'none') return 'Ruled no public access';
  return 'No ruling';
}

/** Whole calendar days from `from` to `now`, in the viewer's zone. */
export function daysSince(from: number, now: number): number {
  const day = (t: number) => {
    const d = new Date(t);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.max(0, Math.round((day(now) - day(from)) / 86_400_000));
}

/** "1 day", "23 days": units written out (Review 9 #10). */
export const dayCount = (n: number) => `${n.toLocaleString('en-US')} ${n === 1 ? 'day' : 'days'}`;

/** How near a landmark must be to name where a put-in is. */
export const WHERE_RADIUS_M = 1_000;

/** The nearest landmark within reach of a point, by name; loading and failed pass through. */
export function whereOf(
  at: LatLng,
  landmarks: Loadable<ReadonlyArray<{ name: string; point: LatLng }>>,
): Loadable<string | null> {
  if (landmarks === undefined || isFailed(landmarks)) return landmarks;
  let best: { name: string; d: number } | null = null;
  for (const l of landmarks) {
    const d = haversineMeters(at, l.point);
    if (d <= WHERE_RADIUS_M && (best === null || d < best.d)) best = { name: l.name, d };
  }
  return best?.name ?? null;
}

/** `accessPoints.accessForBody`'s answer, trimmed to what the tab reads. */
export type AccessInput = {
  putIns: ReadonlyArray<{
    id: string;
    coord: LatLng;
    name?: string | undefined;
    source: string;
    parkingAreaId?: string | undefined;
    approachMeters?: number | undefined;
    /** `false`: `approachMeters` is a straight line, a floor. */
    approachRouted?: boolean | undefined;
    approachPath?: LatLng[] | undefined;
  }>;
  parking: ReadonlyArray<{ id: string; coord: LatLng; name?: string | undefined }>;
  alerts: ReadonlyArray<{
    id: string;
    reason: string;
    putInId?: string | undefined;
    parkingAreaId?: string | undefined;
    official: boolean;
  }>;
};

const SOURCE_ORDER = { official: 0, osm: 1, derived: 2 } as const;

export function accessFrom(
  input: AccessInput,
  ruling: Ruling,
  postedAccess: PostedAccess | undefined,
  landmarks: Loadable<ReadonlyArray<{ name: string; point: LatLng }>>,
): AccessData {
  const putIns: PutInRow[] = input.putIns
    .map((p): PutInRow => {
      const source: PutInRow['source'] =
        p.source === 'official' || p.source === 'osm' ? p.source : 'derived';
      return {
        id: p.id,
        // The server resolves a compass name for any launch on a body with an interior point.
        name: p.name ?? 'Unnamed put-in',
        ...(p.name === undefined ? { unnamed: true } : {}),
        source,
        at: p.coord,
        walk:
          p.parkingAreaId !== undefined && p.approachMeters !== undefined
            ? // Only `false` is a straight line: a row from before the flag held a routed walk, as
              // core's `describeApproach` reads it.
              { meters: Math.round(p.approachMeters), atLeast: p.approachRouted === false }
            : null,
        approach: p.approachPath && p.approachPath.length > 1 ? p.approachPath : null,
        where: source === 'official' ? null : whereOf(p.coord, landmarks),
      };
    })
    .sort(
      (a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || a.name.localeCompare(b.name),
    );
  const names = new Map<string, string>([
    ...putIns.map((p) => [p.id, p.name] as const),
    ...input.parking.flatMap((l) => (l.name ? [[l.id, l.name] as const] : [])),
  ]);
  return {
    ruling,
    putIns,
    lots: input.parking.map((l) => ({ id: l.id, name: l.name ?? null, at: l.coord })),
    postedRule: postedAccess ? describePostedAccess(postedAccess) : null,
    alerts: input.alerts.map((a) => ({
      id: a.id,
      label: ACCESS_REASON_LABELS[a.reason as AccessReason] ?? a.reason,
      on: names.get(a.putInId ?? a.parkingAreaId ?? '') ?? null,
      official: a.official,
    })),
    failures: [
      ...(isFailed(ruling.history) ? ['who ruled'] : []),
      ...(isFailed(landmarks) ? ['where each launch is'] : []),
    ],
  };
}

/**
 * The lit-item ids Access answers to, in `?lit=`'s grammar and the frame's words: a put-in and a
 * lot as the frame's map addresses them, and the ruling.
 */
export const litId = {
  putIn: (id: string) => `putIn:${id}`,
  lot: (id: string) => `lot:${id}`,
  ruling: 'publicAccess:ruling',
};

/**
 * What Access asks the map to draw beyond the frame's own (which draws the put-ins and lots as
 * `putIn:<id>` and `lot:<id>`): each routed walk from a lot to its put-in. The lit item is kept when
 * it is on the map — a put-in or lot the frame draws.
 */
export function accessMapScene(data: AccessData, lit: string | null): BodyMapScene {
  const items: MapItem[] = data.putIns.flatMap((p): MapItem[] =>
    p.approach
      ? [
          {
            kind: 'line',
            id: `approach:${p.id}`,
            layer: 'putIns',
            style: 'approach',
            path: p.approach.map((c) => [c.lng, c.lat] as const),
          },
        ]
      : [],
  );
  const onMap =
    lit !== null &&
    (data.putIns.some((p) => litId.putIn(p.id) === lit) ||
      data.lots.some((l) => litId.lot(l.id) === lit));
  return { items, lit: onMap ? lit : null };
}
