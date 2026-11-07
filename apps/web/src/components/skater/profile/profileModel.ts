import {
  SKATE_QUALITY_LABELS,
  type SkateQuality,
  TRUST_CLASS_LABELS,
  type TrustClass,
} from '@skating/core';

/**
 * The profile page's words, worked out once (row 6). Pure, so every date and plural is tested
 * without a screen.
 */

const DAY_MS = 86_400_000;

function dayKey(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

/**
 * A post's day, as its kicker reads: "Today", "Yesterday", the weekday within the week, then
 * "January 9".
 */
export function dayKicker(ms: number, now: number, timeZone?: string): string {
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return 'Today';
  if (dayKey(ms, timeZone) === dayKey(now - DAY_MS, timeZone)) return 'Yesterday';
  const zone = timeZone ? { timeZone } : {};
  if (now - ms < 6 * DAY_MS && ms <= now) {
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', ...zone });
  }
  return new Date(ms).toLocaleDateString('en-US', { month: 'long', day: 'numeric', ...zone });
}

/** "Dec 28" */
export function shortDay(ms: number, timeZone?: string): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** The line under the name: the handle, the town, and — on your own — who can see it. */
export function profileSubLine(p: {
  username: string;
  town?: string | undefined;
  isSelf: boolean;
  isPublic?: boolean | undefined;
}): string[] {
  const out = [`@${p.username}`];
  if (p.town) out.push(p.town);
  if (p.isSelf && p.isPublic !== undefined)
    out.push(p.isPublic ? 'Public profile' : 'Private profile');
  return out;
}

/** The trust mark: the class's name, and the raw score only a moderator is sent (D50). */
export function trustMark(
  trustClass: TrustClass | null | undefined,
  points: number | undefined,
): { label: string; points?: number } | null {
  if (!trustClass) return null;
  return points === undefined
    ? { label: TRUST_CLASS_LABELS[trustClass] }
    : { label: TRUST_CLASS_LABELS[trustClass], points };
}

/** "Expires in 5 days", "Expires in 3 hours", "Expiring". */
export function expiresLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Expiring';
  const hours = ms / 3_600_000;
  if (hours < 24) {
    const h = Math.max(1, Math.round(hours));
    return `Expires in ${h} hour${h === 1 ? '' : 's'}`;
  }
  const d = Math.round(hours / 24);
  return `Expires in ${d} day${d === 1 ? '' : 's'}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One of your bounties as `bounties.getDetail` (and `myBounties`' `fulfilledAt`) describe it. */
export interface BountyDetail {
  _id: string;
  status: 'open' | 'fulfilled' | 'expired' | 'canceled';
  createdAt: number;
  expiresAt: number;
  fulfilledAt?: number;
  waterBody: { name: string } | null;
  subArea: { name: string } | null;
  fulfillingReports: {
    _id: string;
    authorName: string;
    skateEndTime: number;
    skateQuality?: SkateQuality;
  }[];
}

export interface OpenBountyCard {
  id: string;
  place: string;
  posted: string;
  meta: string;
  candidates: { id: string; name: string; line: string }[];
}

export interface PastBountyCard {
  id: string;
  place: string;
  status: string;
  /** The person who answered it (fulfilled), or what became of it. */
  answeredBy?: string;
  note?: string;
}

/** A lake gone from the corpus still had a bounty; the card says so rather than nothing. */
const UNLISTED = 'A lake no longer listed';

/**
 * Your bounties, split as the board draws them: the open ones with what's come in, then the past
 * ones, each saying how it ended. Newest first in each.
 */
export function bountyCards(
  details: readonly BountyDetail[],
  now: number,
  timeZone?: string,
): { open: OpenBountyCard[]; past: PastBountyCard[] } {
  const sorted = [...details].sort((a, b) => b.createdAt - a.createdAt);
  const place = (b: BountyDetail) => b.subArea?.name ?? b.waterBody?.name ?? UNLISTED;
  const open = sorted
    .filter((b) => b.status === 'open')
    .map<OpenBountyCard>((b) => ({
      id: b._id,
      place: place(b),
      posted: `Posted ${dayKicker(b.createdAt, now, timeZone).replace(/^(Today|Yesterday)$/, (d) => d.toLowerCase())}`,
      meta: `${expiresLabel(b.expiresAt, now)} · ${plural(b.fulfillingReports.length, 'candidate report')}`,
      candidates: b.fulfillingReports.map((r) => ({
        id: r._id,
        name: r.authorName,
        line: [
          dayKicker(r.skateEndTime, now, timeZone),
          r.skateQuality ? SKATE_QUALITY_LABELS[r.skateQuality] : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    }));
  const past = sorted
    .filter((b) => b.status !== 'open')
    .map<PastBountyCard>((b) => {
      if (b.status === 'fulfilled') {
        const by = b.fulfillingReports[0]?.authorName;
        return {
          id: b._id,
          place: place(b),
          status: b.fulfilledAt ? `Fulfilled · ${shortDay(b.fulfilledAt, timeZone)}` : 'Fulfilled',
          ...(by ? { answeredBy: by } : { note: 'A report answered it' }),
        };
      }
      if (b.status === 'expired') {
        return {
          id: b._id,
          place: place(b),
          status: `Expired · ${shortDay(b.expiresAt, timeZone)}`,
          note: 'No reports came in before it ran out',
        };
      }
      return { id: b._id, place: place(b), status: 'Canceled', note: 'You canceled it' };
    });
  return { open, past };
}
