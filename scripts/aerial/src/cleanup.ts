/**
 * **Cleanup** (B05 §2.5): `run-aerial.sh <campaign> --stage cleanup --old <key>` deletes a
 * superseded archive — its archive, date index and manifest — and that old build's private build
 * prefix (its shards, indexes and records), and nothing else.
 *
 * Its refusals, every one checked before anything is deleted:
 *
 * - **never the newest archive** under its prefix (a production key among the production keys, a
 *   pilot's among its pilot's): the newest is the one being served or about to be;
 * - **never the archive the web points at** (`VITE_NAIP_PMTILES_URL` in any of the local web
 *   checkout's env files Vite reads — `.env.local` as well as `.env` — by name and compared by the
 *   archive's file name, never printed): the local env is the operator's record of what is live —
 *   and when none of those files can be read, nothing is deleted, since what is live can't be told;
 * - **never anything live under a week, counted from when the web began serving its replacement**
 *   (§2.5: *no sooner than a week after the new one is live*), so a cached client or a lagging deploy
 *   still finds its tiles. Publishing is a separate step by hand (`VITE_NAIP_PMTILES_URL` on Vercel,
 *   a redeploy) that nothing in the pipeline records, and an archive can sit uploaded for weeks
 *   before it is published — so its upload time says nothing about how long it has been live. For a
 *   build, then, the replacement must be **the archive the web points at** (a replacement no env
 *   file names has never been live, and cleanup refuses), and the operator states the day it went
 *   live, `--live-since <YYYY-MM-DD | ISO time>`: required, never in the future, never before the
 *   replacement was uploaded, and the week counts from it (from the end of a bare day). A pilot is
 *   never published — its viewer reads its public URL from the moment it is uploaded — so its week
 *   counts from the upload, and `--live-since` is refused for one;
 * - and the `<campaign>` named must be the replacement, newer than `--old`: cleanup is run *from*
 *   the build that superseded it, so the two can't be swapped by a typo.
 *
 * The current build's own shards stay until a later build's cleanup removes them as the old one's:
 * that build's verify already passed, and its URL is the newest.
 */

import {
  archiveKey,
  buildPrefix,
  indexKey,
  manifestKey,
  parseArchiveKey,
  parseCampaign,
  publishPrefix,
} from './keys';

/** One object in a listing of the publish prefix. */
export interface ListedObject {
  /** The bucket key. */
  key: string;
  /** When it was written. */
  modified: Date;
}

export const LIVE_GRACE_DAYS = 7;
const DAY_MS = 86_400_000;

export interface CleanupPlan {
  /** Keys to delete, the published three first. */
  deleteKeys: string[];
  /** The old build's private prefix, deleted whole. */
  deletePrefix: string;
  /** For the report: what replaced it, when it was uploaded, and when the week began. */
  replacedBy: string;
  replacedAt: Date;
  liveFrom: Date;
}

/**
 * When the operator says the replacement went live: `[from, to]`, the instant for an ISO time
 * with an offset (`2027-08-01T18:30:00-04:00`, `…Z`), the whole UTC day for a bare `YYYY-MM-DD` —
 * whose week counts from its end, so a deploy late that day is never shortchanged.
 */
export interface LiveSince {
  from: Date;
  to: Date;
}

const BARE_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Reads `--live-since`; throws a `CleanupRefusal` on anything but a real day or an ISO time. */
export function parseLiveSince(text: string): LiveSince {
  const day = BARE_DAY.exec(text);
  if (day) {
    const from = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== text) {
      refuse(`--live-since ${JSON.stringify(text)} is not a day the calendar has`);
    }
    return { from, to: new Date(from.getTime() + DAY_MS) };
  }
  const at = new Date(text);
  if (!ISO_TIME.test(text) || Number.isNaN(at.getTime())) {
    refuse(
      `--live-since ${JSON.stringify(text)} is not a YYYY-MM-DD day or an ISO time with its offset`,
    );
  }
  return { from: at, to: at };
}

/** A refusal: nothing was deleted. */
export class CleanupRefusal extends Error {
  override name = 'CleanupRefusal';
}

const refuse = (message: string): never => {
  throw new CleanupRefusal(message);
};

/** The old campaign id an archive key belongs to. */
function campaignOf(key: string): { campaign: string; pilot?: string } {
  const read = parseArchiveKey(key);
  return read.pilot === null
    ? { campaign: `naip-${read.date}` }
    : { campaign: `naip-pilot-${read.date}`, pilot: read.pilot };
}

/**
 * The plan, or a refusal. `listing` is every object under `old`'s publish prefix; `liveArchiveUrls`
 * is every value the web's env files give `VITE_NAIP_PMTILES_URL` (`webArchiveUrls`) — empty when
 * none sets it (nothing is live yet), `undefined` when no env file could be read at all, which is
 * refused (the check is never skipped).
 */
