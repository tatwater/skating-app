import type { api } from '@skating/convex/api';
import {
  ACCESS_REASON_LABELS,
  type AccessReason,
  type AccessTarget,
  chooseAccessTarget,
  type DirectionsPlatform,
  describeApproach,
  directionsUrl,
  isHikeIn,
  type PostedAccess,
} from '@skating/core';
import type { FunctionReturnType } from 'convex/server';

import { reportWhen } from '../lakeModel';

/**
 * The Getting there tab's rules (board 1.8), pure. The choosing — which way in to route a car to,
 * how far the walk is, what the sign says — is core's (`chooseAccessTarget`, `describeApproach`,
 * the posted-access functions), shared with mobile; this file only lays one card per put-in.
 *
 * **Alerts annotate and never suppress** (A06d open question 3): a launch with a locked gate stays
 * on screen, nameable and routable, carrying its warning.
 */

/** What `accessPoints.accessForBody` hands back — the function's own type, never restated. */
export type AccessData = FunctionReturnType<typeof api.accessPoints.accessForBody>;
type AccessPutInRow = AccessData['putIns'][number];
type AccessLot = AccessData['parking'][number];
type AccessAlertRow = AccessData['alerts'][number];

/** How many put-in cards draw at first (the board's six); more come as the list scrolls. */
export const PUT_INS_PAGE = 6;

/** Amenity words, as the old access section said them. */
export const AMENITY_LABELS: Readonly<Record<string, string>> = {
  toilets: 'Toilets',
  trail: 'Trail',
  boat_ramp: 'Boat ramp',
};

export interface AccessAlertModel {
  id: string;
  /** "Snowed in", "Gate locked" — core's reason words. */
  reason: string;
  /** "reported Thu · 3:15 PM" (when it was filed). */
  when: string;
  note: string | null;
  /** A moderator pinned it: no votes, it stands until they release it. */
  official: boolean;
}

export interface PostedTarget {
  rule: PostedAccess | undefined;
  coord: { lat: number; lng: number };
}

export interface PutInCardModel {
  id: string;
  name: string;
  /** "Put-in with a lot · Boat launch lot", "Shore put-in". */
  sub: string;
  /** Core's pick for directions: the card drawn first, with the accent edge. */
  recommended: boolean;
  /** "Park at the boat launch lot, then put in at the ramp." — only when there is a lot. */
  lede: string | null;
  /** The walk, apart from the drive: a hike-in carries the chip and the sentence. */
  hikeIn: boolean;
  approach: string | null;
  /** The signs: the launch's, then its lot's — never merged into one rule. */
  posted: PostedTarget[];
  /** What's at the lot: amenities, capacity, fee. `null` with no lot on file. */
  here: string | null;
  alerts: AccessAlertModel[];
  /** True when the put-in carries an id a photo or an alert can hang on (a stored row). */
  stored: boolean;
  directions: {
    href: string;
    target: 'parking' | 'put_in';
    label: string;
    tip: string;
  };
}

/** Core's reason words, falling back to the generic "Access problem". */
export function reasonLabel(reason: string): string {
  return ACCESS_REASON_LABELS[reason as AccessReason] ?? 'Access problem';
}

/** What's at a lot, in one line: "Toilets · Boat ramp · About 12 cars · Fee". */
export function lotLine(lot: AccessLot): string {
  const parts = (lot.amenities ?? []).map((a) => AMENITY_LABELS[a] ?? a);
  if (typeof lot.capacity === 'number' && lot.capacity > 0)
    parts.push(`About ${lot.capacity} cars`);
  if (lot.fee === true) parts.push('Fee');
  return parts.length > 0 ? parts.join(' · ') : 'Parking lot';
}

function alertModel(alert: AccessAlertRow, now: number): AccessAlertModel {
  return {
    id: alert.id,
    reason: reasonLabel(alert.reason),
    when: `reported ${reportWhen(alert.createdAt, now)}`,
    note: alert.note ?? null,
    official: alert.official,
  };
}

/**
 * The directions affordance for one way in: the lot when the launch has one (D72 — never route a
 * car to a launch it can't reach), else the put-in itself.
 */
export function directionsFor(
  target: AccessTarget,
  platform: DirectionsPlatform,
): PutInCardModel['directions'] {
  const toParking = target.via === 'parking';
  const app = platform === 'ios' ? 'Apple Maps' : 'Google Maps';
  const approximate = !toParking && target.putIn.source !== 'official';
  return {
    href: directionsUrl(target.coord, platform),
    target: toParking ? 'parking' : 'put_in',
    label: toParking ? 'Directions to parking' : 'Directions to the put-in',
    tip: toParking
      ? `Opens ${app} with this put-in’s parking as the destination`
      : `Opens ${app} with this put-in as the destination${
          approximate ? ' — the spot is approximate' : ''
        }`,
  };
}

