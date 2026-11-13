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

import type { AccessMapDrawing, AccessMapLine, AccessMapPoint, LatLng } from './accessMap';

/**
 * The Access tab's data: the public-access ruling with what stood before it, the put-ins by who
 * vouches for them, the posted rules and any live alerts. Pure. An access ruling is about whether
 * the public may lawfully get there — never about the ice (D3). `null` means not recorded.
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
};

export type PutInRow = {
  id: string;
  name: string;
  source: 'official' | 'osm' | 'derived';
  at: LatLng;
  /** The walk from its lot, in meters; `null` with no lot linked. */
  walkM: number | null;
  /** The routed walk, to draw. */
  approach: LatLng[] | null;
  /** Where it is, by the nearest landmark; `null` when none is close. */
  where: string | null;
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

export type AccessData = {
  ruling: Ruling;
  putIns: PutInRow[];
  lots: LotRow[];
  /** The body's posted rule, in words; `null` when none is set. */
  postedRule: string | null;
  alerts: AlertRow[];
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
): Ruling {
  const matches =
    latest != null &&
    (access === undefined ? true : Math.abs(latest.createdAt - access.decidedAt) < 60_000);
  return {
    verdict: access?.verdict ?? null,
    statement: rulingStatement(access),
    decidedAt: access?.decidedAt ?? null,
    decidedBy:
      matches && access !== undefined && latest.actor !== null
        ? { name: latest.actor.displayName, handle: latest.actor.username }
        : null,
    before: matches ? priorVerdict(latest) : undefined,
  };
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

/** The nearest landmark within reach of a point, by name. */
export function whereOf(
  at: LatLng,
  landmarks: ReadonlyArray<{ name: string; point: LatLng }> | null,
): string | null {
  let best: { name: string; d: number } | null = null;
  for (const l of landmarks ?? []) {
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
  landmarks: ReadonlyArray<{ name: string; point: LatLng }> | null,
): AccessData {
  const putIns: PutInRow[] = input.putIns
    .map((p) => {
      const source: PutInRow['source'] =
        p.source === 'official' || p.source === 'osm' ? p.source : 'derived';
      return {
        id: p.id,
        // The server resolves a compass name for any launch on a body with an interior point.
        name: p.name ?? 'Unnamed put-in',
        source,
        at: p.coord,
        walkM:
          p.parkingAreaId !== undefined && p.approachMeters !== undefined
            ? Math.round(p.approachMeters)
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
  };
}

/** The lit-item ids Access answers to. */
export const litId = {
  putIn: (id: string) => `put-in:${id}`,
  lot: (id: string) => `lot:${id}`,
  ruling: 'ruling',
};

/** What Access asks the map to draw. */
export function accessMapDrawing(data: AccessData, lit: string | null): AccessMapDrawing {
  const points: AccessMapPoint[] = [
    ...data.putIns.map(
      (p): AccessMapPoint => ({
        id: litId.putIn(p.id),
        mark: 'put-in',
        source: p.source,
        at: p.at,
        label: p.name,
        lit: lit === litId.putIn(p.id),
      }),
    ),
    ...data.lots.map(
      (l): AccessMapPoint => ({
        id: litId.lot(l.id),
        mark: 'lot',
        at: l.at,
        label: l.name,
        lit: lit === litId.lot(l.id),
      }),
    ),
  ];
  const lines: AccessMapLine[] = data.putIns.flatMap((p) =>
    p.approach
      ? [
          {
            id: `approach:${p.id}`,
            style: 'approach' as const,
            path: p.approach,
            lit: lit === litId.putIn(p.id),
          },
        ]
      : [],
  );
  return { points, lines, lit: points.some((p) => p.lit) ? lit : null };
}