export function planCleanup(args: {
  campaign: string;
  pilot: string | null;
  old: string;
  listing: readonly ListedObject[];
  liveArchiveUrls: readonly string[] | undefined;
  /** `--live-since`, read (`parseLiveSince`); `null` when not given. */
  liveSince: LiveSince | null;
  now: Date;
}): CleanupPlan {
  const { campaign, old, listing, now, liveSince } = args;
  const pilot = args.pilot ?? undefined;
  const target = parseArchiveKey(old);
  const current = parseCampaign(campaign);
  if ((target.pilot ?? undefined) !== pilot) {
    refuse(
      `--old ${old} is ${target.pilot === null ? 'a production key' : `pilot ${target.pilot}'s`}, this run is ${pilot === undefined ? 'production' : `pilot ${pilot}`}`,
    );
  }
  const replacement = archiveKey(campaign, pilot);
  if (replacement === old) refuse(`--old is this build's own archive (${old})`);
  if (target.date >= current.date) {
    refuse(
      `--old ${old} is not older than ${campaign}: cleanup runs from the build that replaced it`,
    );
  }

  const prefix = publishPrefix(campaign, pilot);
  const archives = listing
    .filter(
      (o) =>
        o.key.startsWith(prefix) &&
        o.key.slice(prefix.length).match(/^naip-summer-\d{8}\.pmtiles$/),
    )
    .map((o) => ({ ...o, date: parseArchiveKey(o.key).date }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!archives.some((a) => a.key === old))
    refuse(`${old} is not in the bucket: nothing to delete`);
  const newest = archives[archives.length - 1] as (typeof archives)[number];
  if (newest.key === old) refuse(`${old} is the newest archive: it is never deleted`);
  const next = archives.find((a) => a.key === replacement);
  if (next === undefined) refuse(`${replacement}, which replaces it, is not in the bucket`);
  const replacedAt = (next as (typeof archives)[number]).modified;
  if (args.liveArchiveUrls === undefined) {
    refuse(
      `no apps/web env file (${WEB_ENV_FILES.join(', ')}) can be read, so what the web points at (VITE_NAIP_PMTILES_URL) can't be told: run cleanup from a checkout that has one`,
    );
  }
  // By the archive's file name, not its whole key: a public URL may serve the publish prefix at
  // another path (a custom domain), and a false match only refuses.
  const live = args.liveArchiveUrls as readonly string[];
  const named = (key: string) => {
    const name = key.slice(key.lastIndexOf('/') + 1);
    return (url: string) => {
      const path = url.replace(/[?#].*$/, '');
      return path === name || path.endsWith(`/${name}`);
    };
  };
  if (live.some(named(old))) {
    refuse(
      `${old} is the archive the web points at (VITE_NAIP_PMTILES_URL): repoint and redeploy first`,
    );
  }

  // The week, from when the replacement went live.
  let liveFrom: Date;
  if (pilot !== undefined) {
    if (liveSince !== null) {
      refuse(
        '--live-since is for a build: a pilot is live from its upload, and its week counts from that',
      );
    }
    liveFrom = replacedAt;
  } else {
    if (!live.some(named(replacement))) {
      refuse(
        `${replacement} is not the archive the web points at (VITE_NAIP_PMTILES_URL): it has never been live, so ${old} stays — publish the replacement, and clean up a week after`,
      );
    }
    if (liveSince === null) {
      refuse(
        `cleanup needs --live-since <YYYY-MM-DD>: the day the web began serving ${replacement} (its upload, ${replacedAt.toISOString()}, says nothing about when it was published)`,
      );
    }
    const since = liveSince as LiveSince;
    if (since.from.getTime() > now.getTime()) {
      refuse(`--live-since ${since.from.toISOString()} is in the future`);
    }
    // No moment of it at or after the upload (a bare day's end is exclusive).
    const up = replacedAt.getTime();
    if (since.from.getTime() < up && since.to.getTime() <= up) {
      refuse(
        `--live-since ${since.from.toISOString()} is before ${replacement} was uploaded (${replacedAt.toISOString()}): it can't have been live then`,
      );
    }
    liveFrom = new Date(Math.max(since.to.getTime(), replacedAt.getTime()));
  }
  const age = now.getTime() - liveFrom.getTime();
  if (age < LIVE_GRACE_DAYS * DAY_MS) {
    refuse(
      `${replacement} has been live ${(Math.max(0, age) / DAY_MS).toFixed(1)} days (since ${liveFrom.toISOString()}): ${old} stays until it has been live a week`,
    );
  }

  const was = campaignOf(old);
  return {
    deleteKeys: [
      archiveKey(was.campaign, was.pilot),
      indexKey(was.campaign, was.pilot),
      manifestKey(was.campaign, was.pilot),
    ],
    deletePrefix: buildPrefix(was.campaign, was.pilot),
    replacedBy: replacement,
    replacedAt,
    liveFrom,
  };
}

/**
 * Read `VITE_NAIP_PMTILES_URL`'s value out of an env file's text, without printing it: the last
 * assignment wins, quotes and a trailing comment stripped; `null` when unset or blank.
 */
export function envValue(text: string, name: string): string | null {
  let value: string | null = null;
  for (const line of text.split('\n')) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    let v = (m[1] as string).trim();
    if (/^["']/.test(v))
      v = v.slice(
        1,
        v.indexOf(v[0] as string, 1) === -1 ? undefined : v.indexOf(v[0] as string, 1),
      );
    else v = v.replace(/\s+#.*$/, '');
    value = v === '' ? null : v;
  }
  return value;
}

/**
 * The web checkout's env files Vite reads, `.env` first (`vite dev`'s and `vite build`'s modes
 * included): the operator's checkout keeps its URLs in `.env.local`, and a value in any of them may
 * be what the web serves.
 */
export const WEB_ENV_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
] as const;

/**
 * Every value `VITE_NAIP_PMTILES_URL` has in the web's env files (`read` gives a file's text, or
 * `null` when it can't be read); `undefined` when none of them can be — what is live can't be told.
 */
export function webArchiveUrls(read: (file: string) => string | null): string[] | undefined {
  let readAny = false;
  const urls: string[] = [];
  for (const file of WEB_ENV_FILES) {
    const text = read(file);
    if (text === null) continue;
    readAny = true;
    const url = envValue(text, 'VITE_NAIP_PMTILES_URL');
    if (url !== null) urls.push(url);
  }
  return readAny ? urls : undefined;
}