/**
 * One card per stored put-in, core's recommended way in first, the rest in the server's order.
 * Each card's own trip is resolved through `chooseAccessTarget` on that put-in alone, so a card and
 * the header's Directions can never disagree about what a launch's lot is or how far the walk is.
 */
export function putInCards(
  access: AccessData,
  platform: DirectionsPlatform,
  now: number,
): PutInCardModel[] {
  const blocked = new Set<string>(access.blockedIds);
  const best = chooseAccessTarget(access.putIns, access.parking, blocked);
  const ordered = best
    ? [best.putIn as AccessPutInRow, ...access.putIns.filter((p) => p.id !== best.putIn.id)]
    : access.putIns;
  return ordered.map((p) => {
    // Never null: one put-in in, one target out.
    const target = chooseAccessTarget([p], access.parking, blocked) as AccessTarget;
    const lot = target.parking as AccessLot | undefined;
    // `?? []` as the shipped access section had it: a caller may hand over a partial answer.
    const alerts = (access.alerts ?? []).filter(
      (a) =>
        a.putInId === p.id ||
        (p.parkingAreaId !== undefined && a.parkingAreaId === p.parkingAreaId),
    );
    const name = p.name ?? 'Put-in';
    return {
      id: p.id,
      name,
      sub: lot ? `Put-in with a lot${lot.name ? ` · ${lot.name}` : ''}` : 'Shore put-in',
      recommended: best?.putIn.id === p.id,
      lede: lot
        ? `Park at ${lot.name ?? 'the lot'}, then put in at ${p.name ?? 'the shore'}.`
        : null,
      hikeIn: isHikeIn(target.approachKind),
      approach: describeApproach(target),
      posted: [
        { rule: p.postedAccess, coord: p.coord },
        ...(lot?.postedAccess ? [{ rule: lot.postedAccess, coord: lot.coord }] : []),
      ],
      here: lot ? lotLine(lot) : null,
      alerts: alerts.map((a) => alertModel(a, now)),
      stored: true,
      directions: directionsFor(target, platform),
    };
  });
}

/** The lots no put-in card names — parking that serves the lake on its own. */
export function otherParking(access: AccessData): AccessLot[] {
  const named = new Set(access.putIns.map((p) => p.parkingAreaId).filter(Boolean));
  return access.parking.filter((lot) => !named.has(lot.id));
}

/** A lot on its own: its directions (always to the lot) and its line. */
export function lotDirections(
  lot: AccessLot,
  platform: DirectionsPlatform,
): PutInCardModel['directions'] {
  const app = platform === 'ios' ? 'Apple Maps' : 'Google Maps';
  return {
    href: directionsUrl(lot.coord, platform),
    target: 'parking',
    label: 'Directions to parking',
    tip: `Opens ${app} with this lot as the destination`,
  };
}

/** Apple Maps on iOS, Google Maps elsewhere — the directions link's platform. */
export function detectPlatform(): DirectionsPlatform {
  if (typeof navigator === 'undefined') return 'web';
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'ios' : 'web';
}

type PutInMarkerRow = FunctionReturnType<typeof api.putIns.listForBody>[number];

/** A spot skaters put in, known only from their reports — no row, so no photos or alerts. */
export interface DerivedPutInModel {
  key: string;
  sub: string;
  directions: PutInCardModel['directions'];
}

/**
 * The fallback when the lake has no stored launch: the spots reports put in at (`putIns.listForBody`'s
 * derived clusters), with directions to the spot. Their age is said, never hidden (D62) — an access
 * point from three winters ago must not read like last week's.
 */
export function derivedPutIns(
  markers: readonly PutInMarkerRow[],
  platform: DirectionsPlatform,
  now: number,
): DerivedPutInModel[] {
  const app = platform === 'ios' ? 'Apple Maps' : 'Google Maps';
  return markers
    .filter((m) => m.source === 'derived')
    .map((m) => {
      const parts = ['From skaters’ reports'];
      if (typeof m.reportCount === 'number')
        parts.push(`${m.reportCount} ${m.reportCount === 1 ? 'report' : 'reports'}`);
      if (typeof m.lastUsedAt === 'number')
        parts.push(`last used ${reportWhen(m.lastUsedAt, now)}`);
      return {
        key: `${m.coord.lat},${m.coord.lng}`,
        sub: parts.join(' · '),
        directions: {
          href: directionsUrl(m.coord, platform),
          target: 'put_in' as const,
          label: 'Directions to the put-in',
          tip: `Opens ${app} with this spot as the destination — the spot is approximate`,
        },
      };
    });
}
